import Fastify from "fastify";
import { seedMvpAgents } from "../agents/seed.js";
import { PlannerContractError } from "../director/planner-contract.js";
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

export function buildApi({
  repository = new InMemoryRepository(),
  logger = false,
  seedAgents = true,
  planner,
  toolRegistry = null
} = {}) {
  assertRepositoryContract(repository);

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
      if (seedAgents) {
        seedPromise ??= seedMvpAgents(repository);
        await seedPromise;
      }

      const savedRequest = await repository.createRequest(validation.value);
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

      const orchestratedRequest = await orchestrateRequest({
        requestId: savedRequest.id,
        repository,
        planner,
        toolRegistry
      });

      return reply.code(201).send({ request: orchestratedRequest });
    } catch (error) {
      return sendDomainError(reply, "Request orchestration failed.", error);
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
  if (error instanceof PlannerContractError) {
    return 400;
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
