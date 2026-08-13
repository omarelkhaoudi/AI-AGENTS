import { LlmProviderError, createProviderTimeoutError } from "./provider-contract.js";

export function createMockLlmProvider({
  plan = null,
  fail = false,
  timeout = false
} = {}) {
  return Object.freeze({
    id: "mock_llm_provider",
    async generateStructuredPlan(input) {
      if (timeout) {
        throw createProviderTimeoutError({ provider: "mock_llm_provider" });
      }
      if (fail) {
        throw new LlmProviderError("Mock LLM provider failure.", "PROVIDER_FAILURE", {
          provider: "mock_llm_provider"
        });
      }
      return typeof plan === "function" ? plan(input) : plan ?? createDefaultMockPlan(input);
    }
  });
}

function createDefaultMockPlan(input = {}) {
  const requestId = input.request?.id ?? input.request?.requestId;
  return Object.freeze({
    summary: "Mock LLM structured plan generated without external network calls.",
    planner: "llm_mock",
    agents: ["finance"],
    steps: [
      Object.freeze({
        agentId: "finance",
        sequence: 1,
        actionKind: "read_analyze",
        actionType: "analyze_request",
        toolName: "get_company_overview",
        resource: `request:${requestId}`,
        input: {
          requestId,
          planner: "llm_mock"
        },
        requiresApproval: false
      })
    ],
    metadata: {
      planner: "llm_mock",
      provider: "mock",
      network: "disabled"
    }
  });
}
