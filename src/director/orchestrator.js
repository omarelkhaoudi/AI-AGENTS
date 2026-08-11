import { randomUUID } from "node:crypto";
import { AgentRegistryError } from "../agents/registry.js";
import { createExecutionLogger } from "../observability/logger.js";

export class DirectorExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DirectorExecutionError";
    this.details = details;
  }
}

export function createDirectorRequest({ requestId = randomUUID(), payload = {}, metadata = {} } = {}) {
  return Object.freeze({
    requestId,
    payload,
    metadata: { ...metadata },
    createdAt: new Date().toISOString()
  });
}

export class DirectorOrchestrator {
  constructor({
    registry,
    planner = createNoopPlanner(),
    delegate = createPlaceholderDelegate(),
    aggregate = createDefaultAggregator(),
    logger = createExecutionLogger()
  }) {
    if (!registry) {
      throw new DirectorExecutionError("Director requires an agent registry.");
    }

    this.registry = registry;
    this.planner = planner;
    this.delegate = delegate;
    this.aggregate = aggregate;
    this.logger = logger;
  }

  async execute(request) {
    const startedAt = Date.now();
    const executionId = request?.requestId ?? randomUUID();

    try {
      const plan = await this.planner({ request, registry: this.registry });
      validateDelegationPlan(plan);

      const results = [];
      for (const step of plan.steps) {
        const agent = this.registry.require(step.agentId);
        const result = await this.delegate({ request, step, agent });
        results.push(normalizeDelegationResult(step.agentId, result));
      }

      const response = await this.aggregate({ request, plan, results });
      const metadata = createExecutionMetadata({
        executionId,
        status: "completed",
        startedAt,
        agentId: "director"
      });

      this.logger.info("director.execution.completed", metadata);
      return Object.freeze({ response, results, metadata });
    } catch (error) {
      const metadata = createExecutionMetadata({
        executionId,
        status: "failed",
        startedAt,
        agentId: "director",
        error
      });
      this.logger.error("director.execution.failed", metadata);

      if (error instanceof AgentRegistryError || error instanceof DirectorExecutionError) {
        throw error;
      }

      throw new DirectorExecutionError("Director execution failed.", {
        cause: error?.message ?? String(error),
        executionId
      });
    }
  }
}

export function createNoopPlanner() {
  return async () => Object.freeze({ steps: [], metadata: { phase: "0" } });
}

export function createPlaceholderDelegate() {
  return async ({ agent, step }) =>
    Object.freeze({
      agentId: agent.id,
      stepId: step.stepId,
      status: "skipped",
      output: null,
      metadata: {
        reason: "No business delegation rules are implemented in Phase 0."
      }
    });
}

export function createDefaultAggregator() {
  return async ({ request, results }) =>
    Object.freeze({
      requestId: request.requestId,
      status: results.some((result) => result.status === "failed") ? "partial" : "completed",
      results,
      metadata: {
        phase: "0",
        businessReasoningImplemented: false
      }
    });
}

export function validateDelegationPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps)) {
    throw new DirectorExecutionError("Delegation plan must contain a steps array.");
  }

  for (const step of plan.steps) {
    if (!step || typeof step !== "object") {
      throw new DirectorExecutionError("Delegation step must be an object.");
    }
    if (typeof step.agentId !== "string" || step.agentId.trim().length === 0) {
      throw new DirectorExecutionError("Delegation step requires an agentId.");
    }
  }

  return true;
}

export function normalizeDelegationResult(agentId, result = {}) {
  return Object.freeze({
    agentId,
    status: result.status ?? "completed",
    output: result.output ?? null,
    metadata: result.metadata ?? {}
  });
}

export function createExecutionMetadata({ executionId, agentId, status, startedAt, error }) {
  return Object.freeze({
    executionId,
    agentId,
    status,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    error: error ? sanitizeError(error) : undefined
  });
}

function sanitizeError(error) {
  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error)
  };
}
