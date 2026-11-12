import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { REGISTER_FILE, clientFolderName, createDocumentArchive, registerEntries, searchDocuments } from "../src/agent/document-register.js";
import { SPECIALISTS } from "../src/agent/agent-team.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Hiba's request of 10/11/2026: the Administratif keeps the client files. One
// folder per client, its devis and factures in it with the date first, a
// register in the cockpit, every new document filed, the old ones imported
// under their numbers, and « ressors-moi le devis de Mme Barada » answered
// with the PDF, in a new conversation.

const ISSUED = Object.freeze([
  { type: "quote", number: "171", stem: "devis_HKIDS_171_10_11_2026", date: "10/11/2026", client: "Mme Barada", object: "Lit cabane", totalTtc: 3200 },
  { type: "quote", number: "168", stem: "devis_HKIDS_168_02_10_2026", date: "02/10/2026", client: "Madame BARADA", object: "Bureau", totalTtc: 1800 },
  { type: "purchase_order", number: "166", stem: "bon_de_commande_HKIDS_166_2026-10-05", date: "2026-10-05", client: "Madame Barada", object: "Bureau", totalTtc: 1800, quoteReference: "168" },
  { type: "invoice", number: "165", stem: "facture_HKIDS_165_2026-09-05", date: "2026-09-05", client: "MADAME BENCHAKROUN", object: "Chambre", totalTtc: 8760 },
  { type: "invoice", number: "165", stem: "facture_HKIDS_165_2026-09-06", date: "2026-09-06", client: "Madame Benchakroun", object: "Chambre", totalTtc: 8760 },
  { type: "quote", number: "170", stem: "devis_HKIDS_170_04_11_2026", date: "04/11/2026", client: "Mamoun Bouanani", object: "Dressing", totalTtc: 62699.99 }
]);

test("a client's folder is its name without civility, in capitals, safe for Windows", () => {
  assert.equal(clientFolderName("Mme Barada"), "BARADA");
  assert.equal(clientFolderName("MADAME BENCHAKROUN"), "BENCHAKROUN");
  assert.equal(clientFolderName("M. Alami"), "ALAMI");
  assert.equal(clientFolderName("Nadia Berrada"), "NADIA BERRADA");
  assert.equal(clientFolderName("Sté Atlas: Déco/Kids?"), "ATLAS DÉCO KIDS");
  assert.equal(clientFolderName("Madame"), "MADAME", "a civility alone is kept, never an empty name");
  assert.equal(clientFolderName(""), "CLIENT NON PRÉCISÉ");
});

test("the register dates each file, says which quotes were ordered, and keeps two documents of one number apart", () => {
  const entries = registerEntries(ISSUED, { archiveDir: "C:/Archive" });
  const quote = entries.find((entry) => entry.number === "171");
  assert.equal(quote.date, "2026-11-10");
  assert.equal(quote.status, "ouvert");
  assert.equal(entries.find((entry) => entry.number === "168").status, "commandé", "a purchase order cites it");
  assert.match(quote.file.replace(/\\/g, "/"), /C:\/Archive\/BARADA\/Devis\/2026-11-10_devis_171\.pdf$/);
  const invoices = entries.filter((entry) => entry.type === "invoice").map((entry) => entry.file.replace(/\\/g, "/"));
  assert.equal(new Set(invoices).size, 2, "two invoices 165 are two files");
  assert.match(invoices[0], /BENCHAKROUN\/Factures\/2026-09-05_facture_165\.pdf$/);
});

test("a document is found by its client, its number, its type or its dates, the newest first", () => {
  const entries = registerEntries(ISSUED);
  assert.deepEqual(searchDocuments(entries, { client: "Mme Barada" }).map((entry) => entry.number), ["171", "166", "168"]);
  assert.deepEqual(searchDocuments(entries, { client: "barada", type: "devis" }).map((entry) => entry.number), ["171", "168"]);
  assert.deepEqual(searchDocuments(entries, { client: "BÉNCHAKROUN" }).map((entry) => entry.date), ["2026-09-06", "2026-09-05"], "accents and capitals aside");
  assert.deepEqual(searchDocuments(entries, { number: "170" }).map((entry) => entry.client), ["Mamoun Bouanani"]);
  assert.deepEqual(searchDocuments(entries, { from: "01/11/2026", to: "30/11/2026" }).map((entry) => entry.number), ["171", "170"]);
  assert.deepEqual(searchDocuments(entries, { client: "Alami" }), []);
});

