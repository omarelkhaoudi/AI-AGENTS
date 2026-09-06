import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMvpAgentHierarchy } from "../agents/default-agents.js";
import { createBusinessMemoryRepository } from "../business-memory/repository-factory.js";
import { seedMvpAgents } from "../agents/seed.js";
import { loadFoundationConfig } from "../config.js";
import { PlannerConfigurationError, createPlannerFromConfig } from "../director/planner-factory.js";
import { PlannerContractError, PlanningError } from "../director/planner-contract.js";
import { orchestrateRequest } from "../director/request-orchestration.js";
import { createAuditEvent } from "../observability/audit.js";
import { InMemoryRepository } from "../persistence/in-memory-repository.js";
import { IdempotencyConflictError, assertRepositoryContract } from "../persistence/repository-contract.js";
import { ApprovalStateError } from "../security/approval.js";
import {
  approveApprovalRequest,
  executeApprovedApproval,
  rejectApprovalRequest
} from "../security/approval-flow.js";
import { ToolExecutionService, ToolExecutionServiceError } from "../tools/execution-service.js";
import { authenticatePrincipal, extractBearerToken } from "../security/authentication.js";
import { assertCapability } from "../security/authorization.js";
import { createSecurityConfig } from "../security/security-config.js";
import { createApiTokenMaterial, hashApiTokenSecret } from "../security/api-token.js";
import { HkidsDocumentService, normalizeDocumentError } from "../documents/document-service.js";

// The one outbound tool. It is never routed by a planner, so the only way to
// raise it is the dedicated endpoint below, and the only way to send it is a
// human approval.
const DELAY_ALERT_TOOL_ID = "notify_delay_alert";
const PRODUCT_DATASHEET_TOOL_ID = "get_product_datasheet";
const DATASHEET_QUOTE_TOOL_ID = "prepare_quote_from_datasheet";

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend");
const FRONTEND_ASSETS = Object.freeze({
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" }
});

