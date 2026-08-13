import { randomUUID } from "node:crypto";
import { createAuditEvent as createAuditEventRecord } from "../observability/audit.js";
import { AgentPlatformRepository } from "./repository-contract.js";

export class InMemoryRepository extends AgentPlatformRepository {
  #users = new Map();
  #agents = new Map();
  #requests = new Map();
  #plans = new Map();
  #planSteps = new Map();
  #executions = new Map();
  #approvals = new Map();
  #auditEvents = new Map();
  #documents = new Map();

  upsertUser({
    id = randomUUID(),
    email = null,
    name = "Leader",
    role = "leader",
    metadata = {},
    createdAt = new Date().toISOString(),
    updatedAt = createdAt
  } = {}) {
    const existing = this.#users.get(id);
    const record = freezeRecord({
      id,
      email,
      name,
      role,
      metadata: cloneValue(metadata),
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt
    });
    this.#users.set(record.id, record);
    return record;
  }

  getUser(userId) {
    return this.#users.get(userId) ?? null;
  }

  upsertAgent(agent) {
    const now = new Date().toISOString();
    const existing = this.#agents.get(agent.id);
    const record = freezeRecord({
      id: agent.id,
      name: agent.name,
      role: agent.role ?? existing?.role ?? "specialized_agent",
      description: agent.description,
      status: agent.status ?? existing?.status ?? "available",
      capabilities: cloneValue(agent.capabilities ?? existing?.capabilities ?? []),
      tools: cloneValue(agent.tools ?? existing?.tools ?? []),
      permissions: cloneValue(agent.permissions ?? existing?.permissions ?? []),
      metadata: cloneValue(agent.metadata ?? existing?.metadata ?? {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    this.#agents.set(record.id, record);
    return record;
  }

  getAgent(agentId) {
    return this.#agents.get(agentId) ?? null;
  }

  listAgents() {
    return [...this.#agents.values()];
  }

  createRequest({
    id = randomUUID(),
    title = null,
    source = "api",
    status = "received",
    payload = {},
    metadata = {},
    result = null,
    createdById = null,
    createdAt = new Date().toISOString(),
    updatedAt = createdAt
  } = {}) {
    const record = freezeRecord({
      id,
      title,
      source,
      status,
      payload: cloneValue(payload),
      metadata: cloneValue(metadata),
      result: cloneValue(result),
      createdById,
      createdAt,
      updatedAt
    });
    this.#requests.set(record.id, record);
    return record;
  }

  getRequest(requestId) {
    const request = this.#requests.get(requestId);
    if (!request) {
      return null;
    }

    const plans = [...this.#plans.values()]
      .filter((plan) => plan.requestId === requestId)
      .map((plan) => ({
        ...plan,
        steps: [...this.#planSteps.values()]
          .filter((step) => step.planId === plan.id)
          .sort((first, second) => first.sequence - second.sequence)
          .map((step) => ({
            ...step,
            agent: this.getAgent(step.agentId)
          }))
      }));

    return freezeRecord({
      ...request,
      createdBy: request.createdById ? this.getUser(request.createdById) : null,
      plans,
      executions: [...this.#executions.values()].filter((execution) => execution.requestId === requestId),
      approvals: [...this.#approvals.values()].filter((approval) => approval.requestId === requestId),
      auditEvents: [...this.#auditEvents.values()].filter((event) => event.requestId === requestId),
      documents: [...this.#documents.values()].filter((document) => document.requestId === requestId)
    });
  }

  updateRequest(requestId, patch = {}) {
    const existing = this.#requests.get(requestId);
    if (!existing) {
      return null;
    }

    const record = freezeRecord({
      ...existing,
      ...cloneValue(patch),
      id: existing.id,
      updatedAt: new Date().toISOString()
    });
    this.#requests.set(record.id, record);
    return record;
  }

  createPlan({
    id = randomUUID(),
    requestId,
    createdByAgentId = "director",
    status = "created",
    summary = null,
    metadata = {},
    createdAt = new Date().toISOString(),
    updatedAt = createdAt
  } = {}) {
    const record = freezeRecord({
      id,
      requestId,
      createdByAgentId,
      status,
      summary,
      metadata: cloneValue(metadata),
      createdAt,
      updatedAt
    });
    this.#plans.set(record.id, record);
    return record;
  }

  createPlanStep({
    id = randomUUID(),
    planId,
    agentId,
    sequence,
    status = "pending",
    actionType = null,
    toolName = null,
    input = null,
    output = null,
    error = null,
    requiresApproval = false,
    createdAt = new Date().toISOString(),
    updatedAt = createdAt
  } = {}) {
    const record = freezeRecord({
      id,
      planId,
      agentId,
      sequence,
      status,
      actionType,
      toolName,
      input: cloneValue(input),
      output: cloneValue(output),
      error: cloneValue(error),
      requiresApproval,
      createdAt,
      updatedAt
    });
    this.#planSteps.set(record.id, record);
    return record;
  }

  saveExecution(record) {
    const now = new Date().toISOString();
    const id = record.id ?? record.executionId ?? randomUUID();
    const saved = freezeRecord({
      id,
      executionId: record.executionId ?? id,
      requestId: record.requestId ?? null,
      planId: record.planId ?? null,
      planStepId: record.planStepId ?? null,
      agentId: record.agentId ?? null,
      status: record.status ?? "completed",
      input: cloneValue(record.input ?? null),
      output: cloneValue(record.output ?? null),
      error: cloneValue(record.error ?? null),
      metadata: cloneValue(record.metadata ?? {}),
      startedAt: record.startedAt ?? now,
      finishedAt: record.finishedAt ?? null,
      durationMs: record.durationMs ?? null,
      createdAt: record.createdAt ?? now,
      updatedAt: record.updatedAt ?? now
    });
    this.#executions.set(saved.id, saved);
    return saved;
  }

  getExecution(executionId) {
    return (
      this.#executions.get(executionId) ??
      [...this.#executions.values()].find((record) => record.executionId === executionId) ??
      null
    );
  }

  listExecutions() {
    return [...this.#executions.values()];
  }

  saveApproval(approval) {
    const record = freezeRecord({
      ...approval,
      metadata: cloneValue(approval.metadata ?? {})
    });
    this.#approvals.set(record.id, record);
    return record;
  }

  getApproval(approvalId) {
    return this.#approvals.get(approvalId) ?? null;
  }

  listApprovals() {
    return [...this.#approvals.values()];
  }

  createAuditEvent(event) {
    const record = createAuditEventRecord(event);
    this.#auditEvents.set(record.id, record);
    return record;
  }

  listAuditEvents(filters = {}) {
    return [...this.#auditEvents.values()].filter((event) => {
      if (filters.requestId && event.requestId !== filters.requestId) {
        return false;
      }
      if (filters.type && event.type !== filters.type) {
        return false;
      }
      return true;
    });
  }

  createDocument({
    id = randomUUID(),
    requestId = null,
    uploadedById = null,
    name,
    mimeType = null,
    storageKey,
    checksum = null,
    sizeBytes = null,
    metadata = {},
    createdAt = new Date().toISOString(),
    updatedAt = createdAt
  } = {}) {
    const record = freezeRecord({
      id,
      requestId,
      uploadedById,
      name,
      mimeType,
      storageKey,
      checksum,
      sizeBytes,
      metadata: cloneValue(metadata),
      createdAt,
      updatedAt
    });
    this.#documents.set(record.id, record);
    return record;
  }

  getDocument(documentId) {
    return this.#documents.get(documentId) ?? null;
  }
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function freezeRecord(record) {
  return Object.freeze(record);
}
