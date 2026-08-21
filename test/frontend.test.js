import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolRegistry,
  buildApi,
  createMockToolAdapter,
  createMvpTools,
  createToolDefinition,
  createToolInputSchema
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

test("Director frontend is served by the existing API server", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const response = await inject({ method: "GET", url: "/" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /Director IA/);
  assert.match(response.body, /Demande dirigeant/);
  assert.match(response.body, /Plan genere/);
  assert.match(response.body, /Actions necessitant votre validation/);
  assert.match(response.body, /Fais-moi le point sur mon entreprise aujourd'hui/);
  assert.match(response.body, /Qu'est-ce qui est urgent/);
  assert.match(response.body, /Combien dois-je encaisser cette semaine/);
  assert.match(response.body, /Quelles commandes risquent d'etre en retard/);
  assert.match(response.body, /Qu'est-ce que je dois commander/);
  assert.match(response.body, /Quels clients dois-je relancer/);
  assert.match(response.body, /Effectue le paiement de cette facture/);
  assert.match(response.body, /Voix indisponible en Phase 0/);
});

test("Director frontend assets connect only to existing Director and approval endpoints", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const scriptResponse = await inject({ method: "GET", url: "/app/app.js" });
  const styleResponse = await inject({ method: "GET", url: "/app/styles.css" });

  assert.equal(scriptResponse.statusCode, 200);
  assert.match(scriptResponse.headers["content-type"], /text\/javascript/);
  assert.match(scriptResponse.body, /\/api\/director\/requests/);
  assert.match(scriptResponse.body, /\/api\/approvals/);
  assert.match(scriptResponse.body, /CE QUI VA BIEN/);
  assert.match(scriptResponse.body, /RETARDS \/ PROBL/);
  assert.match(scriptResponse.body, /sourceProvider/);
  assert.match(scriptResponse.body, /sourceId/);
  assert.match(scriptResponse.body, /Community Manager/);
  assert.match(scriptResponse.body, /prepared_offline/);
  assert.doesNotMatch(scriptResponse.body, /openai|webhook|n8n/i);

  assert.equal(styleResponse.statusCode, 200);
  assert.match(styleResponse.headers["content-type"], /text\/css/);
  assert.match(styleResponse.body, /grid-template-columns/);
  assert.match(styleResponse.body, /director-sections/);
  assert.match(styleResponse.body, /agent-roster/);
});

test("Director cockpit API scenarios cover global, finance, production, purchasing, and multi-agent requests", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  // agents lists one entry per step. Since Lot 2C commit 4 finance, commercial,
  // production and purchasing each contribute two, so they appear twice.
  const scenarios = [
    {
      message: "Fais-moi le point sur mon entreprise aujourd'hui.",
      agents: [
        "finance",
        "finance",
        "commercial",
        "commercial",
        "production",
        "production",
        "purchasing",
        "purchasing",
        "hr",
        "after_sales",
        "marketing",
        "community_manager",
        "legal"
      ]
    },
    {
      message: "Combien dois-je encaisser cette semaine ?",
      agents: ["finance", "finance"]
    },
    {
      message: "Quelles commandes risquent d'etre en retard ?",
      agents: ["production", "production"]
    },
    {
      message: "Qu'est-ce que je dois commander ?",
      agents: ["purchasing", "purchasing"]
    },
    {
      message: "Quels clients dois-je relancer et quelles actions marketing proposes-tu ?",
      agents: ["commercial", "commercial", "marketing"]
    }
  ];

  for (const scenario of scenarios) {
    const body = await postDirector(inject, scenario.message);
    assert.equal(body.status, "completed", scenario.message);
    assert.deepEqual(body.results.map((result) => result.agent), scenario.agents, scenario.message);
    assert.deepEqual(Object.keys(body.summary.minimumSections), [
      "CE QUI VA BIEN",
      "RETARDS / PROBLEMES",
      "A ENCAISSER",
      "A COMMANDER",
      "RISQUES / BLOCAGES",
      "DECISIONS NECESSAIRES",
      "CE QUI NECESSITE UNE ACTION COMMERCIALE",
      "CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION",
      "CE QUI NECESSITE UNE INTERVENTION SAV",
      "CE QUI PRESENTE UN RISQUE JURIDIQUE"
    ]);
    assert.equal(body.summary.domainSources.every((entry) =>
      entry.domain &&
      entry.dataSource &&
      entry.sourceProvider &&
      entry.sourceId
    ), true, scenario.message);
  }
});

test("Director cockpit API reports partial responses without hiding successful agent results", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    toolRegistry: createProductionFailureRegistry()
  });
  t.after(() => app.close());

  const body = await postDirector(inject, "Fais-moi le point complet de l'entreprise aujourd'hui.");

  assert.equal(body.status, "partial");
  assert.equal(body.results.some((result) => result.agent === "finance" && result.status === "completed"), true);
  assert.equal(body.results.some((result) => result.agent === "production" && result.status === "failed"), true);
  assert.match(body.summary.headline, /Missing: production/);
});

test("Director cockpit approval flow exposes pending approval, supports rejection, and prevents pre-approval execution", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const body = await postDirector(inject, "Effectue le paiement de cette facture.", {
    approvalGranted: true
  });

  assert.equal(body.status, "requires_approval");
  assert.equal(body.results[0].status, "not_executed");
  assert.equal(body.audit.some((event) => event.type === "approval_requested"), true);
  assert.equal(body.audit.some((event) => event.type === "tool_called"), false);

  const approvalsResponse = await inject({ method: "GET", url: "/api/approvals" });
  const approvalsBody = JSON.parse(approvalsResponse.body);
  assert.equal(approvalsResponse.statusCode, 200);
  assert.equal(approvalsBody.approvals.length, 1);
  assert.equal(approvalsBody.approvals[0].requestedAction, "execute_invoice_payment");

  const rejectResponse = await inject({
    method: "POST",
    url: `/api/approvals/${approvalsBody.approvals[0].id}/reject`,
    payload: {
      decisionReason: "Rejected from cockpit test."
    }
  });
  const rejectBody = JSON.parse(rejectResponse.body);
  assert.equal(rejectResponse.statusCode, 200);
  assert.equal(rejectBody.approval.status, "rejected");

  const events = await repository.listAuditEvents({ requestId: body.requestId });
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

async function postDirector(inject, message, extraPayload = {}) {
  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message, ...extraPayload }
  });
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body);
}

function createProductionFailureRegistry() {
  const registry = new ToolRegistry();
  for (const tool of createMvpTools()) {
    if (tool.id !== "get_delayed_production_orders") {
      registry.register(tool);
    }
  }

  const inputSchema = createToolInputSchema({
    required: ["requestId"],
    properties: {
      requestId: { type: "string" }
    }
  });
  registry.register(createToolDefinition({
    id: "get_delayed_production_orders",
    name: "Get Delayed Production Orders",
    description: "Failing local test tool for partial cockpit response.",
    category: "production",
    requiredPermission: "read_analyze",
    allowedAgents: ["production"],
    inputSchema,
    adapter: createMockToolAdapter({
      toolId: "get_delayed_production_orders",
      inputSchema,
      resolve: async () => {
        throw new Error("Production demo source unavailable.");
      }
    })
  }));
  return registry;
}
