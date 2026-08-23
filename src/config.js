import { createAiProviderConfig } from "./integrations/ai-provider.js";
import { createWorkflowConfig } from "./integrations/workflow-boundary.js";
import { createN8nConfig } from "./integrations/n8n-config.js";
import { createBusinessMemoryConfig } from "./business-memory/repository-factory.js";
import { createPlannerConfig } from "./director/planner-factory.js";
import { createSecurityConfig } from "./security/security-config.js";

export function loadFoundationConfig(env = process.env) {
  const workflowsEnabled = env.WORKFLOW_ENABLED === "true";
  const workflowProvider = env.WORKFLOW_PROVIDER ?? "mock";
  const aiEnabled = env.AI_PROVIDER_ENABLED === "true";
  const databaseUrl = env.DATABASE_URL;

  return Object.freeze({
    environment: env.NODE_ENV ?? "development",
    database: Object.freeze({
      provider: "postgresql",
      enabled: Boolean(databaseUrl),
      hasUrl: Boolean(databaseUrl)
    }),
    security: createSecurityConfig(env),
    businessMemory: createBusinessMemoryConfig(env),
    aiProvider: createAiProviderConfig({
      provider: env.AI_PROVIDER ?? "openai",
      apiKey: env.AI_PROVIDER_API_KEY,
      model: env.AI_PROVIDER_MODEL ?? null,
      enabled: aiEnabled
    }),
    planner: createPlannerConfig(env),
    workflow: createWorkflowConfig({
      provider: workflowProvider,
      baseUrl: env.WORKFLOW_BASE_URL,
      enabled: workflowsEnabled
    }),
    // n8n settings are only required once the boundary is actually enabled
    // for n8n: an application running on the mock provider must start with
    // none of them configured.
    n8n: createN8nConfig(env, { enabled: workflowsEnabled && workflowProvider === "n8n" })
  });
}