export function buildApi({
  repository = new InMemoryRepository(),
  logger = false,
  seedAgents = true,
  planner = null,
  config = null,
  toolRegistry = null,
  security = null,
  businessMemory = null,
  documentService = null,
  documentOutputDir = null,
  // A seam, not a feature: the derived idempotency key names a day, and a test
  // cannot cross a day boundary by waiting for one.
  clock = () => new Date()
} = {}) {
  assertRepositoryContract(repository);
  const foundationConfig = config ?? loadFoundationConfig();
  const selectedPlanner = planner ?? createPlannerFromConfig(foundationConfig.planner);
  // Same factory as the tools: BUSINESS_MEMORY_PROVIDER moves the reports and
  // the customer directory to PostgreSQL together, never one without the other.
  const directoryMemory = businessMemory ?? createBusinessMemoryRepository();
  const securityConfig = security ?? foundationConfig.security ?? createSecurityConfig();
  const hkidsDocuments = documentService ?? new HkidsDocumentService({ repository, outputDir: documentOutputDir });

  const app = Fastify({ logger, bodyLimit: securityConfig.bodyLimitBytes });
  let seedPromise = null;
  let demoSessionPromise = null;

  // C1 - Edge. The limiter is global and runs BEFORE authentication, so an
  // anonymous flood is capped instead of reaching the credential lookup. It
  // keys on the presented credential rather than on the resolved principal,
  // because the principal does not exist yet at this point.
  const auditedRateLimitKeys = new Map();
  app.register(rateLimit, {
    global: false,
    max: (request) => rateLimitForRoute(securityConfig, request).max,
    timeWindow: securityConfig.rateLimits.read.timeWindow,
    keyGenerator: rateLimitKey,
    onExceeded: async (request, key) => {
      // One audit row per key and per window: auditing every rejected request
      // would turn the limiter itself into an amplification vector.
      if (!shouldAuditRateLimit(auditedRateLimitKeys, key, securityConfig.rateLimits.read.timeWindow)) {
        return;
      }
      await auditSecurityEvent(repository, {
        type: "rate_limit_exceeded",
        actorUserId: request.principal?.userId ?? null,
        resourceType: "endpoint",
        resourceId: routeIdentifier(request),
        metadata: { method: request.method }
      });
    }
  });

  app.addHook("onClose", async () => {
    await repository.disconnect();
  });

  // Authentication and authorization hooks are added after the limiter has
  // loaded, so the limiter runs first and caps anonymous traffic before any
  // credential lookup happens.
  app.after(() => {
    // The plugin only attaches its limiters through onRoute, and route-level
    // hooks run after global ones. Its own hook factory is used here so the
    // limiter is a global hook placed BEFORE authentication: an anonymous
    // flood is capped without ever reaching a credential lookup.
    app.addHook("onRequest", app.rateLimit());

    // C2 - Authentication. Deny by default: every /api route requires a valid
    // bearer token unless it is explicitly listed as public.
    app.addHook("onRequest", async (request, reply) => {
      if (!isApiRoute(request) || isPublicApiRoute(request)) {
        return;
      }

      try {
        request.principal = await authenticatePrincipal({
          repository,
          authorizationHeader: request.headers.authorization
        });
      } catch (error) {
        await auditSecurityEvent(repository, {
          type: "authentication_failed",
          resourceType: "endpoint",
          resourceId: routeIdentifier(request),
          metadata: { method: request.method, code: error.code ?? "AUTHENTICATION_REQUIRED" }
        });
        return reply.code(401).send({
          error: "Authentication required.",
          details: { code: error.code ?? "AUTHENTICATION_REQUIRED" }
        });
      }
    });

    // C3 - User authorization. A route that declares no capability is refused
    // rather than silently exposed.
    app.addHook("preHandler", async (request, reply) => {
      if (!isApiRoute(request) || isPublicApiRoute(request)) {
        return;
      }

      const capability = request.routeOptions?.config?.capability ?? null;
      if (!capability) {
        await auditSecurityEvent(repository, {
          type: "authorization_denied",
          actorUserId: request.principal?.userId ?? null,
          resourceType: "endpoint",
          resourceId: routeIdentifier(request),
          metadata: { code: "AUTHORIZATION_MISCONFIGURED" }
        });
        return reply.code(500).send({
          error: "Endpoint is not authorized.",
          details: { code: "AUTHORIZATION_MISCONFIGURED" }
        });
      }

      try {
        assertCapability(request.principal, capability);
      } catch (error) {
        await auditSecurityEvent(repository, {
          type: "authorization_denied",
          actorUserId: request.principal?.userId ?? null,
          resourceType: "endpoint",
          resourceId: routeIdentifier(request),
          metadata: { code: error.code ?? "AUTHORIZATION_DENIED", capability }
        });
        return reply.code(403).send({
          error: "Authorization denied.",
          details: { code: error.code ?? "AUTHORIZATION_DENIED", capability }
        });
      }
    });

    if (securityConfig.demoModeEnabled) {
      // Demo mode automates token DISTRIBUTION only. Verification is never
      // bypassed: the cockpit still authenticates with a real stored token.
      app.get("/api/auth/demo-session", async (_request, reply) => {
        try {
          const session = await runDemoSessionOnce({
            repository,
            getDemoSessionPromise: () => demoSessionPromise,
            setDemoSessionPromise: (promise) => {
              demoSessionPromise = promise;
            }
          });
          return { token: session.token, user: session.user };
        } catch (error) {
          return reply.code(500).send(createErrorResponse("Demo session provisioning failed.", error));
        }
      });
    }

    // Routes are declared after the rate limiter has loaded, so its per-route
    // onRoute hook can attach a limiter to each of them.
  });

  app.after(() => {
    app.get("/health", async () => ({
      status: "ok",
      service: "ai-agents",
      timestamp: new Date().toISOString()
    }));

    app.get("/", async (_request, reply) => serveFrontendAsset(reply, "/"));
    app.get("/app/", async (_request, reply) => serveFrontendAsset(reply, "/app/"));
    app.get("/app/app.js", async (_request, reply) => serveFrontendAsset(reply, "/app/app.js"));
    app.get("/app/styles.css", async (_request, reply) => serveFrontendAsset(reply, "/app/styles.css"));

    app.get("/api/approvals", readRouteOptions(), async (request, reply) => {
      try {
        const approvals = await repository.listPendingApprovals({
          requestId: typeof request.query?.requestId === "string" ? request.query.requestId : undefined,
          planStepId: typeof request.query?.planStepId === "string" ? request.query.planStepId : undefined
        });
        return { approvals };
      } catch (error) {
        return sendDomainError(reply, "Approval listing failed.", error);
      }
    });

    app.get("/api/approvals/:id", readRouteOptions(), async (request, reply) => {
      try {
        const approval = await repository.getApproval(request.params.id);
        if (!approval) {
          return reply.code(404).send({
            error: "Approval not found.",
            details: { code: "APPROVAL_NOT_FOUND" }
          });
        }
        return { approval };
      } catch (error) {
        return sendDomainError(reply, "Approval retrieval failed.", error);
      }
    });

    app.post("/api/approvals/:id/approve", decisionRouteOptions(), async (request, reply) => {
      try {
        const decision = normalizeApprovalDecisionBody(request.body);
        if (!decision.ok) {
          return reply.code(400).send({ error: decision.error, details: { code: "IDENTITY_NOT_ACCEPTED_FROM_BODY" } });
        }
        const approval = await approveApprovalRequest({
          repository,
          approvalId: request.params.id,
          approverId: request.principal.userId,
          decisionReason: decision.value.decisionReason
        });
        const execution = await executeApprovedApproval({
          repository,
          approval,
          toolRegistry
        });
        const savedApproval = await repository.getApproval(approval.id);
        return { approval: savedApproval, execution };
      } catch (error) {
        return sendDomainError(reply, "Approval approval failed.", error);
      }
    });

    app.post("/api/approvals/:id/reject", decisionRouteOptions(), async (request, reply) => {
      try {
        const decision = normalizeApprovalDecisionBody(request.body);
        if (!decision.ok) {
          return reply.code(400).send({ error: decision.error, details: { code: "IDENTITY_NOT_ACCEPTED_FROM_BODY" } });
        }
        const approval = await rejectApprovalRequest({
          repository,
          approvalId: request.params.id,
          approverId: request.principal.userId,
          decisionReason: decision.value.decisionReason
        });
        return { approval };
      } catch (error) {
        return sendDomainError(reply, "Approval rejection failed.", error);
      }
    });

    app.post("/api/requests", writeRouteOptions(), async (request, reply) => {
      const validation = normalizeRequestBody(request.body);
      if (!validation.ok) {
        return reply.code(400).send({ error: validation.error });
      }

      try {
        const orchestratedRequest = await createAndOrchestrateRequest({
          request: { ...validation.value, createdById: request.principal.userId },
          repository,
          planner: selectedPlanner,
          toolRegistry,
          seedAgents,
          getSeedPromise: () => seedPromise,
          setSeedPromise: (promise) => {
            seedPromise = promise;
          }
        });

        return reply.code(201).send({ request: orchestratedRequest });
      } catch (error) {
        return sendDomainError(reply, "Request orchestration failed.", error);
      }
    });

    app.post("/api/director/requests", writeRouteOptions(), async (request, reply) => {
      const validation = normalizeRequestBody(request.body);
      if (!validation.ok) {
        return reply.code(400).send({ error: validation.error });
      }

      try {
        const orchestratedRequest = await createAndOrchestrateRequest({
          request: {
            ...validation.value,
            createdById: request.principal.userId,
            source: "director_demo"
          },
          repository,
          planner: selectedPlanner,
          toolRegistry,
          seedAgents,
          getSeedPromise: () => seedPromise,
          setSeedPromise: (promise) => {
            seedPromise = promise;
          }
        });

        const directory = await createBusinessDirectory(directoryMemory);
        return reply.code(201).send(createDirectorDemoResponse(orchestratedRequest, directory));
      } catch (error) {
        return sendDomainError(reply, "Director request failed.", error);
      }
    });

    // Raising a delay alert is not a planning decision, so it does not go through
    // a planner: this endpoint writes the request, the plan and the one step
    // itself, then lets ToolExecutionService open the approval. Nothing is sent
    // here. The alert leaves only when a human approves it, through the existing
    // POST /api/approvals/:id/approve, which is untouched by this commit.
    // The quote a person asks for from a datasheet. It takes a business input,
    // which is why it is a route of its own: the Director builds a fixed input
    // for every step it plans, so a reference, a customer and a quantity have no
    // way through it. Same shape as the delay alert route below, and the same
    // service, permissions and approval underneath.
    //
    // No idempotency key, unlike the delay alert. Two identical quote requests
    // are two real commercial requests; two identical delay alerts are a repeat.
    app.post("/api/quotes/datasheet", writeRouteOptions(), async (request, reply) => {
      const validation = normalizeDatasheetQuoteBody(request.body);
      if (!validation.ok) {
        return reply.code(400).send({ error: validation.error, details: { code: "INVALID_INPUT" } });
      }

      try {
        if (seedAgents) {
          await runSeedOnce({
            repository,
            getSeedPromise: () => seedPromise,
            setSeedPromise: (promise) => {
              seedPromise = promise;
            }
          });
        }

        const prepared = await prepareDatasheetQuoteApproval({
          repository,
          toolRegistry,
          createdById: request.principal.userId,
          input: validation.value
        });

        // 202 when a person now has something to decide, 200 when the data could
        // not answer and nothing was opened for anyone.
        return reply
          .code(prepared.status === "approval_required" ? 202 : 200)
          .send(prepared);
      } catch (error) {
        return sendDomainError(reply, "Quote preparation failed.", error);
      }
    });

    app.post("/api/production/delay-alerts", writeRouteOptions(), async (request, reply) => {
      const validation = normalizeDelayAlertBody(request.body);
      if (!validation.ok) {
        return reply.code(400).send({ error: validation.error, details: { code: "INVALID_INPUT" } });
      }

      // The bridge is judged by what is actually reachable, not by a flag. The
      // tool exists only when a client was injected at startup, so its absence is
      // the honest answer to "can this application send anything at all".
      if (!toolRegistry?.get(DELAY_ALERT_TOOL_ID)) {
        return reply.code(409).send({
          error: "The workflow bridge is not enabled.",
          details: {
            code: "WORKFLOW_NOT_ENABLED",
            provider: foundationConfig.workflow?.provider ?? null,
            enabled: foundationConfig.workflow?.enabled ?? false
          }
        });
      }

      try {
        if (seedAgents) {
          await runSeedOnce({
            repository,
            getSeedPromise: () => seedPromise,
            setSeedPromise: (promise) => {
              seedPromise = promise;
            }
          });
        }

        const idempotencyKey = derivedDelayAlertKey({
          orderId: validation.value.orderId,
          delayRisk: validation.value.delayRisk,
          now: clock()
        });

        const prepared = await prepareDelayAlertApproval({
          repository,
          toolRegistry,
          createdById: request.principal.userId,
          orderId: validation.value.orderId,
          delayRisk: validation.value.delayRisk,
          idempotencyKey
        });

        return reply.code(202).send(prepared);
      } catch (error) {
        // The business event already exists. Answering 200 is what makes a retry
        // safe; what the body must never do is claim that anything new happened.
        if (error instanceof IdempotencyConflictError) {
          return reply.code(200).send(await reportDuplicateDelayAlert({
            repository,
            error,
            actorUserId: request.principal.userId,
            orderId: validation.value.orderId,
            delayRisk: validation.value.delayRisk
          }));
        }
        return sendDomainError(reply, "Delay alert preparation failed.", error);
      }
    });

    app.post("/api/documents/preview", writeRouteOptions(), async (request, reply) => {
      try {
        return reply.code(200).send(await hkidsDocuments.preview(request.body));
      } catch (error) {
        const normalized = normalizeDocumentError(error);
        if (normalized) {
          return reply.code(normalized.statusCode).send(normalized.body);
        }
        return sendDomainError(reply, "Document preview failed.", error);
      }
    });

    app.post("/api/documents/generate", writeRouteOptions(), async (request, reply) => {
      try {
        return reply.code(201).send(await hkidsDocuments.generate(request.body, {
          createdById: request.principal.userId
        }));
      } catch (error) {
        const normalized = normalizeDocumentError(error);
        if (normalized) {
          return reply.code(normalized.statusCode).send(normalized.body);
        }
        return sendDomainError(reply, "Document generation failed.", error);
      }
    });

    app.get("/api/documents/:id/download", readRouteOptions(), async (request, reply) => {
      try {
        const download = await hkidsDocuments.download(request.params.id);
        const name = download.metadata.name ?? "document";
        return reply
          .type(download.metadata.mimeType ?? "application/octet-stream")
          .header("Content-Disposition", `attachment; filename="${basenameForHeader(name)}"`)
          .send(download.bytes);
      } catch (error) {
        const normalized = normalizeDocumentError(error);
        if (normalized) {
          return reply.code(normalized.statusCode).send(normalized.body);
        }
        return sendDomainError(reply, "Document download failed.", error);
      }
    });

    app.get("/api/requests/:id", readRouteOptions(), async (request, reply) => {
      try {
        const savedRequest = await repository.getRequest(request.params.id);
        if (!savedRequest) {
          return reply.code(404).send({ error: "Request not found." });
        }

        return { request: savedRequest };
      } catch (error) {
        return reply.code(500).send(createErrorResponse("Request retrieval failed.", error));
      }
    });

  });

  return app;
}

