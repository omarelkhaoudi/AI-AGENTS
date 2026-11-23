import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { createFileWorkshopStore, createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { fingerprint, signatureMoment } from "../src/documents/signed-pdf.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 7: « Bon de livraison — émission et signature électronique ».
// The client signs the delivery note of their sale on their follow-up link:
// a name and a drawn signature, once. The signed PDF is the note as it was
// signed, followed by the page of the signature. Invented client and figures.

const clock = () => new Date("2026-11-16T15:30:00Z");
const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote", documentNumber: "170", date: "02/11/2026", object: "Lit cabane", client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const order = { ...quote, documentType: "purchase_order", documentNumber: "171", date: "03/11/2026", payment: { termsRule: "hkids-po-50-50" }, quoteReference: "170" };
const deliveryNote = { ...quote, documentType: "delivery_note", documentNumber: "55", date: "15/11/2026", reference: "Commande validée", quoteReference: "170" };

// A real PNG, drawn here: a grey frame with scattered ink, as a signature is.
function signaturePng(width = 160, height = 60) {
  const rows = [];
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width, 0xff);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (seed % 9 === 0 || Math.abs(y - (20 + x / 4)) < 1.5) {
        row[1 + x] = 0x20;
      }
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function documentsWith(t) {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-signature-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir });
  for (const input of [quote, order, deliveryNote]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  return { documents, outputDir };
}
const tokenOf = (link) => link.path.split("/").at(-1);

test("the client signs the delivery note of their sale once, and the signed PDF keeps the note as it was", async (t) => {
  const { documents, outputDir } = await documentsWith(t);
  const store = createFileWorkshopStore({ path: join(outputDir, "atelier.json"), clock });
  const workshop = createWorkshop({ store, documentService: documents, clock });
  const token = tokenOf(await workshop.openPortal("171"));
  const signature = signaturePng();

  const before = await workshop.clientView(token);
  assert.deepEqual(before.documents.find((entry) => entry.type === "delivery_note"), { type: "delivery_note", number: "55", label: "Bon de livraison n° 55", signature: null });

  await assert.rejects(workshop.signDeliveryNote("mauvais-lien", "55", { name: "Client Exemple", signature }), { code: "WORKSHOP_DOCUMENT_NOT_FOUND" }, "an unknown link signs nothing");
  await assert.rejects(workshop.signDeliveryNote(token, "99", { name: "Client Exemple", signature }), { code: "WORKSHOP_DOCUMENT_NOT_FOUND" }, "only a delivery note of this sale");
  await assert.rejects(workshop.signDeliveryNote(token, "55", { name: "A", signature }), { code: "WORKSHOP_SIGNER_INVALID" });
  await assert.rejects(workshop.signDeliveryNote(token, "55", { name: "Client Exemple", signature: "data:image/png;base64,AAAA" }), { code: "WORKSHOP_SIGNATURE_INVALID" });
  await assert.rejects(workshop.signDeliveryNote(token, "55", { name: "Client Exemple", signature: signature.replace("image/png", "image/jpeg") }), { code: "WORKSHOP_SIGNATURE_INVALID" });

  const signed = await workshop.signDeliveryNote(token, "55", { name: "  Client   Exemple ", signature, ip: "196.0.2.10", userAgent: "Navigateur de test" });
  assert.deepEqual({ number: signed.signature.number, name: signed.signature.name, signedAt: signed.signature.signedAt }, { number: "55", name: "Client Exemple", signedAt: "2026-11-16T15:30:00.000Z" });
  assert.equal(signed.order.journal.at(-1).text, "Bon de livraison n° 55 signé en ligne par Client Exemple.");
  assert.equal(signed.order.journal.at(-1).by, "client");
  await assert.rejects(workshop.signDeliveryNote(token, "55", { name: "Quelqu'un d'autre", signature }), { code: "WORKSHOP_ALREADY_SIGNED" }, "a note is signed once");

  // Read again from disk, as after a restart.
  const again = createWorkshop({ store: createFileWorkshopStore({ path: join(outputDir, "atelier.json"), clock }), documentService: documents, clock });
  assert.deepEqual((await again.clientView(token)).documents.find((entry) => entry.type === "delivery_note").signature, { name: "Client Exemple", signedAt: "2026-11-16T15:30:00.000Z", reserves: "" });
  const [kept] = (await again.order("171")).signatures;
  assert.deepEqual({ type: kept.type, number: kept.number, name: kept.name }, { type: "delivery_note", number: "55", name: "Client Exemple" });
  assert.equal(kept.ip, undefined, "the cockpit's view of the order does not carry the client's address");

  const original = await documents.readIssuedPdf("delivery_note", "55");
  const file = await again.signedDocument("171", kept.id);
  assert.equal(file.name, "bon-de-livraison-55-signe.pdf");
  const pdf = await PDFDocument.load(file.bytes);
  assert.equal(pdf.getPageCount(), (await PDFDocument.load(original.bytes)).getPageCount() + 1, "the note, then the page of the signature");
  assert.equal((await again.clientSignedDocument(token, "55")).bytes.length, file.bytes.length);
  assert.equal(await again.clientSignedDocument(token, "56"), null);
  assert.equal(fingerprint(original.bytes).length, 64);
  assert.equal(signatureMoment("2026-11-16T15:30:00.000Z"), "16/11/2026 à 16:30 (heure du Maroc)");
});

