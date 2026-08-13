import { LlmProviderError, createProviderTimeoutError } from "./provider-contract.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5";

export function createOpenAIProvider({
  client,
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  timeoutMs = 30000
} = {}) {
  return Object.freeze({
    id: "openai_provider",
    model,
    async generateStructuredPlan(input) {
      assertApiKey(apiKey);
      assertOpenAIClient(client);

      const response = await callOpenAIClient({
        client,
        model,
        input,
        timeoutMs
      });
      return extractStructuredPlan(response);
    }
  });
}

function assertApiKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new LlmProviderError("OpenAI API key is required for the OpenAI provider.", "API_KEY_MISSING");
  }
}

function assertOpenAIClient(client) {
  if (!client || typeof client !== "object" || typeof client.responses?.create !== "function") {
    throw new LlmProviderError("OpenAI provider requires an injected client.", "CLIENT_MISSING");
  }
}

async function callOpenAIClient({ client, model, input, timeoutMs }) {
  const payload = createOpenAIRequestPayload({ model, input });
  try {
    return await withTimeout(
      client.responses.create(payload),
      timeoutMs
    );
  } catch (cause) {
    if (cause instanceof LlmProviderError) {
      throw cause;
    }
    if (isTimeoutError(cause)) {
      throw createProviderTimeoutError({ provider: "openai" });
    }
    throw new LlmProviderError("OpenAI provider failed while generating a structured plan.", "PROVIDER_FAILURE", {
      provider: "openai",
      causeName: cause?.name ?? "Error",
      causeCode: cause?.code
    });
  }
}

export function createOpenAIRequestPayload({ model, input }) {
  return Object.freeze({
    model,
    input: [
      {
        role: "system",
        content: input.prompt?.system ?? ""
      },
      {
        role: "user",
        content: input.prompt?.user ?? ""
      }
    ],
    response_format: {
      type: "json_object"
    },
    metadata: {
      component: "llm_planner",
      output: input.output ?? "planner_contract_json"
    }
  });
}

function extractStructuredPlan(response) {
  const candidate =
    response?.structuredPlan ??
    response?.output_parsed ??
    response?.output?.[0]?.content?.[0]?.parsed ??
    response?.choices?.[0]?.message?.parsed ??
    response?.output_text ??
    response?.choices?.[0]?.message?.content;

  if (!candidate) {
    throw new LlmProviderError("OpenAI response did not include a structured plan.", "INVALID_RESPONSE");
  }

  if (typeof candidate === "string") {
    try {
      return JSON.parse(candidate);
    } catch {
      throw new LlmProviderError("OpenAI response structured plan could not be parsed.", "JSON_INVALID");
    }
  }

  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new LlmProviderError("OpenAI response structured plan is invalid.", "INVALID_RESPONSE");
  }

  return candidate;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createProviderTimeoutError({ provider: "openai" }));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function isTimeoutError(error) {
  return error?.code === "ETIMEDOUT" ||
    error?.name === "AbortError" ||
    error?.code === "PROVIDER_TIMEOUT";
}