const PUBLIC_API_ROUTES = Object.freeze(["/api/auth/demo-session"]);
export const DEMO_USER_ID = "demo-leader";

// Rate limiting runs before authentication, so it keys on the credential that
// was presented rather than on a resolved principal. The token HASH is used,
// never the secret itself, so the limiter store holds nothing sensitive.
function rateLimitKey(request) {
  const authorization = request.headers?.authorization;
  if (typeof authorization === "string" && authorization.trim().length > 0) {
    try {
      return `credential:${hashApiTokenSecret(extractBearerToken(authorization))}:${rateLimitBucket(request)}`;
    } catch {
      // A malformed credential is not an identity: fall back to the peer.
    }
  }
  return `peer:${request.ip}:${rateLimitBucket(request)}`;
}

// Buckets are per route, so a read burst cannot consume the approval budget.
// Unrouted paths share a single bucket: a flood of random URLs must not be
// able to allocate unbounded limiter state.
function rateLimitBucket(request) {
  return request.routeOptions?.url ?? "unrouted";
}

function rateLimitForRoute(securityConfig, request) {
  const capability = request.routeOptions?.config?.capability ?? null;
  if (capability === "decide_approvals") {
    return securityConfig.rateLimits.decision;
  }
  if (capability === "create_requests") {
    return securityConfig.rateLimits.write;
  }
  return securityConfig.rateLimits.read;
}

function shouldAuditRateLimit(auditedKeys, key, timeWindow) {
  const now = Date.now();
  const lastAudited = auditedKeys.get(key);
  if (lastAudited !== undefined && now - lastAudited < timeWindow) {
    return false;
  }

  for (const [auditedKey, auditedAt] of auditedKeys) {
    if (now - auditedAt >= timeWindow) {
      auditedKeys.delete(auditedKey);
    }
  }
  auditedKeys.set(key, now);
  return true;
}

function routeIdentifier(request) {
  return request.routeOptions?.url ?? request.url;
}

function isApiRoute(request) {
  return routeIdentifier(request).startsWith("/api/");
}

function isPublicApiRoute(request) {
  return PUBLIC_API_ROUTES.includes(routeIdentifier(request));
}

function readRouteOptions() {
  return {
    config: {
      capability: "read_requests"
    }
  };
}

function writeRouteOptions() {
  return {
    config: {
      capability: "create_requests"
    }
  };
}

function decisionRouteOptions() {
  return {
    config: {
      capability: "decide_approvals"
    }
  };
}

// Security auditing must never break the response it describes.
async function auditSecurityEvent(repository, event) {
  try {
    return await repository.createAuditEvent(createAuditEvent(event));
  } catch {
    return null;
  }
}

// Mirrors the seed memoization: shared while pending, discarded on failure so a
// transient error does not permanently disable the demo cockpit.
async function runDemoSessionOnce({ repository, getDemoSessionPromise, setDemoSessionPromise }) {
  const existing = getDemoSessionPromise();
  if (existing) {
    return existing;
  }

  const promise = provisionDemoSession(repository).catch((error) => {
    if (getDemoSessionPromise() === promise) {
      setDemoSessionPromise(null);
    }
    throw error;
  });

  setDemoSessionPromise(promise);
  return promise;
}

async function provisionDemoSession(repository) {
  const user = await repository.upsertUser({
    id: DEMO_USER_ID,
    name: "Demo Leader",
    role: "leader",
    status: "active",
    metadata: { demo: true }
  });
  const material = createApiTokenMaterial({ userId: user.id, name: "demo-cockpit" });
  await repository.createApiToken(material.record);

  return Object.freeze({
    token: material.secret,
    user: Object.freeze({ id: user.id, name: user.name, role: user.role })
  });
}

async function serveFrontendAsset(reply, route) {
  const asset = FRONTEND_ASSETS[route];
  if (!asset) {
    return reply.code(404).send({ error: "Frontend asset not found." });
  }

  try {
    const content = await readFile(join(FRONTEND_DIR, asset.file), "utf8");
    return reply.type(asset.type).send(content);
  } catch (error) {
    return reply.code(500).send(createErrorResponse("Frontend asset loading failed.", error));
  }
}

async function createAndOrchestrateRequest({
  request,
  repository,
  planner,
  toolRegistry,
  seedAgents,
  getSeedPromise,
  setSeedPromise
}) {
  if (seedAgents) {
    await runSeedOnce({ repository, getSeedPromise, setSeedPromise });
  }

  const savedRequest = await repository.createRequest(request);
  await repository.createAuditEvent(
    createAuditEvent({
      type: "request_created",
      actorUserId: savedRequest.createdById,
      requestId: savedRequest.id,
      resourceType: "request",
      resourceId: savedRequest.id,
      metadata: {
        source: savedRequest.source,
        title: savedRequest.title
      }
    })
  );

  return orchestrateRequest({
    requestId: savedRequest.id,
    repository,
    planner,
    toolRegistry
  });
}

// The seed promise is shared while it is pending so concurrent requests seed
// only once, and it is discarded when it fails so the next request can retry.
// The business identity of a delay alert, as decided with the client: the same
// order, at the same risk level, on the same day is the same event. A risk that
// moves is a new event, because a leader who was told "at risk" has not been
// told "critical".
//
// The day is the UTC day, which is the business day this application already
// uses everywhere: demoDate anchors on setUTCHours(0, 0, 0, 0) and the whole
// lateness model is measured against it. Using a local day here would silently
// introduce a second calendar.
export function derivedDelayAlertKey({ orderId, delayRisk, now = new Date() }) {
  const day = new Date(now.getTime());
  day.setUTCHours(0, 0, 0, 0);
  return `delay_alert:${orderId}:${delayRisk}:${day.toISOString().slice(0, 10)}`;
}

// What a duplicate is told. Every field describes the ORIGINAL request: the
// approval it is still waiting on, or the execution it already produced. No
// approval and no execution are created here, and nothing is sent.
async function reportDuplicateDelayAlert({ repository, error, actorUserId, orderId, delayRisk }) {
  const original = error.details?.request ?? null;
  const approval = original?.approvals?.[0] ?? null;
  const execution = original?.executions?.find((entry) => entry.status === "completed")
    ?? original?.executions?.[0]
    ?? null;

  // Audited against the original request, because that is the only request
  // there is. A duplicate leaves no row, so a row must not be invented to
  // carry its audit.
  if (original) {
    await repository.createAuditEvent(createAuditEvent({
      type: "request_duplicate_skipped",
      actorUserId,
      agentId: "production",
      requestId: original.id,
      resourceType: "request",
      resourceId: original.id,
      metadata: {
        idempotencyKey: error.details?.idempotencyKey ?? null,
        eventType: "delay_alert",
        orderId,
        delayRisk,
        originalRequestId: original.id,
        originalRequestStatus: original.status,
        approvalId: approval?.id ?? null,
        approvalStatus: approval?.status ?? null,
        executionId: execution?.id ?? null,
        executionStatus: execution?.status ?? null
      }
    }));
  }

  return {
    status: "duplicate_skipped",
    idempotencyKey: error.details?.idempotencyKey ?? null,
    duplicateOf: original?.id ?? null,
    request: original ? { id: original.id, status: original.status } : null,
    approval: approval
      ? { id: approval.id, status: approval.status, decisionReason: approval.decisionReason ?? null }
      : null,
    execution: execution ? { id: execution.id, status: execution.status } : null
  };
}

