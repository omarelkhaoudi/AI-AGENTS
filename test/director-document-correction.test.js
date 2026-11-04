import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";

// Hiba asks the Director to correct a document already generated — « refais le
// devis 170 avec la date du 08/08 » — and the agent who owns it reads it back
// and issues it again under the same number. The old version is archived when
// she validates, never deleted. Invented clients and figures only.
// A JPEG that is not the logo: the logo's bytes with a comment segment added
// after the start marker, so a visual can be told apart from the logo.
const logo = await readFile(new URL("../assets/documents/hkids-logo.jpg", import.meta.url));
const PHOTO = `data:image/jpeg;base64,${Buffer.concat([logo.subarray(0, 2), Buffer.from([0xff, 0xfe, 0x00, 0x05, 0x68, 0x6b, 0x64]), logo.subarray(2)]).toString("base64")}`;

async function outputDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-correction-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function order(overrides = {}) {
  return {
    documentType: "purchase_order",
    documentNumber: "170",
    date: "04/11/2026",
    object: "Lit cabane",
    client: { name: "Client Exemple", address: "Marrakech" },
    items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
    totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
    payment: { termsRule: "hkids-po-50-50" },
    specifications: ["Bois clair"],
    referenceImage: PHOTO,
    ...overrides
  };
}

async function issue(service, input, options = {}) {
  const preview = await service.preview(input, options);
  return service.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true }, options);
}

test("a generated document keeps its content, and its number is never reused by accident", async (t) => {
  const dir = await outputDir(t);
  const service = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir });
  await issue(service, order());

  assert.deepEqual((await readdir(dir)).sort(), ["bon_commande_HKIDS_170_04_11_2026.docx", "bon_commande_HKIDS_170_04_11_2026.json", "bon_commande_HKIDS_170_04_11_2026.pdf"]);
  const issued = await service.readIssued("purchase_order", "170");
  assert.equal(issued.source, "content");
  assert.equal(issued.input.referenceImage, PHOTO);
  assert.equal(issued.input.previewToken, undefined);

  const quote = { ...order({ documentType: "quote", referenceImage: undefined, specifications: undefined }), payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" } };
  await issue(service, quote);
  await assert.rejects(service.preview(quote), { code: "DOCUMENT_NUMBER_USED" });
});

test("a correction archives the old version under the same number, and needs one to exist", async (t) => {
  const dir = await outputDir(t);
  const service = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir });
  await issue(service, order());

  await issue(service, order({ date: "08/08/2026" }), { replaceExisting: true });

  const names = (await readdir(dir)).filter((name) => name !== "annules").sort();
  assert.deepEqual(names, ["bon_commande_HKIDS_170_08_08_2026.docx", "bon_commande_HKIDS_170_08_08_2026.json", "bon_commande_HKIDS_170_08_08_2026.pdf"]);
  const archived = await readdir(join(dir, "annules"));
  assert.equal(archived.length, 3);
  assert.ok(archived.every((name) => /^remplace-.+_bon_commande_HKIDS_170_04_11_2026\./.test(name)));
  await assert.rejects(service.preview(order({ documentNumber: "171" }), { replaceExisting: true }), { code: "DOCUMENT_TO_REPLACE_NOT_FOUND" });
});

test("the confirmation covers the choice to replace: a plain preview cannot generate a replacement", async (t) => {
  const dir = await outputDir(t);
  const service = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir });
  await issue(service, order());
  const preview = await service.preview(order({ date: "08/08/2026" }), { replaceExisting: true });

  await assert.rejects(
    service.generate({ ...order({ date: "08/08/2026" }), previewToken: preview.previewToken, userConfirmation: true }),
    { code: "PREVIEW_CONFIRMATION_REQUIRED" }
  );
});

test("a document generated before its content was kept is read back from its Word file, visual from its PDF", async (t) => {
  const dir = await outputDir(t);
  const service = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir });
  await issue(service, order());
  await unlink(join(dir, "bon_commande_HKIDS_170_04_11_2026.json"));

  const issued = await service.readIssued("purchase_order", "170");

  assert.equal(issued.source, "word");
  assert.match(issued.text, /BON DE COMMANDE N° 170/);
  assert.match(issued.text, /Lit cabane 90x190 \| 1 \| 3 750,00 DH/);
  assert.equal(issued.referenceImage, PHOTO, "the visual is the photo, not the logo");
});

test("asked to correct a document, the Commercial reads it back and issues it again under its number", async (t) => {
  const dir = await outputDir(t);
  const service = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir });
  await issue(service, order());

  const calls = [];
  const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
  const say = (text) => ({ output_text: text, output: [] });
  const director = [
    call("deleguer_a_un_agent", { agent: "commercial", mission: "Correction du document existant n° 170 (bon de commande), même numéro : date du document 08/08/2026." }, "d1"),
    say("Le Commercial a corrigé le BC 170 : date 08/08/2026.")
  ];
  const commercial = [
    call("consulter_document", { type: "bon_de_commande", numero: "170" }, "c1"),
    call("preparer_document", {
      type: "bon_de_commande", client_nom: "Client Exemple", client_adresse: "Marrakech", objet: "Lit cabane",
      lignes: [{ designation: "Lit cabane 90x190", quantite: 1, prix_unitaire: 3750, prix_ttc: false }],
      caracteristiques: ["Bois clair"], conditions_paiement: "50/50", reference_devis: "", reference_bl: "",
      numero: "170", photo: 0, date: "08/08/2026", remplace: true
    }, "c2"),
    say("BC 170 corrigé : seule la date change.")
  ];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return payload.instructions.startsWith("Tu es le Director IA") ? director.shift() : commercial.shift();
    } } },
    documentService: service,
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock: () => new Date("2026-11-04T10:00:00Z")
  });

  const result = await agent.chat({ message: "Refais le BC 170 avec la date du 08/08/2026" });

  const commercialCalls = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  assert.ok(commercialCalls[0].tools.some((tool) => tool.name === "consulter_document"));
  const read = JSON.parse(commercialCalls[1].input.at(-1).output);
  assert.deepEqual(read.lignes, [{ designation: "Lit cabane 90x190", quantite: 1, prix_unitaire: 3750, prix_ttc: false }]);
  assert.equal(read.conditions_paiement, "50/50");
  assert.equal(read.visuel, "oui, il sera conservé");
  assert.equal(read.referenceImage, undefined, "the picture itself is not sent to the model");

  const [document] = result.documents;
  assert.equal(document.replaces, true);
  assert.equal(document.preview.document.documentNumber, "170");
  assert.equal(document.preview.document.date, "08/08/2026");
  assert.equal(document.preview.document.totals.totalTtc, 4500, "HT prices come back to the cent");
  assert.equal(document.input.referenceImage, PHOTO, "the visual is kept");
  assert.match(JSON.parse(commercialCalls[2].input.at(-1).output).remplace, /archivée à la validation/);
});
