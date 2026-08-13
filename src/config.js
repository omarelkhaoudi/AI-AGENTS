import { createAiProviderConfig } from "./integrations/ai-provider.js";
import { createWorkflowConfig } from "./integrations/workflow-boundary.js";

export function loadFoundationConfig(env = process.env) {
  const workflowsEnabled = env.WORKFLOW_ENABLED === "true";
  const aiEnabled = env.AI_PROVIDER_ENABLED === "true";
  const databaseUrl = env.DATABASE_URL;

  return Object.freeze({
    environment: env.NODE_ENV ?? "development",
    database: Object.freeze({
      provider: "postgresql",
      enabled: Boolean(databaseUrl),
      hasUrl: Boolean(databaseUrl)
    }),
    aiProvider: createAiProviderConfig({
      provider: env.AI_PROVIDER ?? "openai",
      apiKey: env.AI_PROVIDER_API_KEY,
      model: env.AI_PROVIDER_MODEL ?? null,
      enabled: aiEnabled
    }),
    workflow: createWorkflowConfig({
      provider: env.WORKFLOW_PROVIDER ?? "n8n",
      baseUrl: env.WORKFLOW_BASE_URL,
      enabled: workflowsEnabled
    })
  });
}