// Builds the minimum an approval needs to be executable later: a request, a
// plan, and one step carrying the workflow inputs. executeApprovedApproval reads
// its input from the plan step, so orderId and delayRisk have to live there or
// they never reach n8n.
async function prepareDelayAlertApproval({
  repository,
  toolRegistry,
  createdById,
  orderId,
  delayRisk,
  idempotencyKey = null
}) {
  // This insert is the reservation, and it is the first thing that happens. A
  // duplicate therefore throws here, before a plan, a step, an approval or an
  // execution exists, and leaves none of them behind.
  const savedRequest = await repository.createRequest({
    title: `Delay alert for order ${orderId}`,
    source: "delay_alert",
    status: "received",
    payload: { orderId, delayRisk },
    createdById,
    idempotencyKey
  });

  await repository.createAuditEvent(
    createAuditEvent({
      type: "request_created",
      actorUserId: createdById,
      requestId: savedRequest.id,
      resourceType: "request",
      resourceId: savedRequest.id,
      metadata: { source: savedRequest.source, orderId, delayRisk }
    })
  );

  const plan = await repository.createPlan({
    requestId: savedRequest.id,
    createdByAgentId: "production",
    status: "created",
    summary: "Raise a production delay alert for human approval.",
    metadata: { planner: "none", trigger: "delay_alert_endpoint" }
  });

  const planStep = await repository.createPlanStep({
    planId: plan.id,
    agentId: "production",
    sequence: 1,
    status: "created",
    actionType: DELAY_ALERT_TOOL_ID,
    toolName: DELAY_ALERT_TOOL_ID,
    input: { requestId: savedRequest.id, orderId, delayRisk },
    requiresApproval: true
  });

  const agent = await repository.getAgent("production");
  const service = new ToolExecutionService({ repository, toolRegistry });

  try {
    await service.execute({
      agentId: "production",
      agentPermissions: agent?.permissions ?? [],
      toolId: DELAY_ALERT_TOOL_ID,
      input: planStep.input,
      requestId: savedRequest.id,
      planId: plan.id,
      planStepId: planStep.id,
      metadata: { trigger: "delay_alert_endpoint", toolName: DELAY_ALERT_TOOL_ID }
    });
  } catch (cause) {
    if (cause instanceof ToolExecutionServiceError && cause.code === "APPROVAL_REQUIRED") {
      return {
        status: "approval_required",
        request: { id: savedRequest.id },
        planStep: { id: planStep.id },
        approval: cause.details.approval
      };
    }
    throw cause;
  }

  // Unreachable by design: the tool requires execute_action, and requiresApproval
  // in ToolExecutionService opens an approval for every non read_analyze tool. If
  // that ever stops holding, an alert has already been sent without a human, and
  // saying so loudly is better than reporting success.
  throw new ToolExecutionServiceError(
    "The delay alert ran without a human approval.",
    "APPROVAL_NOT_ENFORCED",
    { toolId: DELAY_ALERT_TOOL_ID, requestId: savedRequest.id }
  );
}

function normalizeDatasheetQuoteBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object." };
  }

  // Identity is never taken from the request body.
  if (body.createdById !== undefined) {
    return { ok: false, error: "createdById is not accepted: the authenticated principal is the author." };
  }

  const productReference = normalizeText(body.productReference);
  const customerId = normalizeText(body.customerId);
  // Number(null) and Number("") are both 0, so the value is judged after the
  // conversion, not before it: a quantity of zero is not a quantity.
  const quantity = Number(body.quantity);

  if (!productReference) {
    return { ok: false, error: "productReference is required." };
  }
  if (!customerId) {
    return { ok: false, error: "customerId is required." };
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, error: "quantity must be a positive number." };
  }

  return { ok: true, value: { productReference, customerId, quantity } };
}

// Same sequence as prepareDelayAlertApproval below, for the same reason: the
// request, the audit event, the plan and the step exist before anything runs, so
// what a person is asked to approve is traceable to what was asked for.
//
// The datasheet is read first, with read_analyze. That is what lets the answer
// carry the product, the picture reference and the price even when the quote
// refuses: a reader sees why it refused, not only that it did.
async function prepareDatasheetQuoteApproval({ repository, toolRegistry, createdById, input }) {
  const savedRequest = await repository.createRequest({
    title: `Quote for ${input.productReference}`,
    source: "datasheet_quote",
    status: "received",
    payload: { ...input },
    createdById
  });

  await repository.createAuditEvent(
    createAuditEvent({
      type: "request_created",
      actorUserId: createdById,
      requestId: savedRequest.id,
      resourceType: "request",
      resourceId: savedRequest.id,
      metadata: { source: savedRequest.source, productReference: input.productReference }
    })
  );

  const plan = await repository.createPlan({
    requestId: savedRequest.id,
    createdByAgentId: "commercial",
    status: "created",
    summary: "Prepare a quote from a product datasheet for human approval.",
    metadata: { planner: "none", trigger: "datasheet_quote_endpoint" }
  });

  const toolInput = { requestId: savedRequest.id, ...input };

  const planStep = await repository.createPlanStep({
    planId: plan.id,
    agentId: "commercial",
    sequence: 1,
    status: "created",
    actionType: DATASHEET_QUOTE_TOOL_ID,
    toolName: DATASHEET_QUOTE_TOOL_ID,
    input: toolInput,
    requiresApproval: true
  });

  const agent = await repository.getAgent("commercial");
  const agentPermissions = agent?.permissions ?? [];
  const service = new ToolExecutionService({ repository, toolRegistry });

  const read = await service.execute({
    agentId: "commercial",
    agentPermissions,
    toolId: PRODUCT_DATASHEET_TOOL_ID,
    input: toolInput,
    requestId: savedRequest.id,
    planId: plan.id,
    metadata: { trigger: "datasheet_quote_endpoint", toolName: PRODUCT_DATASHEET_TOOL_ID }
  });
  const datasheet = read.output.result.summary;

  // A datasheet that cannot answer stops here. Opening an approval for a quote
  // that could never be built would ask a person to decide on nothing.
  if (datasheet.issues.length > 0) {
    return {
      status: "refused",
      request: { id: savedRequest.id },
      planStep: { id: planStep.id },
      datasheet
    };
  }

  try {
    await service.execute({
      agentId: "commercial",
      agentPermissions,
      toolId: DATASHEET_QUOTE_TOOL_ID,
      input: toolInput,
      requestId: savedRequest.id,
      planId: plan.id,
      planStepId: planStep.id,
      metadata: { trigger: "datasheet_quote_endpoint", toolName: DATASHEET_QUOTE_TOOL_ID }
    });
  } catch (cause) {
    if (cause instanceof ToolExecutionServiceError && cause.code === "APPROVAL_REQUIRED") {
      return {
        status: "approval_required",
        request: { id: savedRequest.id },
        planStep: { id: planStep.id },
        datasheet,
        approval: cause.details.approval
      };
    }
    throw cause;
  }

  // Unreachable by design: the tool requires prepare_action, and requiresApproval
  // in ToolExecutionService opens an approval for every non read_analyze tool. If
  // that ever stops holding, a quote has been prepared without a human, and
  // saying so loudly is better than reporting success.
  throw new ToolExecutionServiceError(
    "The quote was prepared without a human approval.",
    "APPROVAL_NOT_ENFORCED",
    { toolId: DATASHEET_QUOTE_TOOL_ID, requestId: savedRequest.id }
  );
}

function normalizeDelayAlertBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object." };
  }

  if (body.createdById !== undefined) {
    return { ok: false, error: "createdById is not accepted: the authenticated principal is the author." };
  }

  const orderId = normalizeText(body.orderId);
  const delayRisk = normalizeText(body.delayRisk);
  if (!orderId) {
    return { ok: false, error: "orderId is required." };
  }
  if (!delayRisk) {
    return { ok: false, error: "delayRisk is required." };
  }

  return { ok: true, value: { orderId, delayRisk } };
}

