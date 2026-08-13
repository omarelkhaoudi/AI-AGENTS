export const LLM_PLANNER_INTERFACE = Object.freeze({
  status: "provider_boundary_ready",
  providerBoundary: "LLMProvider",
  futureImplementations: ["OpenAIPlanner"],
  requiredProviderMethods: ["generateStructuredPlan"],
  plannerImplementation: "createLlmPlanner",
  notes: [
    "Future LLM planners must implement the Planner contract.",
    "Future LLM providers must implement generateStructuredPlan(input).",
    "Future LLM planners must return only structured plans and must never execute tools.",
    "Future LLM planners must stay behind strict plan validation before orchestration."
  ]
});
