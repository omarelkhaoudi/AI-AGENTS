import { randomUUID } from "node:crypto";
import { createAuditEvent as createAuditEventRecord } from "../observability/audit.js";
import { AgentPlatformRepository } from "./repository-contract.js";

export class PrismaRepository extends AgentPlatformRepository {
  constructor({ prisma }) {
    super();
    if (!prisma) {
      throw new Error("PrismaRepository requires a PrismaClient instance.");
    }
    this.prisma = prisma;
  }

  static async create() {
    return new PrismaRepository({ prisma: await createPrismaClient() });
  }

  async upsertUser(input = {}) {
    const id = input.id ?? randomUUID();
    return this.prisma.user.upsert({
      where: { id },
      create: {
        id,
        email: input.email ?? null,
        name: input.name ?? "Leader",
        role: input.role ?? "leader",
        metadata: input.metadata ?? {}
      },
      update: {
        email: input.email ?? null,
        name: input.name ?? "Leader",
        role: input.role ?? "leader",
        metadata: input.metadata ?? {}
      }
    });
  }

  async getUser(userId) {
    return this.prisma.user.findUnique({ where: { id: userId } });
  }

  async upsertAgent(agent) {
    return this.prisma.agent.upsert({
      where: { id: agent.id },
      create: {
        id: agent.id,
        name: agent.name,
        role: agent.role ?? "specialized_agent",
        description: agent.description,
        status: agent.status ?? "available",
        capabilities: agent.capabilities ?? [],
        tools: agent.tools ?? [],
        permissions: agent.permissions ?? [],
        metadata: agent.metadata ?? {}
      },
      update: {
        name: agent.name,
        role: agent.role ?? "specialized_agent",
        description: agent.description,
        status: agent.status ?? "available",
        capabilities: agent.capabilities ?? [],
        tools: agent.tools ?? [],
        permissions: agent.permissions ?? [],
        metadata: agent.metadata ?? {}
      }
    });
  }

  async getAgent(agentId) {
    return this.prisma.agent.findUnique({ where: { id: agentId } });
  }

  async listAgents() {
    return this.prisma.agent.findMany({ orderBy: { id: "asc" } });
  }

  async createRequest(input = {}) {
    return this.prisma.request.create({
      data: stripUndefined({
        id: input.id,
        title: input.title ?? null,
        source: input.source ?? "api",
        status: input.status ?? "received",
        payload: input.payload ?? {},
        metadata: input.metadata ?? {},
        result: input.result ?? null,
        createdById: input.createdById ?? null
      })
    });
  }

  async getRequest(requestId) {
    return this.prisma.request.findUnique({
      where: { id: requestId },
      include: {
        createdBy: true,
        plans: {
          include: {
            steps: {
              include: {
                agent: true,
                executions: true,
                approvals: true,
                auditEvents: true
              },
              orderBy: { sequence: "asc" }
            }
          },
          orderBy: { createdAt: "asc" }
        },
        executions: { orderBy: { createdAt: "asc" } },
        approvals: { orderBy: { createdAt: "asc" } },
        auditEvents: { orderBy: { createdAt: "asc" } },
        documents: { orderBy: { createdAt: "asc" } }
      }
    });
  }

  async updateRequest(requestId, patch = {}) {
    return this.prisma.request.update({
      where: { id: requestId },
      data: stripUndefined({
        title: patch.title,
        status: patch.status,
        payload: patch.payload,
        metadata: patch.metadata,
        result: patch.result
      })
    });
  }

  async createPlan(input = {}) {
    return this.prisma.plan.create({
      data: stripUndefined({
        id: input.id,
        requestId: input.requestId,
        createdByAgentId: input.createdByAgentId ?? "director",
        status: input.status ?? "created",
        summary: input.summary ?? null,
        metadata: input.metadata ?? {}
      })
    });
  }

  async createPlanStep(input = {}) {
    return this.prisma.planStep.create({
      data: stripUndefined({
        id: input.id,
        planId: input.planId,
        agentId: input.agentId,
        sequence: input.sequence,
        status: input.status ?? "pending",
        actionType: input.actionType ?? null,
        toolName: input.toolName ?? null,
        input: input.input ?? null,
        output: input.output ?? null,
        error: input.error ?? null,
        requiresApproval: input.requiresApproval ?? false
      })
    });
  }

