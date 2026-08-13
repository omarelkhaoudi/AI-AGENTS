import { redact } from "../observability/logger.js";

export class LlmProviderError extends Error {
  constructor(message, code = "PROVIDER_FAILURE", details = {}) {
    super(message);
    this.name = "LlmProviderError";
    this.code = code;
    this.details = redact(details);
  }
}

export function validateLlmProvider(provider) {
  const errors = [];
  if (!provider || typeof provider !== "object") {
    errors.push("provider must be an object");
  }
  if (typeof provider?.generateStructuredPlan !== "function") {
    errors.push("generateStructuredPlan must be a function");
  }

  if (errors.length > 0) {
    throw new LlmProviderError("LLM provider contract is invalid.", "PROVIDER_MISSING", { errors });
  }

  return true;
}

export async function generateStructuredPlanWithProvider(provider, input) {
  validateLlmProvider(provider);

  try {
    return await provider.generateStructuredPlan(input);
  } catch (cause) {
    if (cause instanceof LlmProviderError) {
      throw cause;
    }

    throw new LlmProviderError("LLM provider failed while generating a structured plan.", "PROVIDER_FAILURE", {
      causeName: cause?.name ?? "Error",
      causeCode: cause?.code
    });
  }
}

export function createProviderTimeoutError(details = {}) {
  return new LlmProviderError("LLM provider timed out while generating a structured plan.", "PROVIDER_TIMEOUT", details);
}