async function runSeedOnce({ repository, getSeedPromise, setSeedPromise }) {
  const existingSeed = getSeedPromise();
  if (existingSeed) {
    return existingSeed;
  }

  const seedPromise = seedMvpAgents(repository).catch((error) => {
    if (getSeedPromise() === seedPromise) {
      setSeedPromise(null);
    }
    throw error;
  });

  setSeedPromise(seedPromise);
  return seedPromise;
}

function createDirectorDemoResponse(request, directory = EMPTY_BUSINESS_DIRECTORY) {
  const agentResults = createAgentResults(request);
  const completedCount = agentResults.filter((result) => result.status === "completed").length;
  const expectedCount = request.plans?.[0]?.steps?.length ?? agentResults.length;
  const decisionsRequired = createDecisionsRequired(request, agentResults, directory);
  const status = decisionsRequired.length > 0
    ? decisionsRequired.some((decision) => decision.type === "approval") ? "requires_approval" : null
    : null;
  const finalStatus = status ??
    (completedCount === expectedCount
      ? "completed"
      : "partial");

  const summary = createDemoSummary({
    status: finalStatus,
    completedCount,
    expectedCount,
    agentResults,
    decisionsRequired,
    directory
  });

  return Object.freeze({
    requestId: request.id,
    status: finalStatus,
    message: request.payload?.message ?? request.title,
    summary,
    hierarchy: createDirectorHierarchy(agentResults),
    agents: createDemoAgentList(agentResults),
    findings: createDemoFindings(agentResults),
    results: agentResults,
    decisionsRequired,
    audit: summarizeAuditEvents(request.auditEvents ?? [])
  });
}

// One entry per agent, not per step. An agent contributing several steps is
// listed once and carries the tools it ran, in plan order: this list names the
// organisation that answered, so a repeated agent would overstate it.
function createDemoAgentList(agentResults) {
  const byAgent = new Map();

  for (const result of agentResults) {
    const existing = byAgent.get(result.agent);
    if (existing) {
      existing.tools.push(result.tool);
      // An agent is only complete when every one of its steps completed.
      if (result.status !== "completed") {
        existing.status = result.status;
      }
      continue;
    }
    byAgent.set(result.agent, {
      id: result.agent,
      tools: [result.tool],
      status: result.status,
      supervisorAgentId: result.supervisorAgentId,
      supervisedAgentIds: result.supervisedAgentIds
    });
  }

  return [
    Object.freeze({
      id: "director",
      tools: Object.freeze([]),
      status: agentResults.some((result) => result.status !== "completed") ? "partial" : "completed"
    }),
    ...[...byAgent.values()].map((entry) => Object.freeze({
      ...entry,
      tools: Object.freeze(entry.tools)
    }))
  ];
}

// Presentation domain of each tool, used to group results into the Director
// sections. Exported so a structural test can verify that no registered tool is
// left without one.
export const BUSINESS_DOMAIN_BY_TOOL = Object.freeze({
  get_pending_payments: "payments",
  get_pending_quotes: "quotes",
  get_delayed_production_orders: "production",
  get_purchase_needs: "purchase_needs",
  get_after_sales_overview: "after_sales_tickets",
  get_hr_overview: "hr_demo_overview",
  prepare_hr_sensitive_decision: "hr_demo_overview",
  get_marketing_overview: "marketing_demo_overview",
  get_community_overview: "community_demo_overview",
  get_legal_overview: "legal_demo_overview",
  prepare_legal_sensitive_decision: "legal_demo_overview",
  // Lot 2B.1 read tools.
  get_company_overview: "company_overview",
  get_customer_overview: "customers",
  get_customer_orders: "orders",
  // Neither is routed by the Director, so neither ever reaches a heading.
  // The presentation domain is declared all the same: a tool without one is
  // reported as a drift by the registry.
  get_product_datasheet: "products",
  prepare_quote_from_datasheet: "products",
  // Same presentation domain as the list tool it stands beside. Only one of
  // the two is routed, so the aggregate can only come from this one.
  get_order_book_summary: "orders",
  get_overdue_invoices: "invoices",
  get_supplier_catalog: "suppliers",
  // Lot 2B.2 computing tools. A tool reading several business domains reports
  // the presentation domain of the section it feeds, so receivables land in
  // A ENCAISSER and material requirements in A COMMANDER.
  get_receivables_summary: "payments",
  // CDC section 29 counts revenue, collections and receivables separately, so
  // this reports the invoices domain rather than payments: the figure belongs
  // beside what was invoiced, not beside what is expected in cash.
  get_revenue_summary: "invoices",
  get_quote_follow_ups: "quotes",
  get_production_schedule: "production",
  get_material_requirements: "purchase_needs",
  // Already routed for sensitive payment requests, but reported no domain.
  execute_invoice_payment: "payments"
});

function createAgentResults(request) {
  const executionsByStep = new Map((request.executions ?? []).map((execution) => [execution.planStepId, execution]));
  return (request.plans?.[0]?.steps ?? []).map((step) => {
    const execution = executionsByStep.get(step.id);
    const result = execution?.output?.result ?? null;
    return Object.freeze({
      agent: step.agentId,
      tool: step.toolName,
      domain: BUSINESS_DOMAIN_BY_TOOL[step.toolName] ?? null,
      dataSource: result?.dataSource ?? null,
      sourceProvider: result?.sourceProvider ?? null,
      sourceId: result?.sourceId ?? null,
      supervisorAgentId: step.agent?.metadata?.supervisorAgentId ?? null,
      supervisedAgentIds: step.agent?.metadata?.supervisedAgentIds ?? [],
      delegatedByAgentId: step.input?.delegatedByAgentId ?? null,
      reportsToAgentId: step.input?.reportsToAgentId ?? step.agent?.metadata?.supervisorAgentId ?? null,
      status: execution?.status ?? "not_executed",
      result,
      error: execution?.error
        ? {
            name: execution.error.name,
            code: execution.error.code,
            message: execution.error.message
          }
        : null
    });
  });
}

function createDirectorHierarchy(agentResults) {
  const activeAgentIds = new Set(["director", ...agentResults.map((result) => result.agent)]);
  return createMvpAgentHierarchy()
    .filter((entry) => activeAgentIds.has(entry.agentId))
    .map((entry) => Object.freeze({
      ...entry,
      supervisedAgentIds: entry.supervisedAgentIds.filter((agentId) => activeAgentIds.has(agentId))
    }));
}

