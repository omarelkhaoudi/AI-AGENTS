import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 31 is the first deliverable: the ten headings the Director must
// answer with when asked for the state of the company.
const CDC_SECTIONS = Object.freeze([
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

// The six original keys are frozen: this lot adds headings, it does not rename
// any, and a caller reading the report must not have to change.
const ORIGINAL_SECTIONS = Object.freeze(CDC_SECTIONS.slice(0, 6));

// What each heading held before this lot. A count moving here means the four
// additions changed what the six were reporting.
const ORIGINAL_COUNTS = Object.freeze({
  "CE QUI VA BIEN": 1,
  "RETARDS / PROBLEMES": 4,
  "A ENCAISSER": 2,
  "A COMMANDER": 4,
  "RISQUES / BLOCAGES": 13,
  "DECISIONS NECESSAIRES": 11
});

async function companyOverview() {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: "Fais-moi le point sur mon entreprise aujourd'hui." }
  });
  assert.equal(response.statusCode, 201);
  return { body: JSON.parse(response.body), close: () => app.close() };
}

test("the Director answers with the ten headings CDC section 31 asks for", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.deepEqual(Object.keys(body.summary.minimumSections), CDC_SECTIONS);
});

test("the six original headings keep their exact wording", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.deepEqual(Object.keys(body.summary.minimumSections).slice(0, 6), ORIGINAL_SECTIONS);
});

test("the six original headings report exactly what they reported before", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const [name, expected] of Object.entries(ORIGINAL_COUNTS)) {
    assert.equal(body.summary.minimumSections[name].length, expected, name);
  }
});

test("every heading carries at least one entry on the company overview", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const name of CDC_SECTIONS) {
    assert.ok(body.summary.minimumSections[name].length > 0, `${name} is empty`);
  }
});

// The four additions come from agents that already answered. Each one must
// report its own agent's work and nothing else.
test("each new heading reports the agents it is about", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const agentsOf = (name) => [
    ...new Set(body.summary.minimumSections[name].map((entry) => entry.agent))
  ].sort();

  assert.deepEqual(agentsOf("CE QUI NECESSITE UNE ACTION COMMERCIALE"), ["commercial"]);
  assert.deepEqual(agentsOf("CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION"), [
    "community_manager",
    "marketing"
  ]);
  assert.deepEqual(agentsOf("CE QUI NECESSITE UNE INTERVENTION SAV"), ["after_sales"]);
  assert.deepEqual(agentsOf("CE QUI PRESENTE UN RISQUE JURIDIQUE"), ["legal"]);
});

test("the new headings read as business statements, like the others", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const name of CDC_SECTIONS.slice(6)) {
    for (const entry of body.summary.minimumSections[name]) {
      const label = entry.label ?? entry.reason;
      assert.equal(typeof label, "string", name);
      assert.ok(label.trim().length > 0, name);
      assert.equal(label.includes("undefined"), false, `${name}: ${label}`);
      assert.equal(label.includes("[object Object]"), false, `${name}: ${label}`);
    }
  }
});

// Nothing was derived: the additions expose sections the summary already
// computed, so they must match them entry for entry.
test("the new headings expose sections the report already computed", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const { minimumSections, afterSales, legal, commercial, marketingCommunication } = body.summary;

  assert.deepEqual(minimumSections["CE QUI NECESSITE UNE INTERVENTION SAV"], afterSales);
  assert.deepEqual(minimumSections["CE QUI PRESENTE UN RISQUE JURIDIQUE"], legal);
  assert.deepEqual(minimumSections["CE QUI NECESSITE UNE ACTION COMMERCIALE"], commercial);
  assert.deepEqual(
    minimumSections["CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION"],
    marketingCommunication
  );
});

test("the headline and the aggregates are untouched by the added headings", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.match(body.summary.headline, /Point complete: 9\/9 agents responded/);
  assert.match(body.summary.headline, /9 high-priority demo signal\(s\)/);
  assert.deepEqual(body.summary.aggregates.payments.totalsByCurrency, { MAD: 20500 });
  assert.equal(body.results.length, 13);
});

// A heading the Director answers but the cockpit does not list is a heading the
// reader never sees.
test("the cockpit lists the ten headings the Director answers", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const script = await inject({ method: "GET", url: "/app/app.js" });

  assert.equal(script.statusCode, 200);
  for (const name of CDC_SECTIONS) {
    assert.ok(script.body.includes(name), `the cockpit must list ${name}`);
  }
});
