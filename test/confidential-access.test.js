import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { buildApi } from "../src/api/server.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { cashBalance, directorBriefing, recordCash } from "../src/agent/company-tools.js";
import { createMemoryCashBook } from "../src/agent/cash-book.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { createApiTokenMaterial } from "../src/security/api-token.js";
import { hashPassword } from "../src/security/password.js";

// CDC recette scenario 7: a person without the right cannot see the salaries,
// the confidential expenses, nor the data of another company. Invented people
// and figures only.

const clock = () => new Date("2026-11-09T10:00:00Z");
const RECEIPT = `data:image/png;base64,${Buffer.from("not really a png, enough for the book").toString("base64")}`;

async function account(repository, { id, role, companyId = undefined }) {
  await repository.upsertUser({ id, name: id, email: `${id}@exemple.ma`, role, status: "active", metadata: companyId === undefined ? {} : { companyId } });
  const material = createApiTokenMaterial({ userId: id, name: `${id}-token` });
  await repository.createApiToken(material.record);
  return { authorization: `Bearer ${material.secret}` };
}

async function setUp(t) {
  const repository = new InMemoryRepository();
  const cashBook = createMemoryCashBook({ clock });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const app = buildApi({ repository, cashBook, teamBook, clock, companyId: "hkids" });
  t.after(() => app.close());
  const as = {
    hiba: await account(repository, { id: "hiba", role: "leader", companyId: "hkids" }),
    assistant: await account(repository, { id: "assistante", role: "approver", companyId: "hkids" }),
    legacy: await account(repository, { id: "ancien-compte", role: "operator" }),
    other: await account(repository, { id: "patron-autre", role: "leader", companyId: "menuiserie-atlas" })
  };
  const call = (who, options) => app.inject({ ...options, headers: { ...as[who], ...(options.headers ?? {}) } });
  return { app, repository, cashBook, teamBook, call };
}

test("a salary is masked for whoever is not the direction, and still counted in the cash", async (t) => {
  const { call, teamBook } = await setUp(t);
  assert.equal((await call("hiba", { method: "POST", url: "/api/cash", payload: { kind: "entree", amount: 10000, category: "solde_depart", method: "especes" } })).statusCode, 201);
  const salary = await call("hiba", { method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 4200, category: "salaire", label: "Salaire d'octobre", party: "Samir", method: "especes" } });
  assert.equal(salary.statusCode, 201, salary.body);
  assert.equal(salary.json().entry.confidential, true);
  const secret = await call("hiba", { method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 900, category: "autre_sortie", label: "Avance sur salaire", party: "Karim", method: "especes", confidential: true } });
  assert.equal(secret.json().entry.confidential, true);
  await call("hiba", { method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 300, category: "transport", label: "Livraison", method: "especes" } });

  // The direction sees everything.
  const direction = (await call("hiba", { method: "GET", url: "/api/cash" })).json();
  assert.equal(direction.confidential, true);
  assert.ok(direction.day.entries.some((entry) => entry.party === "Samir" && entry.amount === 4200));
  assert.ok(direction.month.byCategory.some((entry) => entry.label === "Salaires" && entry.amount === 4200));

  // The assistant sees that money went out, never what nor for whom.
  const assistant = (await call("assistant", { method: "GET", url: "/api/cash" })).json();
  const text = JSON.stringify(assistant);
  assert.equal(assistant.confidential, false);
  for (const hidden of ["Samir", "Karim", "Salaire d'octobre", "Avance sur salaire", "4200", "900"]) {
    assert.ok(!text.includes(hidden), `${hidden} must not reach the assistant`);
  }
  const masked = assistant.day.entries.filter((entry) => entry.masked);
  assert.equal(masked.length, 2);
  assert.deepEqual(masked.map((entry) => [entry.amount, entry.label]), [[null, "Dépense confidentielle"], [null, "Dépense confidentielle"]]);
  assert.ok(assistant.day.entries.some((entry) => entry.label === "Livraison" && entry.amount === 300), "the other expenses stay visible");
  assert.equal(assistant.day.closing, direction.day.closing, "the cash in hand is the same for everyone");
  assert.ok(assistant.month.byCategory.some((entry) => entry.label === "Dépenses confidentielles" && entry.count === 2));
  assert.ok(!assistant.month.byCategory.some((entry) => entry.label === "Salaires"), "no total tells the salaries apart");

  // The team feed, read by everyone, says no more.
  const feed = JSON.stringify(await teamBook.activity({ limit: 50 }));
  assert.ok(!feed.includes("Samir") && !feed.includes("4200"));
  assert.match(feed, /Sortie confidentielle n° 2 saisie au cockpit/);
});