function createDemoSummary({ status, completedCount, expectedCount, agentResults, decisionsRequired, directory }) {
  // The same collection the decisions are built from, keyed the way the Director
  // already decides two entries are the same signal. An item carrying no
  // identity yields null and is never added, so it is kept under both headings
  // rather than dropped on a resemblance nothing can prove.
  const awaitingDecision = new Set(
    collectItems(agentResults, requiresBusinessDecision, directory)
      .map((entry) => collectedItemIdentity(entry.domain, entry.item))
      .filter((identity) => identity !== null)
  );

  const sections = Object.freeze({
    whatIsGoingWell: collectItems(agentResults, ({ item }) =>
      ["ok", "completed"].includes(item.status) ||
      item.performance === "ok" ||
      PRODUCTION_GOING_WELL.includes(item.classification)
    , directory),
    urgent: collectItems(agentResults, ({ item }) =>
      item.urgency === "high" ||
      item.priority === "high" ||
      item.status === "blocked" ||
      item.status === "attention_required" ||
      item.delayRisk === "high"
    , directory),
    monitoring: collectItems(agentResults, ({ item }) =>
      item.urgency === "medium" ||
      item.priority === "medium" ||
      item.status === "watch" ||
      item.performance === "watch" ||
      item.delayRisk === "medium"
    , directory),
    delayed: collectItems(agentResults, ({ agent, item }) =>
      (agent === "production" && PRODUCTION_LATE.includes(item.classification)) ||
      item.delayRisk === "high" ||
      item.topic?.toLowerCase().includes("quality")
    , directory),
    receivables: collectItems(agentResults, ({ agent }) => agent === "finance", directory),
    commercial: collectItems(agentResults, ({ agent }) => agent === "commercial", directory),
    purchaseNeeds: collectItems(agentResults, ({ agent }) => agent === "purchasing", directory),
    marketingSynthesis: createMarketingSynthesis(agentResults),
    // Marketing and Community Manager answer the same question for the
    // Director: what needs to be said, and on which channel.
    marketingCommunication: collectItems(
      agentResults,
      ({ agent }) => agent === "marketing" || agent === "community_manager",
      directory
    ),
    legal: collectItems(agentResults, ({ agent }) => agent === "legal", directory),
    hr: collectItems(agentResults, ({ agent }) => agent === "hr", directory),
    afterSales: collectItems(agentResults, ({ agent }) => agent === "after_sales", directory),
    // A signal can be both a risk and a decision, and reported under both it was
    // the same line twice: nine of the eleven decisions repeated a risk, in a
    // different shape, with nothing saying they were the same reality. The two
    // headings now answer different questions. What awaits an arbitration is
    // reported where the arbitration is asked for; this heading keeps what
    // deserves watching while nothing is being asked yet.
    //
    // Filtered after collection rather than inside the predicate, because the
    // identity of a signal includes its domain and a predicate is not given one.
    // A tool is not part of that identity: the same order reaches the Director
    // through more than one tool, and it is one order either way.
    blockers: collectItems(agentResults, ({ item }) => isBlockingSignal(item), directory)
      .filter((entry) => !awaitingDecision.has(collectedItemIdentity(entry.domain, entry.item))),
    decisionsRequired
  });
  const minimumSections = createMinimumDirectorSections(sections);

  return Object.freeze({
    headline: createSummaryHeadline({ status, completedCount, expectedCount, agentResults, decisionsRequired, directory }),
    whatIsGoingWell: sections.whatIsGoingWell,
    urgent: sections.urgent,
    monitoring: sections.monitoring,
    delayed: sections.delayed,
    receivables: sections.receivables,
    commercial: sections.commercial,
    marketingCommunication: sections.marketingCommunication,
    purchaseNeeds: sections.purchaseNeeds,
    marketingSynthesis: sections.marketingSynthesis,
    legal: sections.legal,
    hr: sections.hr,
    afterSales: sections.afterSales,
    blockers: sections.blockers,
    decisionsRequired: sections.decisionsRequired,
    minimumSections,
    aggregates: createSummaryAggregates(agentResults),
    domainSources: createDomainSourceSummary(agentResults),
    sections
  });
}

// The ten headings CDC section 31 asks the Director to answer with. The six
// original keys keep their exact wording: renaming them would break callers
// for no functional gain, and is a decision of its own.
function createMinimumDirectorSections(sections) {
  return Object.freeze({
    "CE QUI VA BIEN": sections.whatIsGoingWell,
    "RETARDS / PROBLEMES": sections.delayed,
    "A ENCAISSER": sections.receivables,
    "A COMMANDER": sections.purchaseNeeds,
    "RISQUES / BLOCAGES": sections.blockers,
    "DECISIONS NECESSAIRES": sections.decisionsRequired,
    "CE QUI NECESSITE UNE ACTION COMMERCIALE": sections.commercial,
    "CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION": sections.marketingCommunication,
    "CE QUI NECESSITE UNE INTERVENTION SAV": sections.afterSales,
    "CE QUI PRESENTE UN RISQUE JURIDIQUE": sections.legal
  });
}

// Aggregates a tool computed for itself, surfaced next to the sections rather
// than inside them: a section entry is always one business item, so an
// aggregate placed there would read as one more item to act on.
//
// The projection is explicit, never a copy of the whole summary. The two
// overdue figures were held back while they were derived from the wall clock
// and production lateness was anchored on the demo operating date: reporting
// both would have shown two conventions in one answer. Lot 7 made the two
// references the same one, so that reason is gone and the figures are reported.
const SUMMARY_AGGREGATE_BY_TOOL = Object.freeze({
  get_receivables_summary: (summary) => ({
    // CDC section 29 lists collections and receivables among the fifteen things
    // its question must answer, as two of them. totalsByCurrency is what is
    // expected in; overdueTotalsByCurrency is the share of it already past due.
    // Reported side by side and never added: the second is a subset of the
    // first, so one figure would hide how much of the money owed is late.
    //
    // Currencies are never merged into a single figure: two amounts in two
    // currencies are two amounts, and adding them would invent money.
    totalsByCurrency: Object.freeze({ ...summary.totalsByCurrency }),
    overdueTotalsByCurrency: Object.freeze({ ...summary.overdueTotalsByCurrency }),
    counts: Object.freeze({
      receivables: summary.counts?.receivables ?? 0,
      overdue: summary.counts?.overdue ?? 0,
      deduplicatedInvoices: summary.counts?.deduplicatedInvoices ?? 0
    })
  }),
  get_revenue_summary: (summary) => ({
    // Currencies are never merged, exactly as for receivables. periodStart and
    // periodEnd are derived from the issue dates present, so the reader knows
    // what window the total covers without a threshold anyone had to choose.
    totalsByCurrency: Object.freeze({ ...summary.totalsByCurrency }),
    counts: Object.freeze({
      invoices: summary.counts?.invoices ?? 0,
      itemsWithoutAmount: summary.counts?.itemsWithoutAmount ?? 0,
      cancelledCount: summary.counts?.cancelledCount ?? 0
    }),
    periodStart: summary.periodStart ?? null,
    periodEnd: summary.periodEnd ?? null
  }),
  // CDC section 29 lists orders as a rubric of its own. The figure is the order
  // book: how many are registered and in which state. No amount, no currency and
  // no total, because an order carries none anywhere in this system.
  get_order_book_summary: (summary) => ({
    countsByStatus: Object.freeze({ ...summary.countsByStatus }),
    counts: Object.freeze({
      orders: summary.counts?.orders ?? 0,
      fromQuote: summary.counts?.fromQuote ?? 0
    })
  }),
  // The workshop holds one file more than the book. Naming which one keeps the
  // order count honest: the gap is reported rather than folded into the figure.
  get_production_schedule: (summary) => ({
    counts: Object.freeze({
      records: summary.counts?.records ?? 0,
      withoutOrder: summary.counts?.withoutOrder ?? 0
    }),
    productionWithoutOrder: Object.freeze([...(summary.productionWithoutOrder ?? [])])
  }),
  get_material_requirements: (summary) => ({
    counts: Object.freeze({
      orders: summary.counts?.orders ?? 0,
      lines: summary.counts?.lines ?? 0,
      shortages: summary.counts?.shortages ?? 0,
      covered: summary.counts?.covered ?? 0,
      anomalies: summary.counts?.anomalies ?? 0
    }),
    anomalies: Object.freeze([...(summary.anomalies ?? [])])
  })
});

// Keyed by presentation domain, so an aggregate lands beside the section it
// informs. A step that did not complete never contributes: its output is
// absent or partial, and a half-computed total is worse than none.
// Exported so a structural test can reach the guards directly: the demo data
// completes every step and identifies every item, so neither guard is
// observable through the API today.
export function createSummaryAggregates(agentResults) {
  const aggregates = {};

  for (const result of agentResults) {
    if (result.status !== "completed" || !result.domain) {
      continue;
    }
    const project = SUMMARY_AGGREGATE_BY_TOOL[result.tool];
    const summary = result.result?.summary;
    if (!project || !isJsonObject(summary) || aggregates[result.domain]) {
      continue;
    }
    aggregates[result.domain] = Object.freeze({
      agent: result.agent,
      tool: result.tool,
      ...project(summary)
    });
  }

  return Object.freeze(aggregates);
}

function createDomainSourceSummary(agentResults) {
  return Object.freeze(agentResults.map((result) => Object.freeze({
    agent: result.agent,
    tool: result.tool,
    domain: result.domain,
    dataSource: result.dataSource,
    sourceProvider: result.sourceProvider,
    sourceId: result.sourceId,
    status: result.status,
    itemCount: Array.isArray(result.result?.items) ? result.result.items.length : 0
  })));
}

function createMarketingSynthesis(agentResults) {
  const marketing = agentResults.find((result) => result.agent === "marketing");
  const community = agentResults.find((result) => result.agent === "community_manager");
  if (!marketing && !community) {
    return null;
  }

  return Object.freeze({
    agent: "marketing",
    supervisorAgentId: marketing?.supervisorAgentId ?? "director",
    delegatedAgentId: community?.agent ?? "community_manager",
    flow: ["community_manager", "marketing", "director"],
    status: marketing?.status === "completed" && community?.status === "completed" ? "completed" : "partial",
    marketingItems: Array.isArray(marketing?.result?.items) ? marketing.result.items : [],
    communityItems: Array.isArray(community?.result?.items) ? community.result.items : [],
    summary: "Marketing consolidates demo campaign signals with Community Manager editorial work before reporting to Director."
  });
}

