import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { adminFacts, contractDates, createMemoryAdminBook } from "../src/agent/admin-book.js";
import { runAdminTool } from "../src/agent/admin-tools.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Monday 23 November 2026.
const clock = () => new Date("2026-11-23T09:00:00Z");

test("suppliers keep what the direction said, checked, and nothing more", async () => {
  const admin = createMemoryAdminBook({ clock });
  const supplier = await admin.addSupplier({ name: "Bois Exemple", trade: "panneaux MDF", contact: "Ahmed", phone: "06 00 00 00 02", ice: "001234567000089", terms: "30 jours" });
  assert.deepEqual([supplier.phone, supplier.ice, supplier.email], ["0600000002", "001234567000089", ""]);
  await assert.rejects(admin.addSupplier({ name: "bois exemple" }), { code: "ADMIN_SUPPLIER_EXISTS" });
  await assert.rejects(admin.addSupplier({ name: "Autre", ice: "1234" }), { code: "ADMIN_ICE_INVALID" });
  await assert.rejects(admin.addSupplier({ name: "Autre", email: "pas-une-adresse" }), { code: "ADMIN_EMAIL_INVALID" });

  const updated = await admin.updateSupplier("bois", { terms: "60 jours", contact: "-" });
  assert.deepEqual([updated.terms, updated.contact, updated.trade], ["60 jours", "", "panneaux MDF"], "empty stays, « - » clears");
  await admin.removeSupplier("Bois Exemple");
  assert.equal((await admin.overview()).suppliers.length, 0);
});

test("a contract renewed tacitly rolls on, and warns before the last day to give notice", async () => {
  const admin = createMemoryAdminBook({ clock });
  const insurance = await admin.addContract({ title: "Assurance multirisque atelier", kind: "assurance", party: "Assureur Exemple", start: "01/01/2026", termMonths: 12, renewal: "tacite", noticeDays: 30, amount: "4 800", period: "par an" });
  assert.deepEqual([insurance.currentEnd, insurance.noticeBy, insurance.amount], ["2026-12-31", "2026-12-01", 4800]);
  await assert.rejects(admin.addContract({ title: "Bail", kind: "bail", renewal: "tacite" }), { code: "ADMIN_CONTRACT_END_MISSING" });
  await assert.rejects(admin.addContract({ title: "Bail", kind: "loyer" }), { code: "ADMIN_CONTRACT_KIND_UNKNOWN" });

  const [notice] = adminFacts(await admin.state(), "2026-11-23");
  assert.deepEqual([notice.kind, notice.severity, notice.owner], ["preavis_contrat", "moyenne", "administration"]);
  assert.match(notice.fact, /reconduit tacitement le 01\/01\/2027 sauf résiliation envoyée au plus tard le 01\/12\/2026 \(dans 8 jours, préavis de 30 jours\)/);
  assert.equal(adminFacts(await admin.state(), "2026-11-25")[0].severity, "haute");

  // Past the notice, it renews: next year's end and notice.
  const state = await admin.state();
  assert.deepEqual(contractDates(state.contracts[0], "2027-01-05"), { currentEnd: "2027-12-31", noticeBy: "2027-12-01" });
  assert.equal(adminFacts(state, "2027-01-05").length, 0);

  // The amount is the direction's.
  assert.equal((await admin.overview({ confidential: false })).contracts[0].amount, null);

  // A contract to decide warns before its end; ended, it is gone.
  const lease = await admin.addContract({ title: "Leasing CNC", kind: "leasing", start: "01/12/2023", end: "10/12/2026", renewal: "expresse" });
  assert.ok(adminFacts(await admin.state(), "2026-11-23").some((fact) => fact.kind === "fin_contrat_entreprise" && /Décider de son renouvellement/.test(fact.fact)));
  await admin.endContract(lease.number, { reason: "racheté" });
  assert.equal(adminFacts(await admin.state(), "2026-11-23").some((fact) => fact.kind === "fin_contrat_entreprise"), false);
});

