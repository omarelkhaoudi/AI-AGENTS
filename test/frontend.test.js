import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi } from "../src/index.js";

test("Director frontend is served by the existing API server", async (t) => {
  const app = buildApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/" });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.body, /Director IA/);
  assert.match(response.body, /Demande dirigeant/);
  assert.match(response.body, /Plan genere/);
  assert.match(response.body, /Actions necessitant votre validation/);
  assert.match(response.body, /Fais-moi le point complet de l'entreprise aujourd'hui/);
  assert.match(response.body, /Effectue le paiement de cette facture/);
});

test("Director frontend assets connect only to existing Director and approval endpoints", async (t) => {
  const app = buildApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const scriptResponse = await app.inject({ method: "GET", url: "/app/app.js" });
  const styleResponse = await app.inject({ method: "GET", url: "/app/styles.css" });

  assert.equal(scriptResponse.statusCode, 200);
  assert.match(scriptResponse.headers["content-type"], /text\/javascript/);
  assert.match(scriptResponse.body, /\/api\/director\/requests/);
  assert.match(scriptResponse.body, /\/api\/approvals/);
  assert.doesNotMatch(scriptResponse.body, /openai|webhook|n8n/i);

  assert.equal(styleResponse.statusCode, 200);
  assert.match(styleResponse.headers["content-type"], /text\/css/);
  assert.match(styleResponse.body, /grid-template-columns/);
});