  async saveExecution(input = {}) {
    if (!input.requestId) {
      throw new Error("PrismaRepository.saveExecution requires a requestId.");
    }

    const id = input.id ?? input.executionId ?? randomUUID();
    return this.prisma.execution.upsert({
      where: { id },
      create: stripUndefined({
        id,
        requestId: input.requestId,
        planId: input.planId ?? null,
        planStepId: input.planStepId ?? null,
        agentId: input.agentId ?? null,
        status: input.status ?? "completed",
        input: input.input ?? null,
        output: input.output ?? null,
        error: input.error ?? null,
        metadata: input.metadata ?? {},
        startedAt: input.startedAt ? new Date(input.startedAt) : undefined,
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
        durationMs: input.durationMs ?? null
      }),
      update: stripUndefined({
        status: input.status,
        output: input.output,
        error: input.error,
        metadata: input.metadata,
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : undefined,
        durationMs: input.durationMs
      })
    });
  }

  async getExecution(executionId) {
    return this.prisma.execution.findUnique({ where: { id: executionId } });
  }

  async listExecutions() {
    return this.prisma.execution.findMany({ orderBy: { createdAt: "desc" } });
  }

  async saveApproval(approval) {
    return this.prisma.approval.upsert({
      where: { id: approval.id },
      create: approvalData(approval),
      update: approvalData(approval)
    });
  }

  async getApproval(approvalId) {
    return this.prisma.approval.findUnique({ where: { id: approvalId } });
  }

  async listApprovals() {
    return this.prisma.approval.findMany({ orderBy: { createdAt: "desc" } });
  }

  async createAuditEvent(event) {
    const record = createAuditEventRecord(event);
    return this.prisma.auditEvent.create({
      data: stripUndefined({
        id: record.id,
        type: record.type,
        actorUserId: record.actorUserId,
        agentId: record.agentId,
        requestId: record.requestId,
        planId: record.planId,
        planStepId: record.planStepId,
        executionId: record.executionId,
        documentId: record.documentId,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
        metadata: record.metadata,
        createdAt: new Date(record.createdAt)
      })
    });
  }

  async listAuditEvents(filters = {}) {
    return this.prisma.auditEvent.findMany({
      where: stripUndefined({
        requestId: filters.requestId,
        type: filters.type
      }),
      orderBy: { createdAt: "desc" }
    });
  }

  async createDocument(input = {}) {
    return this.prisma.document.create({
      data: stripUndefined({
        id: input.id,
        requestId: input.requestId ?? null,
        uploadedById: input.uploadedById ?? null,
        name: input.name,
        mimeType: input.mimeType ?? null,
        storageKey: input.storageKey,
        checksum: input.checksum ?? null,
        sizeBytes: input.sizeBytes ?? null,
        metadata: input.metadata ?? {}
      })
    });
  }

  async getDocument(documentId) {
    return this.prisma.document.findUnique({ where: { id: documentId } });
  }
}

export async function createPrismaClient() {
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient();
}

function approvalData(approval) {
  return stripUndefined({
    id: approval.id,
    requestId: approval.requestId ?? null,
    planStepId: approval.planStepId ?? null,
    requestingAgent: approval.requestingAgent,
    requestedByAgentId: approval.requestedByAgentId ?? null,
    approverId: approval.approverId ?? null,
    requestedAction: approval.requestedAction,
    reason: approval.reason,
    affectedResource: approval.affectedResource,
    risk: approval.risk,
    status: approval.status,
    decisionReason: approval.decisionReason ?? null,
    metadata: approval.metadata ?? {},
    createdAt: approval.createdAt ? new Date(approval.createdAt) : undefined,
    updatedAt: approval.updatedAt ? new Date(approval.updatedAt) : undefined,
    decidedAt: approval.decidedAt ? new Date(approval.decidedAt) : null
  });
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}
