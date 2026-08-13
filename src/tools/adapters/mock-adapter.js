import { validateToolInput } from "../contract.js";
import { createToolAdapter } from "./contract.js";

export function createMockToolAdapter({
  toolId,
  inputSchema,
  metadata = {},
  resolve
} = {}) {
  return createToolAdapter({
    toolId,
    kind: "mock",
    validateInput(input) {
      validateToolInput(inputSchema, input);
      return true;
    },
    async execute(context, input) {
      return resolve(context, input);
    },
    getMetadata() {
      return {
        provider: "local_mock",
        demo: true,
        ...metadata
      };
    }
  });
}
