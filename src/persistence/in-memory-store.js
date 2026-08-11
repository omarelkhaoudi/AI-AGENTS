export class InMemoryExecutionStore {
  #executions = new Map();
  #approvals = new Map();

  saveExecution(record) {
    this.#executions.set(record.executionId, Object.freeze({ ...record }));
    return this.#executions.get(record.executionId);
  }

  getExecution(executionId) {
    return this.#executions.get(executionId);
  }

  listExecutions() {
    return [...this.#executions.values()];
  }

  saveApproval(approval) {
    this.#approvals.set(approval.id, Object.freeze({ ...approval }));
    return this.#approvals.get(approval.id);
  }

  getApproval(approvalId) {
    return this.#approvals.get(approvalId);
  }

  listApprovals() {
    return [...this.#approvals.values()];
  }
}
