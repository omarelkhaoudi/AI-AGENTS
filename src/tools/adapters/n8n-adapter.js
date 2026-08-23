import { validateToolInput } from "../contract.js";
import { ToolAdapterError, createToolAdapter } from "./contract.js";
import { WorkflowBoundaryError } from "../../integrations/workflow-boundary.js";
import { WORKFLOW_EVENT_TYPES, createWorkflowEvent, validateWorkflowEvent } from "../../workflows/contract.js";

// The adapter reimplements no control. It is an ordinary tool adapter, of the
// same contract as the mock one, so reaching it means having passed everything
// that guards a tool: allowed agents, required permission, security domains and
// human approval. Being passive is the whole point.
//
// The client is injected rather than built here: that keeps the token out of
// this layer and lets tests run without a network.
export function createN8nToolAdapter({ toolId, eventType, inputSchema, client, metadata = {} } = {}) {
  if (!WORKFLOW_EVENT_TYPES.includes(eventType)) {
    throw new ToolAdapterError(`Unknown workflow event type: ${eventType}`, "N8N_EVENT_TYPE_UNKNOWN", {
      toolId,
      eventType,
      supportedEventTypes: [...WORKFLOW_EVENT_TYPES]
    });
  }

  if (typeof client?.postWorkflowEvent !== "function") {
    throw new ToolAdapterError("An n8n client is required to build the adapter.", "N8N_CLIENT_REQUIRED", {
      toolId,
      eventType
    });
  }

  return createToolAdapter({
    toolId,
    kind: "n8n",

    validateInput(input) {
      validateToolInput(inputSchema, input);
      return true;
    },

    async execute(context, input) {
      // An execution id exists only when the call came through
      // ToolExecutionService, which is what creates the Execution row and the
      // audit trail. Without one there is nothing to correlate a workflow run
      // to, so no call is made and no replacement identifier is invented: an
      // orphan run in n8n would be worse than a refusal here.
      const executionId = context?.executionId;
      if (typeof executionId !== "string" || executionId.trim() === "") {
        throw new ToolAdapterError(
          "An n8n workflow call requires an execution to correlate to.",
          "N8N_EXECUTION_CONTEXT_REQUIRED",
          { toolId, eventType }
        );
      }

      const correlationId = executionId;
      const event = createWorkflowEvent({
        // Derived, never random: the same execution always names the same event.
        id: `${executionId}:${eventType}`,
        type: eventType,
        correlationId,
        agentId: context.agentId,
        requestId: context.requestId ?? null,
        payload: { ...input },
        metadata: { toolId, ...metadata }
      });

      // createWorkflowEvent only checks the envelope. The workflow contract also
      // says which agents may raise this event and which payload fields it must
      // carry, and neither is verified anywhere else on this path. Checking it
      // here means a malformed or unauthorized event never leaves the building.
      try {
        validateWorkflowEvent(event);
      } catch (cause) {
        throw new ToolAdapterError(
          "The workflow event does not satisfy its contract.",
          "N8N_WORKFLOW_EVENT_INVALID",
          { toolId, eventType, correlationId, contractCode: cause?.code ?? null }
        );
      }

      let result;
      try {
        result = await client.postWorkflowEvent(event);
      } catch (cause) {
        // The boundary reports its own failures; the adapter reports that a tool
        // could not do its work. Details are allow listed, never spread: the
        // client has already sanitized the url and redacted the body, and the
        // raw fetch message was dropped there.
        if (cause instanceof WorkflowBoundaryError) {
          throw new ToolAdapterError("The n8n workflow call failed.", "N8N_WORKFLOW_CALL_FAILED", {
            toolId,
            eventType,
            correlationId,
            boundaryCode: cause.code,
            url: cause.details?.url ?? null,
            httpStatus: cause.details?.httpStatus ?? null,
            durationMs: cause.details?.durationMs ?? null,
            body: cause.details?.body ?? null
          });
        }
        throw cause;
      }

      return {
        provider: "n8n",
        eventType,
        correlationId,
        eventId: event.id,
        requestId: event.requestId,
        agentId: event.agentId,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        output: result.body
      };
    },

    getMetadata() {
      return {
        provider: "n8n",
        eventType,
        externalConnection: "http_webhook",
        ...metadata
      };
    }
  });
}