test("the link signs without an account, the direction is told, and the cockpit downloads the signed note", async (t) => {
  const { documents } = await documentsWith(t);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const token = tokenOf(await createWorkshop({ store: workshopStore, documentService: documents, clock }).openPortal("171"));
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, workshopStore, teamBook, clock });
  t.after(() => app.close());
  const url = `/api/public/suivi/${token}/documents/delivery_note/55`;

  const refused = await app.inject({ method: "POST", url: `${url}/signature`, payload: { name: "Client Exemple", signature: "rien" } });
  assert.equal(refused.statusCode, 400);
  assert.equal(JSON.parse(refused.body).details.code, "WORKSHOP_SIGNATURE_INVALID");
  assert.equal((await app.inject({ method: "GET", url: `${url}/signed` })).statusCode, 404, "nothing to read before it is signed");

  const signed = await app.inject({ method: "POST", url: `${url}/signature`, payload: { name: "Client Exemple", signature: signaturePng() } });
  assert.equal(signed.statusCode, 201, signed.body);
  assert.equal(signed.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(signed.body).signature, { number: "55", name: "Client Exemple", signedAt: "2026-11-16T15:30:00.000Z", reserves: "" });
  assert.equal((await app.inject({ method: "POST", url: `${url}/signature`, payload: { name: "Client Exemple", signature: signaturePng() } })).statusCode, 409);
  assert.equal((await app.inject({ method: "POST", url: "/api/public/suivi/inconnu/documents/delivery_note/55/signature", payload: { name: "Client Exemple", signature: signaturePng() } })).statusCode, 404);

  const read = await app.inject({ method: "GET", url: `${url}/signed` });
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers["content-type"], "application/pdf");
  assert.equal(read.rawPayload.subarray(0, 5).toString("latin1"), "%PDF-");

  assert.ok((await teamBook.activity({ agent: "commercial" })).some((entry) => entry.text === "BC 171 (Client Exemple) — bon de livraison n° 55 signé en ligne par Client Exemple."), "the team feed says who signed");
  const book = JSON.parse((await inject({ method: "GET", url: "/api/workshop" })).body);
  const [entry] = book.orders.find((candidate) => candidate.number === "171").signatures;
  assert.equal(entry.name, "Client Exemple");
  const download = await inject({ method: "GET", url: `/api/workshop/171/signatures/${entry.id}/pdf` });
  assert.equal(download.statusCode, 200);
  assert.match(download.headers["content-disposition"], /bon-de-livraison-55-signe\.pdf/);
  assert.equal((await app.inject({ method: "GET", url: `/api/workshop/171/signatures/${entry.id}/pdf` })).statusCode, 401, "the cockpit's copy needs a session");
  assert.equal((await inject({ method: "GET", url: "/api/workshop/171/signatures/inconnu/pdf" })).statusCode, 404);
});

