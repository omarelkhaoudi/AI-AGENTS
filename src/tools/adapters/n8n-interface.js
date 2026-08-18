export const N8N_TOOL_ADAPTER_INTERFACE = Object.freeze({
  kind: "n8n",
  status: "contract_prepared_not_connected",
  requiredOptions: Object.freeze([
    "toolId",
    "workflowId",
    "inputSchema"
  ]),
  optionalFutureOptions: Object.freeze([
    "baseUrl",
    "webhookPath"
  ]),
  externalConnectionsEnabled: false,
  webhookEnabled: false,
  requiredMethods: Object.freeze([
    "validateInput(input)",
    "execute(context, input)",
    "getMetadata()"
  ]),
  notes: "Future N8nToolAdapter must implement the generic ToolAdapter contract, stay behind ToolRegistry and ToolExecutionService, and never bypass approvals."
});