test("deadlines warn ahead, are late after, and a recurring one moves on when done", async () => {
  const admin = createMemoryAdminBook({ clock });
  const vat = await admin.addDeadline({ title: "Déclaration de TVA", kind: "fiscale", due: "20/11/2026", recurrence: "mensuelle" });
  await admin.addDeadline({ title: "Taxe professionnelle", kind: "fiscale", due: "31/12/2026", recurrence: "annuelle", warnDays: 15 });
  await assert.rejects(admin.addDeadline({ title: "X", kind: "fiscale", due: "" }), { code: "ADMIN_DEADLINE_DATE_MISSING" });

  const [late] = adminFacts(await admin.state(), "2026-11-23");
  assert.deepEqual([late.kind, late.severity, late.owner], ["echeance_depassee", "haute", "finance"]);
  assert.match(late.fact, /Déclaration de TVA \(Fiscale – DGI\) était due le 20\/11\/2026/);

  const done = await admin.completeDeadline(vat.number);
  assert.equal(done.due, "2026-12-20");
  assert.equal(adminFacts(await admin.state(), "2026-11-23").length, 0, "the next one is not near yet");
  assert.deepEqual(adminFacts(await admin.state(), "2026-12-16").map((fact) => fact.kind), ["echeance_proche", "echeance_proche"], "7 days before the VAT, 15 before the tax");

  const once = await admin.addDeadline({ title: "Renouveler le registre de commerce", kind: "administrative", due: "25/11/2026" });
  await admin.completeDeadline(once.number);
  await assert.rejects(admin.completeDeadline(once.number), { code: "ADMIN_DEADLINE_DONE" });
  assert.equal((await admin.overview()).deadlines.some((deadline) => deadline.number === once.number), false);
});

test("the mail register numbers letters by year, a draft waits for the direction, and an answer sent deals with the letter", async () => {
  const admin = createMemoryAdminBook({ clock });
  const received = await admin.receiveMail({ party: "CNSS", subject: "Demande de pièces", reference: "Dossier 123", replyBy: "25/11/2026" });
  assert.equal(received.chrono, "2026-001");
  const [fact] = adminFacts(await admin.state(), "2026-11-23");
  assert.equal(fact.kind, "courrier_a_traiter");
  assert.match(fact.fact, /Courrier 2026-001 de CNSS \(« Demande de pièces »\) : réponse attendue le 25\/11\/2026 \(dans 2 jours\)/);

  const draft = await admin.prepareMail({ party: "CNSS", subject: "Envoi des pièces", body: "Madame, Monsieur,\nVeuillez trouver ci-joint…", answers: received.number });
  assert.deepEqual([draft.chrono, draft.status, draft.answers], ["2026-002", "brouillon", received.number]);
  assert.equal((await admin.overview({ confidential: false })).mail.find((mail) => mail.number === draft.number).body, "", "the draft is the direction's");

  await admin.closeMail(draft.number);
  const state = await admin.state();
  assert.deepEqual(state.mail.map((mail) => mail.status), ["traite", "envoye"]);
  assert.equal(state.mail[0].answeredBy, "2026-002");
  assert.equal(adminFacts(state, "2026-11-23").length, 0);
});