test("the client signs with réserves: they are written on the signed note, kept on the order, and the SAV's anomaly until lifted", async (t) => {
  const { documents } = await documentsWith(t);
  const store = createMemoryWorkshopStore({ clock });
  const workshop = createWorkshop({ store, documentService: documents, clock });
  const token = tokenOf(await workshop.openPortal("171"));
  const improvement = createMemoryImprovementBook({ clock });

  await assert.rejects(workshop.signDeliveryNote(token, "55", { name: "Client Exemple", signature: signaturePng(), reserves: "x".repeat(1001) }), { code: "WORKSHOP_RESERVE_TOO_LONG" });
  await assert.rejects(workshop.signDeliveryNote(token, "55", { name: "Client Exemple", signature: signaturePng(), reserves: " a " }), { code: "WORKSHOP_RESERVE_INVALID" });
  const plain = await plainSignedSize(documents);

  const signed = await workshop.signDeliveryNote(token, "55", { name: "Client Exemple", signature: signaturePng(), reserves: "  Un tiroir   rayé.\r\n\r\nLa notice manque. " });
  assert.equal(signed.signature.reserves, "Un tiroir rayé.\nLa notice manque.");
  const [reserve] = signed.order.reserves;
  assert.deepEqual({ number: reserve.number, deliveryNote: reserve.deliveryNote, source: reserve.source, by: reserve.by, status: reserve.status }, { number: 1, deliveryNote: "55", source: "client", by: "Client Exemple", status: "ouverte" });
  assert.equal(signed.order.journal.at(-2).text, "Bon de livraison n° 55 signé en ligne par Client Exemple, avec réserves.");
  assert.match(signed.order.alerts.at(-1), /^Réserve n° 1 à la livraison, à lever : Un tiroir rayé\. ; La notice manque\./);

  // The signed note carries the réserves on the page of the signature.
  const file = await workshop.signedDocument("171", signed.order.signatures[0].id);
  assert.ok(file.bytes.length > plain, "the réserves are written on the page of the signature");

  // The client sees them, and whether they were lifted; never how.
  const view = await workshop.clientView(token);
  assert.equal(view.documents.find((entry) => entry.type === "delivery_note").signature.reserves, "Un tiroir rayé.\nLa notice manque.");
  assert.deepEqual(view.reserves.map((entry) => [entry.number, entry.status]), [[1, "ouverte"]]);

  await improvement.sync(await workshop.book());
  const [anomaly] = (await improvement.state()).anomalies;
  assert.deepEqual([anomaly.kind, anomaly.severity, anomaly.owner, anomaly.reference], ["reserve_livraison", "haute", "after_sales", "BL 55"]);
  assert.match(anomaly.fact, /réserve n° 1 à la livraison \(bon de livraison n° 55\), écrite par le client à la signature : Un tiroir rayé/);

  // The team notes one said by phone, then lifts the first one.
  await assert.rejects(workshop.addReserve("171", { deliveryNote: "99", text: "Pied bancal." }), { code: "WORKSHOP_RESERVE_NOTE_UNKNOWN" });
  await assert.rejects(workshop.addReserve("171", { text: "" }), { code: "WORKSHOP_RESERVE_INVALID" });
  const added = await workshop.addReserve("171", { text: "Pied bancal, dit au téléphone.", by: "sara" });
  assert.deepEqual([added.reserve.number, added.reserve.deliveryNote, added.reserve.source], [2, "55", "equipe"], "the only delivery note of the order");
  await assert.rejects(workshop.liftReserve("171", 1, { note: "" }), { code: "WORKSHOP_RESERVE_NOTE_MISSING" });
  await assert.rejects(workshop.liftReserve("171", 9, { note: "Fait." }), { code: "WORKSHOP_RESERVE_NOT_FOUND" });
  const lifted = await workshop.liftReserve("171", 1, { note: "Façade du tiroir remplacée, notice remise.", by: "sara" });
  assert.deepEqual([lifted.reserve.status, lifted.reserve.liftNote], ["levee", "Façade du tiroir remplacée, notice remise."]);
  await assert.rejects(workshop.liftReserve("171", 1, { note: "Encore." }), { code: "WORKSHOP_RESERVE_LIFTED" });
  assert.deepEqual((await workshop.clientView(token)).reserves.map((entry) => [entry.number, entry.status, "liftNote" in entry]), [[1, "levee", false], [2, "ouverte", false]]);

  await improvement.sync(await workshop.book());
  const anomalies = (await improvement.state()).anomalies;
  assert.deepEqual(anomalies.map((entry) => [entry.key, entry.status]), [["atelier:171:reserve:1", "levee"], ["atelier:171:reserve:2", "a_analyser"]]);
});

// The size of the same note signed without réserves, for comparison.
async function plainSignedSize(documents) {
  const other = createWorkshop({ store: createMemoryWorkshopStore({ clock }), documentService: documents, clock });
  const token = tokenOf(await other.openPortal("171"));
  const signed = await other.signDeliveryNote(token, "55", { name: "Client Exemple", signature: signaturePng() });
  return (await other.signedDocument("171", signed.order.signatures[0].id)).bytes.length;
}

