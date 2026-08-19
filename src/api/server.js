import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMvpAgentHierarchy } from "../agents/default-agents.js";
import { seedMvpAgents } from "../agents/seed.js";
import { loadFoundationConfig } from "../config.js";
import { PlannerConfigurationError, createPlannerFromConfig } from "../director/planner-factory.js";
import { PlannerContractError, PlanningError } from "../director/planner-contract.js";
import { orchestrateRequest } from "../director/request-orchestration.js";
import { createAuditEvent } from "../observability/audit.js";
import { InMemoryRepository } from "../persistence/in-memory-repository.js";
import { assertRepositoryContract } from "../persistence/repository-contract.js";
import { ApprovalStateError } from "../security/approval.js";
import {
  approveApprovalRequest,
  executeApprovedApproval,
  rejectApprovalRequest
} from "../security/approval-flow.js";
import { ToolExecutionServiceError } from "../tools/execution-service.js";

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
  toolRegistry = null
} = {}) {
  assertRepositoryContract(repository);
  const selectedPlanner = planner ?? createPlannerFromConfig((config ?? loadFoundationConfig()).planner);

  const app = Fastify({ logger });
  let seedPromise = null;

  app.addHook("onClose", async () => {
    await repository.disconnect();
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "ai-agents",
    timestamp: new Date().toISOString()
  }));

  app.get("/", async (_request, reply) => serveFrontendAsset(reply, "/"));
  app.get("/app/", async (_request, reply) => serveFrontendAsset(reply, "/app/"));
  app.get("/app/app.js", async (_request, reply) => serveFrontendAsset(reply, "/app/app.js"));
  app.get("/app/styles.css", async (_request, reply) => serveFrontendAsset(reply, "/app/styles.css"));

  app.get("/api/approvals", async (request, reply) => {
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

  app.get("/api/approvals/:id", async (request, reply) => {
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

  app.post("/api/approvals/:id/approve", async (request, reply) => {
    try {
      const decision = normalizeApprovalDecisionBody(request.body);
      const approval = await approveApprovalRequest({
        repository,
        approvalId: request.params.id,
        approverId: decision.approverId,
        decisionReason: decision.decisionReason
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

  app.post("/api/approvals/:id/reject", async (request, reply) => {
    try {
      const decision = normalizeApprovalDecisionBody(request.body);
      const approval = await rejectApprovalRequest({
        repository,
        approvalId: request.params.id,
        approverId: decision.approverId,
        decisionReason: decision.decisionReason
      });
      return { approval };
    } catch (error) {
      return sendDomainError(reply, "Approval rejection failed.", error);
    }
  });

  app.post("/api/requests", async (request, reply) => {
    const validation = normalizeRequestBody(request.body);
    if (!validation.ok) {
      return reply.code(400).send({ error: validation.error });
    }

    try {
      const orchestratedRequest = await createAndOrchestrateRequest({
        request: validation.value,
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

  app.post("/api/director/requests", async (request, reply) => {
    const validation = normalizeRequestBody(request.body);
    if (!validation.ok) {
      return reply.code(400).send({ error: validation.error });
    }

    try {
      const orchestratedRequest = await createAndOrchestrateRequest({
        request: {
          ...validation.value,
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

      return reply.code(201).send(createDirectorDemoResponse(orchestratedRequest));
    } catch (error) {
      return sendDomainError(reply, "Director request failed.", error);
    }
  });

  app.get("/api/requests/:id", async (request, reply) => {
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

  return app;
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

function createDirectorDemoResponse(request) {
  const agentResults = createAgentResults(request);
  const completedCount = agentResults.filter((result) => result.status === "completed").length;
  const expectedCount = request.plans?.[0]?.steps?.length ?? agentResults.length;
  const decisionsRequired = createDecisionsRequired(request, agentResults);
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
    decisionsRequired
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

function createDemoAgentList(agentResults) {
  return [
    Object.freeze({
      id: "director",
      tool: null,
      status: agentResults.some((result) => result.status !== "completed") ? "partial" : "completed"
    }),
    ...agentResults.map((result) => Object.freeze({
      id: result.agent,
      tool: result.tool,
      status: result.status,
      supervisorAgentId: result.supervisorAgentId,
      supervisedAgentIds: result.supervisedAgentIds
    }))
  ];
}

const BUSINESS_DOMAIN_BY_TOOL = Object.freeze({
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
  prepare_legal_sensitive_decision: "legal_demo_overview"
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

function createDemoSummary({ status, completedCount, expectedCount, agentResults, decisionsRequired }) {
  const sections = Object.freeze({
    whatIsGoingWell: collectItems(agentResults, ({ item }) =>
      ["ok", "completed"].includes(item.status) || item.performance === "ok"
    ),
    urgent: collectItems(agentResults, ({ item }) =>
      item.urgency === "high" ||
      item.priority === "high" ||
      item.status === "blocked" ||
      item.status === "attention_required" ||
      item.delayRisk === "high"
    ),
    monitoring: collectItems(agentResults, ({ item }) =>
      item.urgency === "medium" ||
      item.priority === "medium" ||
      item.status === "watch" ||
      item.performance === "watch" ||
      item.delayRisk === "medium"
    ),
    delayed: collectItems(agentResults, ({ agent, item }) =>
      agent === "production" || item.delayRisk || item.topic?.toLowerCase().includes("quality")
    ),
    receivables: collectItems(agentResults, ({ agent }) => agent === "finance"),
    purchaseNeeds: collectItems(agentResults, ({ agent }) => agent === "purchasing"),
    marketingSynthesis: createMarketingSynthesis(agentResults),
    legal: collectItems(agentResults, ({ agent }) => agent === "legal"),
    hr: collectItems(agentResults, ({ agent }) => agent === "hr"),
    afterSales: collectItems(agentResults, ({ agent }) => agent === "after_sales"),
    blockers: collectItems(agentResults, ({ item }) =>
      ["high", "watch", "blocked", "attention_required"].includes(item.urgency) ||
      ["high", "watch", "blocked", "attention_required"].includes(item.status) ||
      item.priority === "high" ||
      item.delayRisk === "high"
    ),
    decisionsRequired
  });
  const minimumSections = createMinimumDirectorSections(sections);

  return Object.freeze({
    headline: createSummaryHeadline({ status, completedCount, expectedCount, agentResults, decisionsRequired }),
    whatIsGoingWell: sections.whatIsGoingWell,
    urgent: sections.urgent,
    monitoring: sections.monitoring,
    delayed: sections.delayed,
    receivables: sections.receivables,
    purchaseNeeds: sections.purchaseNeeds,
    marketingSynthesis: sections.marketingSynthesis,
    legal: sections.legal,
    hr: sections.hr,
    afterSales: sections.afterSales,
    blockers: sections.blockers,
    decisionsRequired: sections.decisionsRequired,
    minimumSections,
    domainSources: createDomainSourceSummary(agentResults),
    sections
  });
}

function createMinimumDirectorSections(sections) {
  return Object.freeze({
    "CE QUI VA BIEN": sections.whatIsGoingWell,
    "RETARDS / PROBLEMES": sections.delayed,
    "A ENCAISSER": sections.receivables,
    "A COMMANDER": sections.purchaseNeeds,
    "RISQUES / BLOCAGES": sections.blockers,
    "DECISIONS NECESSAIRES": sections.decisionsRequired
  });
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

function createSummaryHeadline({ status, completedCount, expectedCount, agentResults, decisionsRequired }) {
  const unavailableAgents = agentResults
    .filter((result) => result.status !== "completed")
    .map((result) => result.agent);
  const highPriorityCount = countHighPrioritySignals(agentResults);

  if (status === "requires_approval") {
    return `Action prepared. ${decisionsRequired.length} human approval decision(s) required before execution.`;
  }
  if (status === "partial") {
    return `Point available with ${completedCount} agent(s) out of ${expectedCount}. Missing: ${unavailableAgents.join(", ")}.`;
  }
  return `Point complete: ${completedCount}/${expectedCount} agents responded with ${highPriorityCount} high-priority demo signal(s).`;
}

function countHighPrioritySignals(agentResults) {
  return collectItems(agentResults, ({ item }) =>
    item.urgency === "high" ||
    item.priority === "high" ||
    item.status === "blocked" ||
    item.status === "attention_required" ||
    item.delayRisk === "high"
  ).length;
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

function collectItems(agentResults, predicate) {
  const collected = [];
  for (const result of agentResults) {
    const items = Array.isArray(result.result?.items) ? result.result.items : [];
    for (const item of items) {
      if (predicate({ agent: result.agent, tool: result.tool, item })) {
        collected.push(Object.freeze({
          agent: result.agent,
          tool: result.tool,
          domain: result.domain,
          dataSource: result.dataSource,
          sourceProvider: result.sourceProvider,
          sourceId: result.sourceId,
          item
        }));
      }
    }
  }
  return collected;
}

function createDecisionsRequired(request, agentResults = []) {
  return [
    ...createApprovalDecisions(request),
    ...createBusinessDecisions(agentResults)
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

function createBusinessDecisions(agentResults) {
  return collectItems(agentResults, ({ item }) => item.requiresDecision === true)
    .map((entry) => Object.freeze({
      type: "business_decision",
      agent: entry.agent,
      tool: entry.tool,
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
      createdById: typeof body.createdById === "string" ? body.createdById : null
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
    return { approverId: null, decisionReason: null };
  }

  return {
    approverId: normalizeText(body.approverId),
    decisionReason: normalizeText(body.decisionReason)
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