// CDC section 6 defines four production states, and section 31 sorts them
// into different headings: an order running on time belongs under what is
// going well, one to keep an eye on under what may block, and only a
// dangerous or late one under what is late.
const PRODUCTION_GOING_WELL = Object.freeze(["ON_TIME"]);
const PRODUCTION_LATE = Object.freeze(["IN_DANGER", "LATE"]);

// An agent can contribute several steps, so the headline counts distinct
// agents. Counting steps would claim more agents answered than there are.
function createSummaryHeadline({ status, completedCount, expectedCount, agentResults, decisionsRequired, directory }) {
  const unavailableAgents = [...new Set(agentResults
    .filter((result) => result.status !== "completed")
    .map((result) => result.agent))];
  const respondingAgents = new Set(agentResults
    .filter((result) => result.status === "completed")
    .map((result) => result.agent)).size;
  const solicitedAgents = new Set(agentResults.map((result) => result.agent)).size;
  const highPriorityCount = countHighPrioritySignals(agentResults, directory);

  if (status === "requires_approval") {
    return `Action prepared. ${decisionsRequired.length} human approval decision(s) required before execution.`;
  }
  if (status === "partial") {
    return `Point available with ${respondingAgents} agent(s) out of ${solicitedAgents}. Missing: ${unavailableAgents.join(", ")}.`;
  }
  return `Point complete: ${respondingAgents}/${solicitedAgents} agents responded with ${highPriorityCount} high-priority demo signal(s).`;
}

function countHighPrioritySignals(agentResults, directory) {
  return collectItems(agentResults, ({ item }) =>
    item.urgency === "high" ||
    item.priority === "high" ||
    item.status === "blocked" ||
    item.status === "attention_required" ||
    item.delayRisk === "high"
  , directory).length;
}

function createDemoFindings(agentResults) {
  return agentResults.map((result) => Object.freeze({
    agent: result.agent,
    type: result.tool,
    tool: result.tool,
    source: result.tool,
    domain: result.domain,
    dataSource: result.dataSource,
    sourceProvider: result.sourceProvider,
    sourceId: result.sourceId,
    status: result.status,
    itemCount: Array.isArray(result.result?.items) ? result.result.items.length : 0,
    demo: result.result?.demo === true,
    notice: result.result?.notice ?? null,
    priority: summarizeResultPriority(result),
    title: createFindingTitle(result),
    description: createFindingDescription(result),
    error: result.error
  }));
}

function createFindingTitle(result) {
  if (result.status !== "completed") {
    return `${result.agent} unavailable`;
  }
  return `${result.agent} returned ${Array.isArray(result.result?.items) ? result.result.items.length : 0} demo item(s)`;
}

function createFindingDescription(result) {
  if (result.error) {
    return result.error.message;
  }
  return result.result?.notice ?? "Demonstration tool result.";
}

function summarizeResultPriority(result) {
  const items = Array.isArray(result.result?.items) ? result.result.items : [];
  if (items.some((item) =>
    item.urgency === "high" ||
    item.priority === "high" ||
    item.status === "blocked" ||
    item.status === "attention_required" ||
    item.delayRisk === "high"
  )) {
    return "urgent";
  }
  if (items.some((item) =>
    item.urgency === "medium" ||
    item.priority === "medium" ||
    item.status === "watch" ||
    item.delayRisk === "medium"
  )) {
    return "attention";
  }
  return result.status === "completed" ? "normal" : "unavailable";
}

// Identity of a business signal inside its presentation domain. Two tools of
// the same agent read the same reality, so the same invoice or the same
// production order reaches a section twice. Returns null when the item carries
// nothing identifying: an item we cannot recognise is never assumed to be a
// duplicate, it is kept.
// A section entry used to carry the raw record, so the Director reported
// "order-atlas-001" where a manager needs "Demo Client Atlas - 12000 MAD - en
// retard de 2 jours". Everything below only says out loud what the tools
// already computed: no fragment is produced unless the field is present, and
// none of it decides anything about the business.

// The directory used to be built from the demo data set and cached for the
// life of the process. Reading PostgreSQL then changed nothing: the Director
// kept naming demo customers next to real amounts, which is worse than naming
// none. It is now a value the caller reads from the business memory and hands
// in, and the default is empty on purpose: a caller that supplies no directory
// gets identifiers, never a name from somewhere else.
export const EMPTY_BUSINESS_DIRECTORY = Object.freeze({
  customerNames: new Map(),
  customerIdByOrder: new Map()
});

// Reads only what naming a customer needs, as the Director, which already
// holds both domains. No agent scope is widened to build it.
export async function createBusinessDirectory(businessMemory) {
  if (!businessMemory || typeof businessMemory.listBusinessRecords !== "function") {
    return EMPTY_BUSINESS_DIRECTORY;
  }

  const customerNames = new Map();
  const customerIdByOrder = new Map();

  for (const record of await businessMemory.listBusinessRecords({ domain: "customers", agentId: "director" })) {
    const name = record?.data?.name;
    if (record?.id && typeof name === "string" && name.trim() !== "") {
      customerNames.set(record.id, name);
    }
  }

  // A production record names its order, and an order names its customer.
  // Following that existing key is what lets a production entry say whose
  // order is at risk instead of only quoting an order identifier.
  for (const record of await businessMemory.listBusinessRecords({ domain: "orders", agentId: "director" })) {
    const customerId = record?.data?.customerId ?? record?.relations?.customerId;
    if (record?.id && typeof customerId === "string") {
      customerIdByOrder.set(record.id, customerId);
    }
  }

  return Object.freeze({ customerNames, customerIdByOrder });
}

// A name is reported only when it is actually known. An unresolved customer
// keeps its identifier rather than being given an invented name. Both routes
// below share this one rule, so there is a single place where an unknown
// customer is handled and a single place to get it wrong.
function customerNameFor(customerId, directory) {
  if (typeof customerId !== "string") {
    return null;
  }
  return directory.customerNames.get(customerId) ?? customerId;
}

function directCustomerName(item, directory) {
  if (typeof item?.customerName === "string" && item.customerName.trim() !== "") {
    return item.customerName;
  }
  return customerNameFor(item?.customerId, directory);
}

// Reached only through the order the record names. A material shortage names
// an order too, but its subject is the material, not whoever ordered it: this
// is why the indirect route is the last one tried, never the first.
function customerNameThroughOrder(item, directory) {
  if (typeof item?.orderId !== "string") {
    return null;
  }
  return customerNameFor(directory.customerIdByOrder.get(item.orderId) ?? null, directory);
}

