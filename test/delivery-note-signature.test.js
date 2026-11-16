import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
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
  assert.deepEqual((await again.clientView(token)).documents.find((entry) => entry.type === "delivery_note").signature, { name: "Client Exemple", signedAt: "2026-11-16T15:30:00.000Z" });
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
  assert.deepEqual(JSON.parse(signed.body).signature, { number: "55", name: "Client Exemple", signedAt: "2026-11-16T15:30:00.000Z" });
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