async function folders(t) {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-generated-"));
  const archiveDir = join(await mkdtemp(join(tmpdir(), "hkids-archive-")), "H-KIDS Administratif");
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true });
    await rm(join(archiveDir, ".."), { recursive: true, force: true });
  });
  return { outputDir, archiveDir };
}

test("the import files what exists under its own numbers, says what is missing, and makes no duplicate when run again", async (t) => {
  const { outputDir, archiveDir } = await folders(t);
  for (const entry of ISSUED.filter((entry) => entry.number !== "170")) {
    await writeFile(join(outputDir, `${entry.stem}.pdf`), `%PDF-1.4 ${entry.stem}`);
  }
  const archive = createDocumentArchive({ documentService: { outputDir, listIssued: async () => ISSUED }, dir: archiveDir });

  const first = await archive.sync();
  assert.equal(first.copied.length, 5);
  assert.deepEqual(first.missing, [{ type: "Devis", number: "170", client: "Mamoun Bouanani" }]);
  assert.deepEqual(first.series, { quote: 171, purchase_order: 166, invoice: 165 }, "the last number of each series");
  assert.deepEqual((await readdir(join(archiveDir, "BARADA", "Devis"))).sort(), ["2026-10-02_devis_168.pdf", "2026-11-10_devis_171.pdf"]);
  assert.equal(await readFile(join(archiveDir, "BARADA", "Devis", "2026-11-10_devis_171.pdf"), "utf8"), "%PDF-1.4 devis_HKIDS_171_10_11_2026");

  const again = await archive.sync();
  assert.equal(again.copied.length, 0);
  assert.equal(again.already, 5);
  assert.deepEqual((await readdir(join(archiveDir, "BARADA", "Devis"))).length, 2);

  const register = await readFile(join(archiveDir, REGISTER_FILE), "utf8");
  assert.ok(register.startsWith("\ufeff\"Client\";\"Type\";\"Numéro\""), "a CSV Excel opens in columns");
  assert.match(register, /"Mme Barada";"Devis";"171";"10\/11\/2026";"Lit cabane";"3200";"ouvert"/);

  // The source is the documents' own folder: nothing was moved out of it.
  assert.ok(await stat(join(outputDir, "devis_HKIDS_171_10_11_2026.pdf")));
});

test("filings at the same time do not copy over each other", async (t) => {
  const { outputDir, archiveDir } = await folders(t);
  for (const entry of ISSUED) {
    await writeFile(join(outputDir, `${entry.stem}.pdf`), `%PDF-1.4 ${entry.stem}`);
  }
  const archive = createDocumentArchive({ documentService: { outputDir, listIssued: async () => ISSUED }, dir: archiveDir });
  const reports = await Promise.all([archive.sync(), archive.sync(), archive.sync()]);
  assert.equal(reports.reduce((sum, report) => sum + report.copied.length, 0), ISSUED.length, "each file copied once");
});

test("the Administratif is an agent of the team, with the register to search", () => {
  assert.equal(SPECIALISTS.administration.label, "Administratif");
  assert.equal(SPECIALISTS.administration.keepsRegister, true);
});

// A stand-in for the model: the first rule that matches answers.
function modelPlaying(rules) {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        const rule = rules.find((candidate) => candidate.when(payload));
        assert.ok(rule, `no scripted answer for: ${payload.instructions.split("\n")[0]}`);
        return rule.then(payload);
      }
    }
  };
}
const isDirector = (payload) => payload.instructions.startsWith("Tu es le Director IA");
const isCommercial = (payload) => payload.instructions.includes("Tu es l'agent Commercial");
// The message the direction typed last, not the context around it.
const asked = (words) => (payload) => JSON.stringify(payload.input.filter((item) => item.role === "user").at(-1)?.content ?? "").includes(words);
const answered = (payload) => payload.input.at(-1)?.type === "function_call_output";
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });
const quoteFor = (object, price) => ({
  type: "devis", client_nom: "Mme Barada", client_adresse: "Marrakech", objet: object,
  lignes: [{ designation: object, quantite: 1, prix_unitaire: price, prix_ttc: true }],
  caracteristiques: [], conditions_paiement: "60/20/20", reference_devis: "", reference_bl: "", numero: "", photo: 0, date: "", remplace: false
});

