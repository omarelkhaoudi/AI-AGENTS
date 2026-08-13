import { LlmProviderError, createProviderTimeoutError } from "./provider-contract.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5";

export function createOpenAIProvider({
  client,
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  timeoutMs = 30000,
  clientFactory = createDefaultOpenAIClient
} = {}) {
  let resolvedClient = client ?? null;

  return Object.freeze({
    id: "openai_provider",
    model,
    async generateStructuredPlan(input) {
      assertApiKey(apiKey);
      resolvedClient ??= await clientFactory({ apiKey });
      assertOpenAIClient(resolvedClient);

      const response = await callOpenAIClient({
        client: resolvedClient,
        model,
        input,
        timeoutMs
      });
      return extractStructuredPlan(response);
    }
  });
}

export async function createDefaultOpenAIClient({ apiKey } = {}) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey });
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
    instructions: input.prompt?.system ?? "",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: input.prompt?.user ?? ""
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "ai_agents_planner_plan",
        strict: false,
        schema: createPlannerPlanJsonSchema()
      }
    },
    metadata: {
      component: "llm_planner",
      output: input.output ?? "planner_contract_json"
    }
  });
}

function createPlannerPlanJsonSchema() {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["version", "requestId", "intent", "summary", "planner", "agents", "steps", "metadata"],
    properties: {
      version: { type: "string", const: "1" },
      requestId: { type: "string", minLength: 1 },
      intent: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
      planner: { type: "string", minLength: 1 },
      agents: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1
      },
      steps: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "agentId",
            "sequence",
            "actionKind",
            "actionType",
            "toolName",
            "resource",
            "reason",
            "input",
            "requiresApproval"
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            agentId: { type: "string", minLength: 1 },
            sequence: { type: "integer", minimum: 1 },
            actionKind: {
              type: "string",
              enum: ["read_analyze", "prepare_action", "execute_action", "human_approval_required"]
            },
            actionType: { type: "string", minLength: 1 },
            toolName: { type: "string", minLength: 1 },
            resource: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1 },
            input: {
              type: "object",
              additionalProperties: true
            },
            requiresApproval: { type: "boolean" }
          }
        }
      },
      metadata: {
        type: "object",
        additionalProperties: true
      }
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
