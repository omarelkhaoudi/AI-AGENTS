import { SopContractError, createSopDefinition } from "./contract.js";
import { listDefaultSops } from "./default-sops.js";

export class SopAccessError extends Error {
  constructor(message, code = "SOP_ACCESS_DENIED", details = {}) {
    super(message);
    this.name = "SopAccessError";
    this.code = code;
    this.details = details;
  }
}

export class InMemorySopRepository {
  #sops = new Map();

  constructor({ sops = listDefaultSops() } = {}) {
    for (const sop of sops) {
      this.saveSop(sop);
    }
  }

  saveSop(input) {
    const sop = createSopDefinition(input);
    this.#sops.set(sop.id, sop);
    return sop;
  }

  getSop(sopId, { agentId } = {}) {
    const sop = this.#sops.get(sopId) ?? null;
    if (!sop) {
      return null;
    }
    assertSopReadableByAgent(sop, agentId);
    return sop;
  }

  listSops({ agentId } = {}) {
    if (!agentId) {
      throw new SopContractError("agentId is required to list SOPs.", "AGENT_REQUIRED");
    }

    return [...this.#sops.values()].filter((sop) => sop.agentId === agentId);
  }

  listAllSopsForDirector({ agentId } = {}) {
    if (agentId !== "director") {
      throw new SopAccessError("Only Director can inspect the full SOP catalog.", "SOP_ACCESS_DENIED", {
        agentId
      });
    }
    return [...this.#sops.values()];
  }
}

export function createDefaultSopRepository() {
  return new InMemorySopRepository();
}

function assertSopReadableByAgent(sop, agentId) {
  if (!agentId) {
    throw new SopContractError("agentId is required to read SOPs.", "AGENT_REQUIRED");
  }
  if (agentId === "director" || sop.agentId === agentId) {
    return true;
  }
  throw new SopAccessError(`Agent cannot read SOP: ${sop.id}`, "SOP_ACCESS_DENIED", {
    sopId: sop.id,
    sopAgentId: sop.agentId,
    agentId
  });
}
