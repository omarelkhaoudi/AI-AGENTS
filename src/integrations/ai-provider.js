export class AiProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiProviderError";
  }
}

export function createAiProviderConfig({
  provider = process.env.AI_PROVIDER ?? "none",
  apiKey = process.env.AI_PROVIDER_API_KEY,
  model = process.env.AI_PROVIDER_MODEL ?? null,
  enabled = false
} = {}) {
  if (enabled && (!apiKey || apiKey.trim().length === 0)) {
    throw new AiProviderError("AI provider API key is required when provider calls are enabled.");
  }

  return Object.freeze({
    provider,
    model,
    enabled,
    hasApiKey: Boolean(apiKey)
  });
}

export class AiProviderClient {
  constructor(config = createAiProviderConfig()) {
    this.config = config;
  }

  async generate() {
    throw new AiProviderError("AI provider calls are not implemented in Phase 0.");
  }
}