// The human-readable text a tool already produced, most specific first.
function ownName(item) {
  for (const field of ["productName", "item", "label", "subject", "topic", "campaign", "supplierName", "channel"]) {
    const value = item?.[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

function businessSubject(item, directory) {
  return directCustomerName(item, directory) ?? ownName(item) ?? customerNameThroughOrder(item, directory);
}

// An amount is always reported with its currency. Amounts are never added up
// here: one entry is one amount, and summing across currencies would invent
// money that does not exist.
function describeAmount(item) {
  if (typeof item?.amount !== "number" || typeof item?.currency !== "string") {
    return null;
  }
  return `${item.amount} ${item.currency}`;
}

function describeQuantity(item) {
  const missing = item?.shortage ?? item?.missingQuantity;
  if (typeof missing !== "number") {
    return null;
  }
  const unit = typeof item?.unit === "string" && item.unit.trim() !== "" ? ` ${item.unit}` : "";
  return `manque ${missing}${unit}`;
}

// Each of these renders one named numeric field as the phrase that field
// already means. timing and reason are passed through: the tools produce them
// as readable text already.
function describeState(item) {
  const fragments = [];
  if (typeof item?.timing === "string" && item.timing.trim() !== "") {
    fragments.push(item.timing);
  }
  if (typeof item?.daysLate === "number" && item.daysLate > 0) {
    fragments.push(`en retard de ${item.daysLate} jour(s)`);
  } else if (item?.dueStatus === "due_today") {
    fragments.push("echeance aujourd'hui");
  }
  if (typeof item?.noResponseDays === "number" && item.noResponseDays > 0) {
    fragments.push(`sans reponse depuis ${item.noResponseDays} jour(s)`);
  }
  if (typeof item?.daysOpen === "number" && item.daysOpen > 0) {
    fragments.push(`ouvert depuis ${item.daysOpen} jour(s)`);
  }
  return fragments.length > 0 ? fragments.join(", ") : null;
}

// Last resort only: an item carrying no business information at all is still
// reported, by its identifier, rather than silently dropped.
function itemFallbackLabel(item) {
  for (const field of ["id", "orderId", "lineId"]) {
    const value = item?.[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return "Signal sans libelle";
}

// Exported so a structural test can assert the rendering rules directly
// instead of only through one demo data set.
export function describeBusinessItem(item, directory = EMPTY_BUSINESS_DIRECTORY) {
  const subject = businessSubject(item, directory);
  // When the subject is the customer, the record still has a title of its own:
  // a legal file says "Demo Client Atlas" and "Demo Contract Renewal", and a
  // manager needs both. It is skipped when it is already the subject.
  const title = ownName(item);
  const fragments = [
    subject,
    title === subject ? null : title,
    describeAmount(item),
    describeQuantity(item),
    describeState(item)
  ].filter((fragment) => fragment !== null);

  if (fragments.length === 0) {
    return itemFallbackLabel(item);
  }
  const reason = typeof item?.reason === "string" && item.reason.trim() !== "" ? item.reason : null;
  if (reason) {
    fragments.push(reason);
  }
  return fragments.join(" - ");
}

export function collectedItemIdentity(domain, item) {
  const identity = item?.id ?? item?.lineId ?? item?.orderId ?? item?.subject ?? item?.label;
  if (identity === null || identity === undefined) {
    return null;
  }
  // The separator cannot appear in an identifier, so two different pairs
  // never collide into the same key.
  return `${domain ?? ""}\u0000${identity}`;
}

// The first occurrence wins, and steps run in plan order with the historical
// tool first: what the Director already reported stays what it reports.
function collectItems(agentResults, predicate, directory = EMPTY_BUSINESS_DIRECTORY) {
  const collected = [];
  const seen = new Set();
  for (const result of agentResults) {
    const items = Array.isArray(result.result?.items) ? result.result.items : [];
    for (const item of items) {
      if (!predicate({ agent: result.agent, tool: result.tool, item })) {
        continue;
      }
      const identity = collectedItemIdentity(result.domain, item);
      if (identity !== null) {
        if (seen.has(identity)) {
          continue;
        }
        seen.add(identity);
      }
      collected.push(Object.freeze({
        agent: result.agent,
        tool: result.tool,
        domain: result.domain,
        dataSource: result.dataSource,
        sourceProvider: result.sourceProvider,
        sourceId: result.sourceId,
        // What a manager reads. The raw record stays available under item,
        // and its identifier under reference, so nothing is lost.
        label: describeBusinessItem(item, directory),
        reference: itemFallbackLabel(item),
        item
      }));
    }
  }
  return collected;
}

function createDecisionsRequired(request, agentResults = [], directory = EMPTY_BUSINESS_DIRECTORY) {
  return [
    ...createApprovalDecisions(request),
    ...createBusinessDecisions(agentResults, directory)
  ];
}

function createApprovalDecisions(request) {
  return (request.approvals ?? []).map((approval) => Object.freeze({
    type: "approval",
    approvalId: approval.id,
    status: approval.status,
    agent: approval.requestingAgent,
    action: approval.requestedAction,
    risk: approval.risk,
    reason: approval.reason
  }));
}

// What makes a signal a risk. Severity is read without its case because the
// records do not agree on one: urgency and status are lower case, priority is
// upper case on some records and lower on others. Compared as written,
// "critical" matched nothing, and the single most severe signal of the set
// never reached the risks heading at all.
const BLOCKING_STATES = Object.freeze(["critical", "high", "watch", "blocked", "attention_required"]);
const BLOCKING_SEVERITIES = Object.freeze(["critical", "high"]);

function lowerCased(value) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

export function isBlockingSignal(item) {
  return (
    BLOCKING_STATES.includes(lowerCased(item?.urgency)) ||
    BLOCKING_STATES.includes(lowerCased(item?.status)) ||
    BLOCKING_SEVERITIES.includes(lowerCased(item?.priority)) ||
    BLOCKING_SEVERITIES.includes(lowerCased(item?.delayRisk))
  );
}

// One predicate, used to build the decisions and to know which signals are
// already awaiting one. Two copies would drift.
function requiresBusinessDecision({ item }) {
  return item.requiresDecision === true;
}

function createBusinessDecisions(agentResults, directory) {
  return collectItems(agentResults, requiresBusinessDecision, directory)
    .map((entry) => Object.freeze({
      type: "business_decision",
      agent: entry.agent,
      tool: entry.tool,
      // The decision names the signal it is about, not only its identifier.
      label: entry.label,
      itemId: entry.item.id ?? entry.item.orderId ?? entry.item.subject ?? entry.item.label,
      priority: entry.item.urgency ?? entry.item.priority ?? entry.item.delayRisk ?? entry.item.status ?? "attention",
      reason: entry.item.decision ?? "Review this demo signal before acting."
    }));
}

function summarizeAuditEvents(events) {
  return events.map((event) => Object.freeze({
    type: event.type,
    agentId: event.agentId,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    executionId: event.executionId,
    createdAt: event.createdAt
  }));
}

function normalizeRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object." };
  }

  if (body.payload !== undefined && !isJsonObject(body.payload)) {
    return { ok: false, error: "payload must be an object when provided." };
  }

  // Identity is never taken from the request body.
  if (body.createdById !== undefined) {
    return { ok: false, error: "createdById is not accepted: the authenticated principal is the author." };
  }

  const message = normalizeText(body.message);
  const title = normalizeText(body.title) ?? message;
  const payload = { ...(body.payload ?? {}) };
  if (message) {
    payload.message = message;
  }

  if (!title && Object.keys(payload).length === 0) {
    return { ok: false, error: "message, title, or payload is required." };
  }

  return {
    ok: true,
    value: {
      title,
      source: typeof body.source === "string" ? body.source : "api",
      status: "received",
      payload,
      metadata: isJsonObject(body.metadata) ? body.metadata : {},
      // createdById is assigned from the authenticated principal by the route.
      createdById: null
    }
  };
}

function isJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeApprovalDecisionBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: true, value: { decisionReason: null } };
  }

  // The approver is the authenticated principal. Accepting it from the body is
  // exactly how an approval could be forged, so it is refused outright.
  if (body.approverId !== undefined) {
    return { ok: false, error: "approverId is not accepted: the authenticated principal is the approver." };
  }

  return {
    ok: true,
    value: { decisionReason: normalizeText(body.decisionReason) }
  };
}

function createErrorResponse(message, error) {
  return {
    error: message,
    details: {
      name: error?.name ?? "Error",
      code: error?.code
    }
  };
}

function sendDomainError(reply, message, error) {
  return reply.code(statusCodeForError(error)).send(createErrorResponse(message, error));
}

function basenameForHeader(name) {
  return String(name).replace(/["\r\n\\/]/g, "_");
}

function statusCodeForError(error) {
  if (error instanceof PlannerConfigurationError) {
    return 500;
  }

  if (error instanceof PlannerContractError) {
    return 400;
  }

  if (error instanceof PlanningError) {
    return 500;
  }

  if (error instanceof ApprovalStateError || error instanceof ToolExecutionServiceError) {
    if (error.code === "APPROVAL_NOT_FOUND") {
      return 404;
    }
    if (["AGENT_NOT_ALLOWED", "PERMISSION_DENIED", "APPROVAL_REJECTED"].includes(error.code)) {
      return 403;
    }
    if (["APPROVAL_REQUIRED", "APPROVAL_ALREADY_APPROVED", "APPROVAL_ALREADY_REJECTED", "APPROVAL_ALREADY_EXECUTED", "APPROVAL_ALREADY_PROCESSED"].includes(error.code)) {
      return 409;
    }
    if (["APPROVAL_INVALID", "INVALID_INPUT", "TOOL_NOT_FOUND"].includes(error.code)) {
      return 400;
    }
  }
  return 500;
}
