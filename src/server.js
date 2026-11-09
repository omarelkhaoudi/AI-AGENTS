import { buildApi } from "./api/server.js";
import { loadFoundationConfig } from "./config.js";
import { createN8nClientFromConfig } from "./integrations/n8n-runtime.js";
import { loadDotEnvIfPresent } from "./load-dotenv.js";
import { createRepository } from "./persistence/repository-factory.js";
import { createMvpToolRegistry } from "./tools/mvp-tools.js";
import { createFilePlanStore } from "./agent/plan-store.js";
import { createFileConversationStore } from "./agent/conversation-store.js";
import { createFileWorkshopStore } from "./agent/workshop-book.js";
import { createFileCashBook } from "./agent/cash-book.js";
import { createFileImprovementBook } from "./agent/improvement-book.js";
import { createFileFollowUpBook } from "./agent/sales-book.js";
import { createFileTeamBook } from "./agent/team-book.js";
import { SPECIALIST_IDS } from "./agent/agent-team.js";
import { createFileWhatsAppInbox } from "./agent/whatsapp-inbox.js";

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

// The cash book (data/caisse.json), the anomalies and their rules
// (data/amelioration.json), and the team with its feed (data/equipe.json).
// An expense of HKIDS_EXPENSE_ALERT_DH or more (2 000 DH by default) waits
// for the direction's approval; its receipts go to data/justificatifs/.
const cashBook = createFileCashBook(Number(process.env.HKIDS_EXPENSE_ALERT_DH) > 0 ? { expenseThreshold: Number(process.env.HKIDS_EXPENSE_ALERT_DH) } : {});
const improvementBook = createFileImprovementBook();
const teamBook = createFileTeamBook({ agents: SPECIALIST_IDS });

// The quotes' follow-ups (data/relances.json). A quote with no news for
// HKIDS_FOLLOW_UP_DAYS days (5 by default) is to follow up.
const followUpBook = createFileFollowUpBook(Number(process.env.HKIDS_FOLLOW_UP_DAYS) > 0 ? { days: Number(process.env.HKIDS_FOLLOW_UP_DAYS) } : {});

// A late or blocked step is analysed by its agent as soon as it is found;
// HKIDS_AUTO_ANALYSIS=off leaves it for the direction to ask.
const autoAnalyseAnomalies = process.env.HKIDS_AUTO_ANALYSIS !== "off";

// What went through the company's WhatsApp Business number (data/whatsapp.json).
// The number itself is configured by the WHATSAPP_* keys of .env.
const whatsAppStore = createFileWhatsAppInbox();

const app = buildApi({ repository, config, toolRegistry, planStore, conversationStore, workshopStore, cashBook, improvementBook, teamBook, followUpBook, autoAnalyseAnomalies, whatsAppStore });

// Every half hour, the workshop book is read for steps that became late, and
// the quotes for follow-ups that became due.
const sweep = setInterval(() => {
  app.sweepAnomalies().catch((error) => app.log.error(error));
  app.sweepFollowUps().catch((error) => app.log.error(error));
}, 30 * 60 * 1000);
sweep.unref();

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
