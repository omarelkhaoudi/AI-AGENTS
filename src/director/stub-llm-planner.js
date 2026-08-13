import { PLANNER_PLAN_VERSION, createPlanner } from "./planner-contract.js";

export function createStubLLMPlanner({
  id = "stub_llm",
  plan = null
} = {}) {
  return createPlanner({
    id,
    kind: "llm_stub",
    description: "Offline LLM planner stub for validating the future LLM planning path without network calls.",
    plan: async ({ request }) => plan ?? createDefaultStubPlan(request, id)
  });
}

function createDefaultStubPlan(request, plannerId) {
  return Object.freeze({
    version: PLANNER_PLAN_VERSION,
    requestId: request.id,
    intent: "stub_llm_planning",
    summary: "Stub LLM plan generated without external network calls.",
    planner: plannerId,
    agents: ["finance"],
    steps: [
      Object.freeze({
        id: `${request.id}:${plannerId}:1:finance`,
        agentId: "finance",
        sequence: 1,
        actionKind: "read_analyze",
        actionType: "analyze_request",
        toolName: "get_company_overview",
        resource: `request:${request.id}`,
        reason: "Stub LLM planner selects the finance overview tool without external calls.",
        input: {
          requestId: request.id,
          planner: plannerId
        },
        requiresApproval: false
      })
    ],
    metadata: {
      planner: plannerId,
      network: "disabled"
    }
  });
}
