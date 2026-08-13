import { createMockLlmProvider } from "../llm/mock-provider.js";
import { DEFAULT_OPENAI_MODEL, createOpenAIProvider } from "../llm/openai-provider.js";
import { redact } from "../observability/logger.js";
import { createDeterministicPlanner } from "./deterministic-planner.js";
import { createLlmPlanner } from "./llm-planner.js";
import { createStubLLMPlanner } from "./stub-llm-planner.js";

export const PLANNER_PROVIDERS = Object.freeze([
  "deterministic",
  "stub_llm",
  "llm_mock",
  "llm_openai"
]);

export const LLM_PROVIDERS = Object.freeze([
  "mock",
  "openai"
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
  const llmProvider = normalizeLlmProvider(env.LLM_PROVIDER, provider);
  assertKnownLlmProvider(llmProvider);
  const openaiApiKey = env.OPENAI_API_KEY ?? env.AI_PROVIDER_API_KEY;
  if (provider === "llm_openai" && !hasText(openaiApiKey)) {
    throw new PlannerConfigurationError("OPENAI_API_KEY is required when PLANNER_PROVIDER=llm_openai.", {
      provider
    });
  }

  return Object.freeze({
    provider,
    llmProvider,
    openai: Object.freeze({
      apiKey: openaiApiKey,
      hasApiKey: hasText(openaiApiKey),
      model: env.OPENAI_MODEL ?? env.AI_PROVIDER_MODEL ?? DEFAULT_OPENAI_MODEL
    })
  });
}

export function createPlannerFromConfig(config = {}, dependencies = {}) {
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

  if (provider === "llm_openai") {
    const apiKey = config.openai?.apiKey ?? config.OPENAI_API_KEY ?? config.AI_PROVIDER_API_KEY;
    if (!hasText(apiKey)) {
      throw new PlannerConfigurationError("OPENAI_API_KEY is required when PLANNER_PROVIDER=llm_openai.", {
        provider
      });
    }

    return createLlmPlanner({
      provider: createOpenAIProvider({
        client: dependencies.openaiClient ?? config.openai?.client,
        apiKey,
        model: config.openai?.model ?? config.OPENAI_MODEL ?? config.AI_PROVIDER_MODEL ?? DEFAULT_OPENAI_MODEL
      })
    });
  }

  throw new PlannerConfigurationError("Unsupported planner provider.", { provider });
}

function normalizeLlmProvider(value, plannerProvider) {
  if (plannerProvider === "llm_openai") {
    return "openai";
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return "mock";
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function assertKnownLlmProvider(provider) {
  if (!LLM_PROVIDERS.includes(provider)) {
    throw new PlannerConfigurationError("Unknown LLM provider.", {
      provider,
      supportedProviders: LLM_PROVIDERS
    });
  }
}