test("recette: a devis for Mme Barada is filed in BARADA, and found again in a new conversation with its PDF", async (t) => {
  const { outputDir, archiveDir } = await folders(t);
  let object = "Lit cabane";
  const client = modelPlaying([
    { when: (p) => isCommercial(p) && !answered(p), then: () => call("preparer_document", quoteFor(object, object === "Lit cabane" ? 3200 : 1800), "c1") },
    { when: isCommercial, then: () => say("Devis prêt pour Mme Barada.") },
    { when: (p) => isDirector(p) && asked("Ressors-moi")(p) && !answered(p), then: () => call("chercher_document", { client: "Barada", numero: "", type: "devis", du: "", au: "" }, "s1") },
    { when: (p) => isDirector(p) && asked("Ressors-moi")(p), then: () => say("Voici le devis de Mme Barada.") },
    { when: (p) => isDirector(p) && !answered(p), then: () => call("deleguer_a_un_agent", { agent: "commercial", mission: `Devis pour Mme Barada, Marrakech : ${object}.` }, "d1") },
    { when: isDirector, then: () => say("Le devis est prêt à valider.") }
  ]);
  const repository = new InMemoryRepository();
  const documentService = new HkidsDocumentService({ repository, outputDir });
  const { app, inject } = await buildAuthenticatedApi({ repository, documentService, agentClient: client, archiveDir });
  t.after(() => app.close());

  // The devis is prepared, then validated: it is filed at once.
  const validate = async () => {
    const prepared = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: `Fais un devis pour Mme Barada : ${object}` } })).body);
    assert.equal(prepared.documents?.length, 1, JSON.stringify(prepared).slice(0, 1500));
    const [{ input, preview }] = prepared.documents;
    const generated = await inject({ method: "POST", url: "/api/documents/generate", payload: { ...input, previewToken: preview.previewToken, userConfirmation: true } });
    assert.equal(generated.statusCode, 201, generated.body);
    return input.documentNumber;
  };
  const number = await validate();
  const filed = await readdir(join(archiveDir, "BARADA", "Devis"));
  assert.equal(filed.length, 1);
  assert.match(filed[0], new RegExp(`^\\d{4}-\\d{2}-\\d{2}_devis_${number}\\.pdf$`), "the date first, then the number");

  // A new conversation: no conversationId, nothing of the first one.
  const found = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Ressors-moi le devis de Mme Barada" } });
  const body = JSON.parse(found.body);
  assert.equal(found.statusCode, 200, found.body);
  assert.equal(body.foundDocuments.length, 1);
  assert.equal(body.foundDocuments[0].number, number);
  const output = JSON.parse(client.calls.find((p) => isDirector(p) && asked("Ressors-moi")(p) && answered(p)).input.at(-1).output);
  assert.equal(output.trouves, 1);
  assert.match(output.documents[0].dossier.replace(/\\/g, "/"), /BARADA\/Devis\//, "the agent can say where it is filed");

  // The button under the answer opens the PDF itself.
  const pdf = await inject({ method: "GET", url: `/api/documents/register/${encodeURIComponent(body.foundDocuments[0].stem)}/pdf` });
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");
  const missing = await inject({ method: "GET", url: "/api/documents/register/..%2F..%2Fsecret/pdf" });
  assert.equal(missing.statusCode, 404, "only a document of the register is served");

  // A second devis: both are listed, with dates and numbers, to choose from.
  object = "Bureau";
  const second = await validate();
  const both = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Ressors-moi le devis de Mme Barada" } })).body);
  assert.deepEqual(both.foundDocuments.map((entry) => entry.number), [second, number].sort((a, b) => Number(b) - Number(a)));
  const listed = JSON.parse(client.calls.filter((p) => isDirector(p) && asked("Ressors-moi")(p) && answered(p)).at(-1).input.at(-1).output);
  assert.match(listed.a_faire, /lequel/);

  // And the register of the cockpit gives the same, with the folder.
  const register = JSON.parse((await inject({ method: "GET", url: "/api/documents/register?client=barada" })).body);
  assert.equal(register.dir, archiveDir);
  assert.equal(register.documents.length, 2);
  assert.ok(register.documents.every((entry) => entry.frenchDate.match(/^\d{2}\/\d{2}\/\d{4}$/)));
});

test("without a folder set, the register is still searched and nothing is written on the PC", async (t) => {
  const { outputDir } = await folders(t);
  const repository = new InMemoryRepository();
  const documentService = { outputDir, listIssued: async () => ISSUED };
  const archive = createDocumentArchive({ documentService });
  assert.equal((await archive.search({ client: "Barada" })).length, 3);
  assert.equal((await archive.sync()).disabled, true);
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());
  const response = await inject({ method: "POST", url: "/api/documents/register/sync", payload: {} });
  assert.equal(JSON.parse(response.body).disabled, true);
});
