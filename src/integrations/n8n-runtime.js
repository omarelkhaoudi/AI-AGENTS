import { createN8nClient } from "./n8n-client.js";

// Where the running application turns configuration into a usable n8n client.
// It is deliberately separate from n8n-client.js: that file is a pure HTTP
// client whose settings are injected, and it must stay unaware of environment
// variables. This one is the only place that reads them.
//
// The token is the reason this function exists. createN8nConfig reports
// hasApiKey and never the value, precisely so the configuration object can be
// logged or serialised safely. Reading N8N_API_KEY here keeps that promise: the
// value goes straight into the client closure, is never returned, never stored
// on the config, and never becomes a property of anything.
//
// Returning null is the offline answer. With the boundary off there is no client
// at all, so the outbound tool is never registered and no call can be attempted.
export function createN8nClientFromConfig(config, env = process.env) {
  if (config?.workflow?.enabled !== true) {
    return null;
  }

  // createWorkflowConfig already refuses enabled: true on any other provider, so
  // this is a second reading of the same rule rather than a new one.
  if (config.workflow.provider !== "n8n") {
    return null;
  }

  return createN8nClient({
    baseUrl: config.workflow.baseUrl,
    webhookPath: config.n8n?.webhookPath,
    apiKeyHeader: config.n8n?.apiKeyHeader,
    apiKey: env.N8N_API_KEY,
    timeoutMs: config.n8n?.timeoutMs
  });
}
