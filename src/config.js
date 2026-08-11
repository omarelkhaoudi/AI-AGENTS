import { createAiProviderConfig } from "./integrations/ai-provider.js";
import { createWorkflowConfig } from "./integrations/workflow-boundary.js";

export function loadFoundationConfig(env = process.env) {
  const workflowsEnabled = env.WORKFLOW_ENABLED === "true";
  const aiEnabled = env.AI_PROVIDER_ENABLED === "true";

  return Object.freeze({
    environment: env.NODE_ENV ?? "development",
    aiProvider: createAiProviderConfig({
      provider: env.AI_PROVIDER ?? "none",
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