test("the agents keep the register in words; contracts are the direction's; a letter comes with the letterhead", async () => {
  const admin = createMemoryAdminBook({ clock });
  const books = { admin };
  const empty = await runAdminTool("registre_administratif", {}, { books }, "hiba");
  assert.match(empty.info, /registre administratif est vide/);

  const supplier = await runAdminTool("fournisseur", { action: "ajouter", nom: "Quincaillerie Exemple", activite: "charnières", contact: "", telephone: "", email: "", ice: "", conditions: "comptant", note: "" }, { books }, "hiba");
  assert.match(supplier.fournisseur, /n° 1 Quincaillerie Exemple · charnières · comptant/);

  const contract = { action: "enregistrer", numero: 0, intitule: "Bail de l'atelier", type: "bail", partie: "Bailleur Exemple", debut: "01/03/2025", fin: "", duree_mois: 12, renouvellement: "tacite", preavis_jours: -1, montant: "6000", periodicite: "par mois", note: "" };
  assert.match((await runAdminTool("contrat_entreprise", contract, { books, confidential: false }, "chef")).erreur, /réservés à la direction/);
  const saved = await runAdminTool("contrat_entreprise", contract, { books, confidential: true }, "hiba");
  assert.match(saved.contrat, /Bail de l'atelier · Bailleur Exemple · depuis le 01\/03\/2025 · échéance le 28\/02\/2027 · reconduction tacite · 6 000,00 DH par mois/);
  assert.match(saved.attention, /Préavis non dit/);

  const deadline = await runAdminTool("echeance", { action: "ajouter", numero: 0, intitule: "CNSS", type: "sociale", date: "10/12/2026", recurrence: "mensuelle", rappel_jours: 0, note: "" }, { books }, "hiba");
  assert.match(deadline.echeance, /CNSS \(Sociale – CNSS\) le 10\/12\/2026, chaque mois/);
  const done = await runAdminTool("echeance", { action: "faite", numero: 1, intitule: "", type: "sociale", date: "", recurrence: "aucune", rappel_jours: 0, note: "" }, { books }, "hiba");
  assert.equal(done.prochaine, "le 10/01/2027");

  const letter = await runAdminTool("courrier", { action: "preparer", numero: 0, partie: "Bailleur Exemple", objet: "Demande de travaux", date: "", reference: "Bail de l'atelier", repondre_avant: "", texte: "Marrakech, le 23/11/2026\nMonsieur,\n…" }, { books }, "hiba");
  assert.match(letter.courrier, /2026-001 \(n° 1\) pour Bailleur Exemple : Demande de travaux/);
  assert.match(letter.statut, /brouillon/);
  assert.ok(letter.en_tete.length >= 3);

  const overview = await runAdminTool("registre_administratif", {}, { books, confidential: true }, "hiba");
  assert.ok(overview.contrats[0].includes("6 000,00 DH"));
  assert.match(overview.courriers[0], /brouillon à valider/);
  const others = await runAdminTool("registre_administratif", {}, { books, confidential: false }, "chef");
  assert.equal(others.contrats[0].includes("DH"), false);
});

test("administrative alerts reach Amélioration and are lifted once done", async () => {
  const admin = createMemoryAdminBook({ clock });
  const deadline = await admin.addDeadline({ title: "Prime d'assurance", kind: "assurance", due: "26/11/2026" });
  const improvement = createMemoryImprovementBook({ clock });
  const found = await improvement.sync([], { administratif: await admin.facts() });
  assert.deepEqual(found.map((anomaly) => [anomaly.source, anomaly.kind, anomaly.owner]), [["administratif", "echeance_proche", "administration"]]);
  await admin.completeDeadline(deadline.number);
  await improvement.sync([], { administratif: await admin.facts() });
  const anomaly = (await improvement.state()).anomalies[0];
  assert.equal(anomaly.status, "levee");
  assert.match(anomaly.journal.at(-1).text, /registre administratif ne la montre plus/);
});

test("the cockpit shows the register, and only the direction says a prepared letter sent", async () => {
  const admin = createMemoryAdminBook({ clock });
  await admin.addContract({ title: "Bail", kind: "bail", start: "01/03/2025", termMonths: 12, renewal: "tacite", noticeDays: 90, amount: "6000" });
  await admin.addDeadline({ title: "TVA", kind: "fiscale", due: "20/12/2026", recurrence: "mensuelle" });
  const draft = await admin.prepareMail({ party: "Bailleur Exemple", subject: "Travaux", body: "Monsieur, …" });
  const direction = await buildAuthenticatedApi({ repository: new InMemoryRepository(), adminBook: admin, clock });
  const operator = await buildAuthenticatedApi({ repository: new InMemoryRepository(), adminBook: admin, clock, role: "operator" });

  const seen = (await direction.inject({ method: "GET", url: "/api/admin" })).json();
  assert.equal(seen.canDecide, true);
  assert.equal(seen.overview.contracts[0].amount, 6000);
  assert.ok(seen.letterhead.length >= 3);
  const masked = (await operator.inject({ method: "GET", url: "/api/admin" })).json();
  assert.deepEqual([masked.canDecide, masked.overview.contracts[0].amount, masked.overview.mail[0].body, masked.letterhead.length], [false, null, "", 0]);

  assert.equal((await operator.inject({ method: "POST", url: `/api/admin/mail/${draft.number}/close`, payload: {} })).statusCode, 403);
  assert.equal((await direction.inject({ method: "POST", url: `/api/admin/mail/${draft.number}/close`, payload: {} })).json().mail.status, "envoye");
  const done = await operator.inject({ method: "POST", url: "/api/admin/deadlines/1/done", payload: {} });
  assert.equal(done.json().deadline.due, "2027-01-20");
  assert.equal((await direction.inject({ method: "POST", url: "/api/admin/deadlines/9/done", payload: {} })).statusCode, 404);
  assert.equal((await direction.app.inject({ method: "GET", url: "/api/admin" })).statusCode, 401);
});
