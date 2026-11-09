import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { createFileCashBook, createMemoryCashBook } from "../src/agent/cash-book.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC V1.1, section 6: every expense is announced, then justified by a receipt,
// approved by a person above the alert threshold, and reconciled with the bank
// or the cash count. Invented suppliers and figures only.

const clock = () => new Date("2026-11-09T10:00:00Z");
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PHOTO.split(",")[1], "base64");
const PDF = Buffer.from("%PDF-1.4 facture fournisseur");

test("an expense is declared, justified, approved above the threshold, then reconciled, in that order", async () => {
  const cash = createMemoryCashBook({ clock, expenseThreshold: 2000 });
  const small = await cash.record({ kind: "sortie", amount: 350, category: "transport", label: "Taxi livraison", method: "especes" });
  const large = await cash.record({ kind: "sortie", amount: 2500, category: "achat_matiere", label: "Panneaux MDF", party: "Fournisseur Exemple", method: "especes" });
  const income = await cash.record({ kind: "entree", amount: 2700, category: "acompte_client", party: "Client Exemple", method: "especes" });
  assert.deepEqual([small.needsApproval, large.needsApproval, income.needsApproval], [false, true, false]);

  let pending = await cash.pending();
  assert.deepEqual(pending.missingReceipt.map((entry) => entry.number), [small.number, large.number]);
  assert.equal(pending.threshold, 2000);

  await assert.rejects(cash.approve(large.number, { by: "Hiba" }), { code: "CASH_RECEIPT_MISSING" }, "no approval without a proof");
  await assert.rejects(cash.attachReceipt(large.number, { bytes: Buffer.from("GIF89a"), mimeType: "image/gif" }), { code: "CASH_RECEIPT_INVALID" });
  await assert.rejects(cash.attachReceipt(99, { bytes: PNG, mimeType: "image/png" }), { code: "CASH_ENTRY_NOT_FOUND" });

  const justified = await cash.attachReceipt(large.number, { bytes: PDF, mimeType: "application/pdf", name: "facture-mdf.pdf", by: "finance" });
  assert.deepEqual([justified.status, justified.statusLabel, justified.receipts[0].name], ["justifiee", "Justifiée", "facture-mdf.pdf"]);
  assert.deepEqual((await cash.receipt(large.number, justified.receipts[0].id)).bytes, PDF);
  await assert.rejects(cash.reconcile(large.number, { by: "Hiba" }), { code: "CASH_APPROVAL_MISSING" }, "above the threshold, approval comes first");
  await assert.rejects(cash.approve(income.number, { by: "Hiba" }), { code: "CASH_NOT_AN_EXPENSE" });

  await cash.attachReceipt(small.number, { bytes: PNG, mimeType: "image/png" });
  pending = await cash.pending();
  assert.deepEqual(pending.awaitingApproval.map((entry) => entry.number), [large.number]);
  assert.deepEqual(pending.toReconcile.map((entry) => entry.number), [small.number], "below the threshold, no approval needed");

  assert.equal((await cash.approve(large.number, { by: "Hiba" })).status, "approuvee");
  await assert.rejects(cash.approve(large.number, { by: "Hiba" }), { code: "CASH_ALREADY_APPROVED" });
  const reconciled = await cash.reconcile(large.number, { by: "Hiba", note: "Relevé du 10/11" });
  assert.deepEqual([reconciled.status, reconciled.reconciliation.note], ["rapprochee", "Relevé du 10/11"]);
  await assert.rejects(cash.cancel(large.number, { reason: "erreur" }), { code: "CASH_ALREADY_RECONCILED" }, "a reconciled expense stays");

  const day = await cash.day();
  assert.deepEqual(day.entries.map((entry) => entry.status), ["justifiee", "rapprochee", null]);
});

test("the receipts survive a restart of the server", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hkids-receipts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { path: join(dir, "caisse.json"), receiptsDir: join(dir, "justificatifs"), clock };
  const first = createFileCashBook(options);
  const entry = await first.record({ kind: "sortie", amount: 900, category: "fournisseur", label: "Quincaillerie", method: "cheque" });
  const justified = await first.attachReceipt(entry.number, { bytes: PNG, mimeType: "image/png" });

  const again = createFileCashBook(options);
  assert.equal((await again.day()).entries[0].status, "justifiee");
  assert.deepEqual((await again.receipt(entry.number, justified.receipts[0].id)).bytes, PNG);
  await assert.rejects(again.receipt(entry.number, "../caisse.json"), { code: "CASH_RECEIPT_NOT_FOUND" });
});