test("the cockpit notes and lifts a réserve, the direction is told of one written at the signature, and the SAV gets it", async (t) => {
  const { documents } = await documentsWith(t);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const improvementBook = createMemoryImprovementBook({ clock });
  const token = tokenOf(await createWorkshop({ store: workshopStore, documentService: documents, clock }).openPortal("171"));
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, workshopStore, teamBook, improvementBook, clock });
  t.after(() => app.close());

  const signed = await app.inject({ method: "POST", url: `/api/public/suivi/${token}/documents/delivery_note/55/signature`, payload: { name: "Client Exemple", signature: signaturePng(), reserves: "Un tiroir rayé." } });
  assert.equal(signed.statusCode, 201, signed.body);
  assert.equal(JSON.parse(signed.body).signature.reserves, "Un tiroir rayé.");
  assert.ok((await teamBook.activity({ agent: "after_sales" })).some((entry) => entry.text === "BC 171 (Client Exemple) — bon de livraison n° 55 signé en ligne par Client Exemple, AVEC RÉSERVES : « Un tiroir rayé. »"));
  const reservesOf = async () => (await improvementBook.state()).anomalies.filter((entry) => entry.kind === "reserve_livraison");
  assert.deepEqual((await reservesOf()).map((entry) => [entry.kind, entry.owner, entry.status]), [["reserve_livraison", "after_sales", "a_analyser"]], "the SAV has it at once");

  assert.equal((await inject({ method: "POST", url: "/api/workshop/171/reserves", payload: { text: "" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/workshop/171/reserves", payload: { text: "Pied bancal." } })).statusCode, 401);
  const added = await inject({ method: "POST", url: "/api/workshop/171/reserves", payload: { text: "Pied bancal." } });
  assert.equal(added.statusCode, 201, added.body);
  assert.equal(JSON.parse(added.body).reserve.number, 2);

  assert.equal((await inject({ method: "POST", url: "/api/workshop/171/reserves/1/lift", payload: { note: "" } })).statusCode, 400);
  assert.equal((await inject({ method: "POST", url: "/api/workshop/171/reserves/7/lift", payload: { note: "Fait." } })).statusCode, 404);
  const lifted = await inject({ method: "POST", url: "/api/workshop/171/reserves/1/lift", payload: { note: "Façade remplacée." } });
  assert.equal(lifted.statusCode, 200, lifted.body);
  assert.equal((await inject({ method: "POST", url: "/api/workshop/171/reserves/1/lift", payload: { note: "Encore." } })).statusCode, 409);
  assert.deepEqual((await reservesOf()).map((entry) => [entry.key, entry.status]), [["atelier:171:reserve:1", "levee"], ["atelier:171:reserve:2", "a_analyser"]]);

  const order = JSON.parse((await inject({ method: "GET", url: "/api/workshop" })).body).orders.find((candidate) => candidate.number === "171");
  assert.deepEqual(order.reserves.map((entry) => [entry.number, entry.status]), [[1, "levee"], [2, "ouverte"]]);
  assert.equal(order.signatures[0].reserves, "Un tiroir rayé.");
  const client = JSON.parse((await app.inject({ method: "GET", url: `/api/public/suivi/${token}` })).body);
  assert.deepEqual(client.reserves.map((entry) => [entry.number, entry.status]), [[1, "levee"], [2, "ouverte"]]);
});

test("the SAV agent notes a réserve the client said by phone and lifts it once the team says what was done", async (t) => {
  const { documents } = await documentsWith(t);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const improvementBook = createMemoryImprovementBook({ clock });
  await createWorkshop({ store: workshopStore, documentService: documents, clock }).openPortal("171");
  const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
  const empty = { texte: "", bon_de_livraison: "", reserve: "", note: "" };
  const missions = [
    { ...empty, numero: "171", action: "noter", texte: "Une poignée manque." },
    { ...empty, numero: "171", action: "lever", reserve: "1" },
    { ...empty, numero: "171", action: "lever", reserve: "1", note: "Poignée posée le 17/11." }
  ];
  const results = [];
  const agentClient = { responses: { async create(payload) {
    const outputs = payload.input.filter((item) => item.type === "function_call_output");
    if (payload.instructions.startsWith("Tu es le Director IA")) {
      return outputs.length === 0 ? call("deleguer_a_un_agent", { agent: "after_sales", mission: "Réserves du BC 171." }, "d1") : { output_text: "Fait.", output: [] };
    }
    if (outputs.length > 0) {
      results.push(JSON.parse(outputs.at(-1).output));
    }
    return outputs.length < missions.length ? call("reserve_livraison", missions[outputs.length], `s${outputs.length}`) : { output_text: "Réserve levée.", output: [] };
  } } };
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, workshopStore, improvementBook, agentClient, clock });
  t.after(() => app.close());

  const chat = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Le client du BC 171 dit qu'une poignée manque ; elle a été posée depuis." } });
  assert.equal(chat.statusCode, 200, chat.body);
  assert.deepEqual(results.map((result) => result.ok), [true, false, true]);
  assert.equal(results[0].reserve.ecrite_par, "l'équipe (after_sales)");
  assert.match(results[1].erreur, /ce qui a été fait/, "never lifted without what was done");
  assert.match(results[2].reserve.statut, /^levée le 16\/11\/2026 : Poignée posée le 17\/11\.$/);
  assert.deepEqual((await improvementBook.state()).anomalies.filter((entry) => entry.kind === "reserve_livraison").map((entry) => entry.status), ["levee"]);
});
