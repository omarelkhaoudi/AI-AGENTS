import { createMockLlmProvider } from "../llm/mock-provider.js";
import { redact } from "../observability/logger.js";
import { createDeterministicPlanner } from "./deterministic-planner.js";
import { createLlmPlanner } from "./llm-planner.js";
import { createStubLLMPlanner } from "./stub-llm-planner.js";

export const PLANNER_PROVIDERS = Object.freeze([
  "deterministic",
  "stub_llm",
  "llm_mock"
]);

export class PlannerConfigurationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PlannerConfigurationError";
    this.code = "CONFIGURATION_ERROR";
    this.details = redact(details);
  }
}

export function createPlannerConfig(env = process.env) {
  const provider = normalizePlannerProvider(env.PLANNER_PROVIDER);
  assertKnownPlannerProvider(provider);

  return Object.freeze({
    provider
  });
}

export function createPlannerFromConfig(config = {}) {
  const provider = normalizePlannerProvider(config.provider ?? config.PLANNER_PROVIDER);
  assertKnownPlannerProvider(provider);

  if (provider === "deterministic") {
    return createDeterministicPlanner();
  }

  if (provider === "stub_llm") {
    return createStubLLMPlanner();
  }

  if (provider === "llm_mock") {
    return createLlmPlanner({
      provider: createMockLlmProvider()
    });
  }

  throw new PlannerConfigurationError("Unsupported planner provider.", { provider });
}

function normalizePlannerProvider(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "deterministic";
  }
  return value.trim();
}

function assertKnownPlannerProvider(provider) {
  if (!PLANNER_PROVIDERS.includes(provider)) {
    throw new PlannerConfigurationError("Unknown planner provider.", {
      provider,
      supportedProviders: PLANNER_PROVIDERS
    });
  }
}