test("an expense sent with the photo of its receipt is recorded and justified by Finance, and the threshold is flagged", async () => {
  const books = { cashBook: createMemoryCashBook({ clock, expenseThreshold: 2000 }), improvementBook: createMemoryImprovementBook({ clock }), teamBook: createMemoryTeamBook({ clock, agents: SPECIALIST_IDS }) };
  const calls = [];
  const scripts = {
    "Tu es le Director IA": [
      { output: [{ type: "function_call", name: "deleguer_a_un_agent", call_id: "d1", arguments: JSON.stringify({ agent: "finance", mission: "Hiba a payé 2 500 DH en espèces de MDF à Fournisseur Exemple pour le BC 171. Justificatif : photo n° 1." }) }] },
      { output_text: "Dépense n° 1 enregistrée et justifiée. Au-dessus du seuil : à approuver dans le cockpit.", output: [] },
      { output_text: "Il reste une dépense à approuver.", output: [] }
    ],
    "Tu es l'agent Administration / Finance": [
      { output: [{ type: "function_call", name: "enregistrer_mouvement_caisse", call_id: "f1", arguments: JSON.stringify({ sens: "sortie", montant: 2500, categorie: "achat_matiere", libelle: "MDF", moyen: "especes", tiers: "Fournisseur Exemple", reference_devis: "", reference_bc: "171", date: "", annonce_par: "Hiba", confirme_doublon: false }) }] },
      { output: [{ type: "function_call", name: "joindre_justificatif", call_id: "f2", arguments: JSON.stringify({ numero: 1, photo: 1 }) }] },
      { output: [{ type: "function_call", name: "joindre_justificatif", call_id: "f3", arguments: JSON.stringify({ numero: 1, photo: 4 }) }] },
      { output_text: "Dépense n° 1 enregistrée, justificatif joint.", output: [] }
    ]
  };
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return scripts[Object.keys(scripts).find((key) => payload.instructions.includes(key))].shift();
    } } },
    documentService: { dossier: async () => null },
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock,
    ...books
  });

  const first = await agent.chat({ message: "J'ai payé 2 500 DH de MDF en espèces, voici le reçu", photos: [PHOTO] });

  const finance = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Administration / Finance"));
  assert.ok(finance[0].tools.some((tool) => tool.name === "joindre_justificatif"));
  assert.match(finance[0].instructions, /Justificatifs : toute dépense doit avoir sa preuve/);
  const output = (index) => JSON.parse(finance[index].input.at(-1).output);
  assert.match(output(1).justificatif.alerte, /au-dessus du seuil d'alerte de 2[  ]000 DH/);
  assert.deepEqual([output(2).ok, output(2).etat], [true, "Justifiée"]);
  assert.match(output(2).a_faire, /approuver par la direction/);
  assert.match(output(3).erreur, /Aucune photo n° 4/, "a photo that is not there is never invented");

  const pending = await books.cashBook.pending();
  assert.deepEqual(pending.awaitingApproval.map((entry) => [entry.number, entry.receipts[0].mimeType]), [[1, "image/png"]]);
  assert.ok(!calls.some((payload) => payload.tools?.some((tool) => /approuv|rapproch/.test(tool.name))), "no agent can approve or reconcile");

  await agent.chat({ message: "Où en sont les dépenses ?", conversationId: first.conversationId });
  const director = calls.filter((payload) => payload.instructions.startsWith("Tu es le Director IA")).at(-1);
  assert.match(director.instructions, /Dépenses à régulariser : 0 sans justificatif, 1 au-dessus du seuil de 2[  ]000 DH à approuver/);
});

test("in the cockpit a person joins a receipt, approves and reconciles; an approval needs the right to decide", async (t) => {
  const cashBook = createMemoryCashBook({ clock, expenseThreshold: 2000 });
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), cashBook, teamBook: createMemoryTeamBook({ clock, agents: SPECIALIST_IDS }), clock });
  t.after(() => app.close());
  const json = (response) => JSON.parse(response.body);

  const posted = json(await inject({ method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 3200, category: "fournisseur", label: "Quincaillerie", method: "virement" } }));
  assert.equal(posted.entry.needsApproval, true);
  let state = json(await inject({ method: "GET", url: "/api/cash" }));
  assert.deepEqual([state.pending.threshold, state.pending.missingReceipt.length, state.statuses.rapprochee], [2000, 1, "Rapprochée"]);

  assert.equal((await inject({ method: "POST", url: "/api/cash/1/approve" })).statusCode, 400, "no proof yet");
  assert.equal((await inject({ method: "POST", url: "/api/cash/1/receipts", payload: { name: "x.gif", data: "data:image/gif;base64,R0lGODlh" } })).statusCode, 400);
  const joined = await inject({ method: "POST", url: "/api/cash/1/receipts", payload: { name: "facture.pdf", data: `data:application/pdf;base64,${PDF.toString("base64")}` } });
  assert.equal(joined.statusCode, 201, joined.body);
  const receipt = json(joined).entry.receipts[0];
  const file = await inject({ method: "GET", url: `/api/cash/1/receipts/${receipt.id}` });
  assert.deepEqual([file.statusCode, file.headers["content-type"], file.rawPayload.equals(PDF)], [200, "application/pdf", true]);
  assert.equal((await app.inject({ method: "GET", url: `/api/cash/1/receipts/${receipt.id}` })).statusCode, 401, "a proof is never public");
  assert.equal((await inject({ method: "GET", url: "/api/cash/1/receipts/nope.pdf" })).statusCode, 404);

  assert.equal((await inject({ method: "POST", url: "/api/cash/1/reconcile" })).statusCode, 400, "approval first");
  assert.equal((await inject({ method: "POST", url: "/api/cash/1/approve" })).statusCode, 200);
  assert.equal((await inject({ method: "POST", url: "/api/cash/1/reconcile", payload: { note: "Relevé BMCE" } })).statusCode, 200);
  state = json(await inject({ method: "GET", url: "/api/cash" }));
  assert.deepEqual([state.day.entries[0].status, state.pending.toReconcile.length], ["rapprochee", 0]);

  const viewer = await buildAuthenticatedApi({ repository: new InMemoryRepository(), cashBook, role: "viewer", userId: "viewer", clock });
  t.after(() => viewer.app.close());
  await cashBook.record({ kind: "sortie", amount: 2100, category: "loyer", label: "Loyer atelier", method: "virement" });
  await cashBook.attachReceipt(2, { bytes: PNG, mimeType: "image/png" });
  assert.equal((await viewer.inject({ method: "POST", url: "/api/cash/2/approve" })).statusCode, 403, "approving is a decision");
});