test("the confidential lines are refused line by line to whoever is not the direction", async (t) => {
  const { call, cashBook } = await setUp(t);
  const salary = (await call("hiba", { method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 4200, category: "salaire", label: "Salaire d'octobre", party: "Samir", method: "especes" } })).json().entry;
  const receipt = await call("hiba", { method: "POST", url: `/api/cash/${salary.number}/receipts`, payload: { data: RECEIPT, name: "fiche-de-paie.png" } });
  assert.equal(receipt.statusCode, 201, receipt.body);
  const receiptId = receipt.json().entry.receipts[0].id;

  const refused = [
    { method: "GET", url: `/api/cash/${salary.number}/receipts/${receiptId}` },
    { method: "POST", url: `/api/cash/${salary.number}/approve`, payload: {} },
    { method: "POST", url: `/api/cash/${salary.number}/reconcile`, payload: {} },
    { method: "POST", url: `/api/cash/${salary.number}/cancel`, payload: { reason: "erreur" } },
    { method: "POST", url: `/api/cash/${salary.number}/receipts`, payload: { data: RECEIPT, name: "autre.png" } },
    { method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 3000, category: "salaire", label: "Salaire", method: "especes" } },
    { method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 500, category: "autre_sortie", label: "Prime", method: "especes", confidential: true } }
  ];
  for (const request of refused) {
    const response = await call("assistant", request);
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`);
  }
  assert.equal((await cashBook.entries()).length, 1, "nothing was recorded nor cancelled by the assistant");
  assert.equal((await call("hiba", { method: "GET", url: `/api/cash/${salary.number}/receipts/${receiptId}` })).statusCode, 200);
  assert.equal((await call("hiba", { method: "POST", url: `/api/cash/${salary.number}/approve`, payload: {} })).statusCode, 200);

  // An ordinary expense stays the assistant's to handle.
  const delivery = (await call("hiba", { method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 300, category: "transport", label: "Livraison", method: "especes" } })).json().entry;
  assert.equal((await call("assistant", { method: "POST", url: `/api/cash/${delivery.number}/receipts`, payload: { data: RECEIPT, name: "recu.png" } })).statusCode, 201);
});

test("an account of another company can neither sign in nor read anything here", async (t) => {
  const { call, repository } = await setUp(t);
  for (const url of ["/api/cash", "/api/workshop", "/api/improvement", "/api/team"]) {
    const response = await call("other", { method: "GET", url });
    assert.equal(response.statusCode, 401, url);
    assert.equal(response.json().error, "Authentication required.", "the answer does not tell why");
  }
  assert.equal((await call("hiba", { method: "GET", url: "/api/cash" })).statusCode, 200);
  assert.equal((await call("legacy", { method: "GET", url: "/api/cash" })).statusCode, 200, "an account made before companies belongs to this server");

  await repository.setUserPassword("patron-autre", await hashPassword("un mot de passe solide 2026"));
  await repository.setUserPassword("hiba", await hashPassword("un autre mot de passe 2026"));
  const login = (email, password) => call("hiba", { method: "POST", url: "/api/auth/login", payload: { email, password }, headers: { authorization: "" } });
  const refused = await login("patron-autre@exemple.ma", "un mot de passe solide 2026");
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.json().error, "Email ou mot de passe incorrect.");
  assert.equal((await login("hiba@exemple.ma", "un autre mot de passe 2026")).statusCode, 200);
});

test("the Director asked by a person without the right masks salaries in its answers and cannot record one", async () => {
  const books = { cash: createMemoryCashBook({ clock }), team: createMemoryTeamBook({ clock, agents: SPECIALIST_IDS }), improvement: createMemoryImprovementBook({ clock }) };
  const salary = await recordCash({ sens: "sortie", montant: 4200, categorie: "salaire", libelle: "Salaire d'octobre", moyen: "especes", tiers: "Samir", reference_devis: "", reference_bc: "", date: "", annonce_par: "direction", confirme_doublon: false, confidentiel: false }, { books, documentService: {} }, "finance");
  assert.equal(salary.ok, true);
  assert.match(salary.enregistre.confidentiel, /direction seule/);

  const forDirection = JSON.stringify(await cashBalance({ date: "", mois: "" }, { books }));
  assert.match(forDirection, /Samir/);
  const forOthers = JSON.stringify(await cashBalance({ date: "", mois: "" }, { books, confidential: false }));
  assert.ok(!forOthers.includes("Samir") && !forOthers.includes("Salaire d'octobre") && !forOthers.includes("Salaires"));
  assert.match(forOthers, /montant réservé à la direction/);

  const refused = await recordCash({ sens: "sortie", montant: 3000, categorie: "salaire", libelle: "Salaire", moyen: "especes", tiers: "Karim", reference_devis: "", reference_bc: "", date: "", annonce_par: "direction", confirme_doublon: false, confidentiel: false }, { books, documentService: {}, confidential: false }, "finance");
  assert.equal(refused.ok, false);
  assert.equal((await books.cash.entries()).length, 1);

  const briefing = (await directorBriefing({ books, clock, confidential: false })).join("\n");
  assert.ok(!briefing.includes("Samir"));
});

test("the chat of the cockpit tells the Director whether the person may see the confidential", async (t) => {
  const repository = new InMemoryRepository();
  const seen = [];
  const app = buildApi({ repository, clock, directorAgent: { isConfigured: () => true, chat: async (input) => { seen.push(input.confidential); return { conversationId: "c", reply: "ok", messages: [], documents: [], agentRuns: [] }; } } });
  t.after(() => app.close());
  const leader = await account(repository, { id: "hiba", role: "leader" });
  const operator = await account(repository, { id: "karim", role: "operator" });
  await app.inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Point caisse" }, headers: leader });
  await app.inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Point caisse" }, headers: operator });
  assert.deepEqual(seen, [true, false]);
});
