import Fastify from "fastify";
import { seedMvpAgents } from "../agents/seed.js";
import { orchestrateRequest } from "../director/request-orchestration.js";
import { createAuditEvent } from "../observability/audit.js";
import { InMemoryRepository } from "../persistence/in-memory-repository.js";
import { assertRepositoryContract } from "../persistence/repository-contract.js";

export function buildApi({ repository = new InMemoryRepository(), logger = false, seedAgents = true } = {}) {
  assertRepositoryContract(repository);

  const app = Fastify({ logger });
  let seedPromise = null;

  app.get("/health", async () => ({
    status: "ok",
    service: "ai-agents",
    timestamp: new Date().toISOString()
  }));

  app.post("/api/requests", async (request, reply) => {
    if (seedAgents) {
      seedPromise ??= seedMvpAgents(repository);
      await seedPromise;
    }

    const validation = normalizeRequestBody(request.body);
    if (!validation.ok) {
      return reply.code(400).send({ error: validation.error });
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
      repository
    });

    return reply.code(201).send({ request: orchestratedRequest });
  });

  app.get("/api/requests/:id", async (request, reply) => {
    const savedRequest = await repository.getRequest(request.params.id);
    if (!savedRequest) {
      return reply.code(404).send({ error: "Request not found." });
    }

    return { request: savedRequest };
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

  return {
    ok: true,
    value: {
      title: typeof body.title === "string" ? body.title : null,
      source: typeof body.source === "string" ? body.source : "api",
      status: "received",
      payload: body.payload ?? {},
      metadata: isJsonObject(body.metadata) ? body.metadata : {},
      createdById: typeof body.createdById === "string" ? body.createdById : null
    }
  };
}

function isJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
