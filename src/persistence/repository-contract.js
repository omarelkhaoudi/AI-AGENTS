export const REPOSITORY_METHODS = Object.freeze([
  "upsertUser",
  "getUser",
  "upsertAgent",
  "getAgent",
  "listAgents",
  "createRequest",
  "getRequest",
  "updateRequest",
  "createPlan",
  "createPlanStep",
  "saveExecution",
  "getExecution",
  "listExecutions",
  "saveApproval",
  "createApproval",
  "getApproval",
  "listApprovals",
  "listPendingApprovals",
  "approveApproval",
  "rejectApproval",
  "markApprovalExecuted",
  "createAuditEvent",
  "listAuditEvents",
  "createDocument",
  "getDocument",
  "transaction",
  "disconnect"
]);

export class RepositoryContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryContractError";
  }
}

export class AgentPlatformRepository {
  upsertUser() {
    throw new RepositoryContractError("upsertUser is not implemented.");
  }

  getUser() {
    throw new RepositoryContractError("getUser is not implemented.");
  }

  upsertAgent() {
    throw new RepositoryContractError("upsertAgent is not implemented.");
  }

  getAgent() {
    throw new RepositoryContractError("getAgent is not implemented.");
  }

  listAgents() {
    throw new RepositoryContractError("listAgents is not implemented.");
  }

  createRequest() {
    throw new RepositoryContractError("createRequest is not implemented.");
  }

  getRequest() {
    throw new RepositoryContractError("getRequest is not implemented.");
  }

  updateRequest() {
    throw new RepositoryContractError("updateRequest is not implemented.");
  }

  createPlan() {
    throw new RepositoryContractError("createPlan is not implemented.");
  }

  createPlanStep() {
    throw new RepositoryContractError("createPlanStep is not implemented.");
  }

  saveExecution() {
    throw new RepositoryContractError("saveExecution is not implemented.");
  }

  getExecution() {
    throw new RepositoryContractError("getExecution is not implemented.");
  }

  listExecutions() {
    throw new RepositoryContractError("listExecutions is not implemented.");
  }

  saveApproval() {
    throw new RepositoryContractError("saveApproval is not implemented.");
  }

  createApproval() {
    throw new RepositoryContractError("createApproval is not implemented.");
  }

  getApproval() {
    throw new RepositoryContractError("getApproval is not implemented.");
  }

  listApprovals() {
    throw new RepositoryContractError("listApprovals is not implemented.");
  }

  listPendingApprovals() {
    throw new RepositoryContractError("listPendingApprovals is not implemented.");
  }

  approveApproval() {
    throw new RepositoryContractError("approveApproval is not implemented.");
  }

  rejectApproval() {
    throw new RepositoryContractError("rejectApproval is not implemented.");
  }

  markApprovalExecuted() {
    throw new RepositoryContractError("markApprovalExecuted is not implemented.");
  }

  createAuditEvent() {
    throw new RepositoryContractError("createAuditEvent is not implemented.");
  }

  listAuditEvents() {
    throw new RepositoryContractError("listAuditEvents is not implemented.");
  }

  createDocument() {
    throw new RepositoryContractError("createDocument is not implemented.");
  }

  getDocument() {
    throw new RepositoryContractError("getDocument is not implemented.");
  }

  transaction() {
    throw new RepositoryContractError("transaction is not implemented.");
  }

  disconnect() {
    throw new RepositoryContractError("disconnect is not implemented.");
  }
}

export function assertRepositoryContract(repository) {
  if (!repository || typeof repository !== "object") {
    throw new RepositoryContractError("Repository must be an object.");
  }

  const missing = REPOSITORY_METHODS.filter((method) => typeof repository[method] !== "function");
  if (missing.length > 0) {
    throw new RepositoryContractError(`Repository is missing methods: ${missing.join(", ")}`);
  }

  return true;
}
