import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { decisionWord } from "../src/agent/whatsapp-gateway.js";
import { loadWhatsAppCloudConfig } from "../src/integrations/whatsapp-cloud.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 4: the ERP is driven from WhatsApp. A document the Director
// prepared comes as a PDF marked as a preview, is generated when the direction
// answers « valide », and the generated PDF is sent back. Nothing is generated
// without that word. Invented client and figures only.

const ENV = Object.freeze({
  WHATSAPP_ACCESS_TOKEN: "test-access",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_OWNER_NUMBERS: "06 61 00 00 01"
});
const OWNER = "212661000001";
const QUOTE = {
  documentType: "quote", documentNumber: "172", date: "14/11/2026", object: "Lit cabane", client: { name: "Client Exemple", address: "Marrakech" },
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 2500, amountHt: 2500 }],
  totals: { totalHt: 2500, tva: 500, totalTtc: 3000 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};

function inbound(body, id) {
  return { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: OWNER, profile: { name: "" } }], messages: [{ from: OWNER, id, timestamp: "1763114400", type: "text", text: { body } }] } }] }] };
}
function signed(body) {
  const raw = JSON.stringify(body);
  return { payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.WHATSAPP_APP_SECRET).update(raw).digest("hex")}` } };
}

// Meta's Graph API: texts, uploads and documents, as these tests need them.
function fakeMeta() {
  const texts = [];
  const files = [];
  const uploads = new Map();
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/media")) {
      const file = init.body.get("file");
      const id = `media-${uploads.size + 1}`;
      uploads.set(id, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
    const body = JSON.parse(init.body);
    if (body.type === "document") {
      files.push({ to: body.to, filename: body.document.filename, caption: body.document.caption ?? "", bytes: uploads.get(body.document.id).bytes });
    } else {
      texts.push(body.text.body);
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${texts.length + files.length}` }] }) };
  };
  return { texts, files, fetchImpl };
}

test("the direction's words on what waits are told from messages for the Director", () => {
  assert.deepEqual(decisionWord("Je valide le devis 172"), { action: "valider", number: "172" });
  assert.deepEqual(decisionWord("oui, validé !"), { action: "valider", number: null });
  assert.deepEqual(decisionWord("annule"), { action: "annuler", number: null });
  assert.deepEqual(decisionWord("ok envoie le message"), { action: "envoyer", number: null });
  for (const said of ["valide le planning de demain", "envoie-moi le devis 170", "annule la commande de Mme Salma", "bonjour"]) {
    assert.equal(decisionWord(said), null, said);
  }
});

test("a quote prepared on WhatsApp comes as a preview PDF and is generated on « valide »", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-whatsapp-docs-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir });
  const meta = fakeMeta();
  const chats = [];
  const { app } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    directorAgent: {
      isConfigured: () => true,
      chat: async (request) => {
        chats.push(request);
        return { conversationId: "c1", reply: "Le Commercial a préparé le devis n° 172.", messages: [], documents: [{ input: QUOTE, preview: await documents.preview(QUOTE), preparedBy: "commercial", replaces: false }], agentRuns: [], foundDocuments: [], exports: [{ name: "2026-11-14_devis.xlsx", title: "Devis de novembre", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: Buffer.from("xlsx").toString("base64") }] };
      }
    },
    whatsAppConfig: loadWhatsAppCloudConfig(ENV),
    whatsAppFetch: meta.fetchImpl,
    whatsAppTranscriber: null
  });
  t.after(() => app.close());
  const post = async (body, id) => {
    assert.equal((await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...signed(inbound(body, id)) })).statusCode, 200);
    await app.whatsApp.idle();
  };

  await post("Fais un devis pour Client Exemple, un lit cabane à 3000 DH", "wamid.in.1");
  assert.equal(chats[0].channel, "whatsapp", "the Director knows it answers on WhatsApp");
  assert.match(meta.texts[0], /Devis n° 172 préparé : l'aperçu PDF suit\. Répondez « valide »/);
  assert.equal(meta.files.length, 2, "the preview, then the Excel file of the answer");
  assert.equal(meta.files[0].filename, "APERCU_Devis-n-172.pdf");
  assert.match(meta.files[0].caption, /Aperçu à valider — Devis n° 172 — Client Exemple — 3 000 DH TTC/);
  assert.equal(meta.files[0].bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.equal(meta.files[1].filename, "2026-11-14_devis.xlsx");
  assert.equal(await documents.readIssued("quote", "172"), null, "nothing is generated before the direction's word");

  await post("valide", "wamid.in.2");
  assert.equal(chats.length, 1, "the word is a decision, not a message for the Director");
  assert.match(meta.texts.at(-1), /Devis n° 172 généré pour Client Exemple : 3 000 DH TTC\./);
  assert.match(meta.files.at(-1).filename, /^devis_HKIDS_172_/);
  assert.ok((await documents.readIssued("quote", "172")), "the quote is issued under its number");

  await post("valide", "wamid.in.3");
  assert.equal(chats.length, 2, "with nothing waiting, « valide » goes to the Director like any message");
});

test("« annule » drops what waits, and nothing is generated", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-whatsapp-docs-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir });
  const meta = fakeMeta();
  const { app } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    directorAgent: { isConfigured: () => true, chat: async () => ({ conversationId: "c1", reply: "Devis prêt.", messages: [{ agent: "commercial", recipient: "Client Exemple", kind: "relance_devis", phone: "212600000009", message: "Bonjour Madame, votre devis est prêt." }], documents: [{ input: QUOTE, preview: await documents.preview(QUOTE), replaces: false }], agentRuns: [] }) },
    whatsAppConfig: loadWhatsAppCloudConfig(ENV),
    whatsAppFetch: meta.fetchImpl,
    whatsAppTranscriber: null
  });
  t.after(() => app.close());
  const post = async (body, id) => {
    await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...signed(inbound(body, id)) });
    await app.whatsApp.idle();
  };

  await post("Un devis pour Client Exemple", "wamid.in.1");
  assert.match(meta.texts[0], /Message préparé pour Client Exemple \(212600000009\)/);
  assert.match(meta.texts[0], /Répondez « envoie » pour l'envoyer/);
  await post("envoie", "wamid.in.2");
  assert.equal(meta.texts.at(-2), "Bonjour Madame, votre devis est prêt.", "the message leaves for the client");
  assert.equal(meta.texts.at(-1), "Message envoyé à Client Exemple.");
  await post("annule", "wamid.in.3");
  assert.match(meta.texts.at(-1), /Abandonné : Devis n° 172\. Rien n'a été généré ni envoyé\./);
  assert.equal(await documents.readIssued("quote", "172"), null);
});
