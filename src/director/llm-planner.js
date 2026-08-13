import { LlmProviderError, generateStructuredPlanWithProvider } from "../llm/provider-contract.js";
import { redact } from "../observability/logger.js";
import { createMvpToolRegistry } from "../tools/mvp-tools.js";
import { buildPlannerPrompt } from "./planner-prompt.js";
import {
  PlannerContractError,
  createPlanner,
  normalizePlannerPlan,
  normalizePlannerRequest,
  validatePlannerPlan
} from "./planner-contract.js";

export class LlmPlannerError extends Error {
  constructor(message, code = "LLM_PLAN_INVALID", details = {}) {
    super(message);
    this.name = "LlmPlannerError";
    this.code = code;
    this.details = redact(details);
  }
}

export function createLlmPlanner({
  provider,
  id = "llm_planner",
  toolRegistry = null,
  promptBuilder = buildPlannerPrompt
} = {}) {
  return createPlanner({
    id,
    kind: "llm",
    description: "LLM planner boundary that produces structured plans without executing tools.",
    plan: async ({ request, repository }) => {
      if (!provider) {
        throw new LlmPlannerError("LLM planner requires a provider.", "PROVIDER_MISSING");
      }

      const normalizedRequest = normalizePlannerRequest(request);
      const registry = toolRegistry ?? createMvpToolRegistry({ repository });
      const agents = await listAvailableAgents(repository);
      const tools = registry.list();
      const prompt = promptBuilder({
        request: normalizedRequest,
        agents,
        tools
      });
      const providerInput = Object.freeze({
        request: normalizedRequest,
        prompt,
        agents: agents.map((agent) => ({
          id: agent.id,
          role: agent.role,
          status: agent.status
        })),
        tools: tools.map((tool) => ({
          id: tool.id,
          name: tool.name,
          requiredPermission: tool.requiredPermission,
          allowedAgents: tool.allowedAgents
        })),
        output: "planner_contract_json"
      });

      const rawPlan = await requestStructuredPlan(provider, providerInput);
      const plan = normalizeProviderPlan(rawPlan, id);
      await validatePlanOrThrow(plan, { repository, toolRegistry: registry });
      return plan;
    }
  });
}

async function requestStructuredPlan(provider, providerInput) {
  try {
    return await generateStructuredPlanWithProvider(provider, providerInput);
  } catch (error) {
    if (error instanceof LlmProviderError) {
      throw new LlmPlannerError("LLM provider could not generate a structured plan.", error.code, error.details);
    }
    throw error;
  }
}

function normalizeProviderPlan(rawPlan, plannerId) {
  let parsed = rawPlan;
  if (typeof rawPlan === "string") {
    try {
      parsed = JSON.parse(rawPlan);
    } catch {
      throw new LlmPlannerError("LLM provider returned invalid JSON.", "JSON_INVALID");
    }
  }

  try {
    return normalizePlannerPlan({
      ...parsed,
      metadata: {
        ...(parsed?.metadata ?? {}),
        source: "llm_provider"
      }
    }, { id: plannerId });
  } catch (cause) {
    if (cause instanceof PlannerContractError) {
      throw new LlmPlannerError("LLM provider returned an invalid plan.", "LLM_RESPONSE_INVALID", cause.details);
    }
    throw cause;
  }
}

async function validatePlanOrThrow(plan, { repository, toolRegistry }) {
  try {
    await validatePlannerPlan(plan, { repository, toolRegistry });
  } catch (cause) {
    if (cause instanceof PlannerContractError) {
      throw new LlmPlannerError("LLM provider returned a plan rejected by validation.", mapPlanValidationCode(cause), cause.details);
    }
    throw cause;
  }
}

async function listAvailableAgents(repository) {
  if (!repository || typeof repository.listAgents !== "function") {
    return [];
  }
  return repository.listAgents();
}

function mapPlanValidationCode(error) {
  const details = Array.isArray(error.details?.errors) ? error.details.errors.join(" ") : "";
  if (details.includes("agent")) {
    return "AGENT_UNKNOWN";
  }
  if (details.includes("toolName")) {
    return details.includes("required") ? "STEP_INCOMPLETE" : "TOOL_UNKNOWN";
  }
  if (details.includes("steps") || details.includes("actionType") || details.includes("actionKind") || details.includes("input")) {
    return "STEP_INCOMPLETE";
  }
  return "PLAN_INVALID";
}
