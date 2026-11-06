import { buildApi } from "./api/server.js";
import { loadFoundationConfig } from "./config.js";
import { createN8nClientFromConfig } from "./integrations/n8n-runtime.js";
import { loadDotEnvIfPresent } from "./load-dotenv.js";
import { createRepository } from "./persistence/repository-factory.js";
import { createMvpToolRegistry } from "./tools/mvp-tools.js";
import { createFilePlanStore } from "./agent/plan-store.js";
import { createFileConversationStore } from "./agent/conversation-store.js";
import { createFileWorkshopStore } from "./agent/workshop-book.js";

// The first statement, because everything below reads process.env: the port, the
// configuration, the repository factory and the workflow client. Without this the
// file was never read at all, and a .env setting AUTH_MODE or WORKFLOW_ENABLED
// was silently ignored by the server while npm run db:seed honoured it.
//
// Imports are hoisted, so the modules above are evaluated before this runs. That
// is safe only because none of them reads process.env at import time; each reads
// it when called, below. Keep it that way.
loadDotEnvIfPresent();

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
const config = loadFoundationConfig();
const repository = await createRepository();

// The workflow bridge is opened here or nowhere. With WORKFLOW_ENABLED off there
// is no client, so no registry is injected and buildApi keeps exactly the
// behaviour it had: twenty one tools, none of them able to leave the process.
const workflowClient = createN8nClientFromConfig(config);
const toolRegistry = workflowClient
  ? createMvpToolRegistry({ repository, workflowClient })
  : null;

// The Director's action plans are kept in data/ (ignored by git), so they
// survive a restart and can be followed over several days.
const planStore = createFilePlanStore(process.env.HKIDS_PLANS_PATH ? { path: process.env.HKIDS_PLANS_PATH } : {});

// The Director's conversations, under data/conversations/, so a restart does
// not make it forget what it was just told.
const conversationStore = createFileConversationStore();

// The workshop book, in data/atelier.json: what happened to each order.
const workshopStore = createFileWorkshopStore();

const app = buildApi({ repository, config, toolRegistry, planStore, conversationStore, workshopStore });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await repository.disconnect();
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
