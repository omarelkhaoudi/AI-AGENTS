import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { createMemoryWhatsAppInbox } from "../src/agent/whatsapp-inbox.js";
import { loadWhatsAppCloudConfig, parseWebhookMessages, verifyWebhookSignature } from "../src/integrations/whatsapp-cloud.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const clock = () => new Date("2026-11-09T10:00:00Z");
const ENV = Object.freeze({
  WHATSAPP_ACCESS_TOKEN: "test-access",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_OWNER_NUMBERS: "06 61 00 00 01, +212 6 61 00 00 02"
});

function webhook(from, text, id = `wamid.${from}.${text.length}`, name = "") {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      contacts: [{ wa_id: from, profile: { name } }],
      messages: [{ from, id, timestamp: "1762682400", type: "text", text: { body: text } }]
    } }] }]
  };
}

function signed(body, secret = ENV.WHATSAPP_APP_SECRET) {
  const raw = JSON.stringify(body);
  return { payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` } };
}

// Meta's Graph API, as far as these tests need it: it records what was sent,
// and refuses a number when told to.
function fakeMeta({ refuse = null } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, authorization: init.headers.authorization, to: body.to, text: body.text.body });
    if (refuse && body.to === refuse.to) {
      return { ok: false, status: 400, json: async () => ({ error: { code: refuse.code, message: "refused" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${sent.length}` }] }) };
  };
  return { sent, fetchImpl };
}

function fakeDirector() {
  const chats = [];
  return {
    chats,
    isConfigured: () => true,
    async chat({ message, conversationId, userId }) {
      chats.push({ message, conversationId, userId });
      return { conversationId: "conversation-1", reply: `Bien noté : ${message}`, messages: [{ recipient: "Mme Alami" }], documents: [], agentRuns: [] };
    }
  };
}

async function whatsAppApi(t, { config = loadWhatsAppCloudConfig(ENV), meta = fakeMeta(), director = fakeDirector() } = {}) {
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const inbox = createMemoryWhatsAppInbox({ clock });
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    directorAgent: director,
    teamBook,
    whatsAppConfig: config,
    whatsAppStore: inbox,
    whatsAppFetch: meta.fetchImpl,
    clock
  });
  t.after(() => app.close());
  return { app, inject, teamBook, inbox, meta, director };
}

test("the settings come from .env, and the direction's numbers are read as WhatsApp writes them", () => {
  const config = loadWhatsAppCloudConfig(ENV);
  assert.equal(config.configured, true);
  assert.deepEqual(config.ownerNumbers, ["212661000001", "212661000002"]);
  const partial = loadWhatsAppCloudConfig({ WHATSAPP_ACCESS_TOKEN: "x" });
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.missing, ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]);
});

test("a webhook call is read into messages, and only Meta's signature lets it in", () => {
  const body = webhook("212661000001", "Bonjour", "wamid.1", "Hiba");
  assert.deepEqual(parseWebhookMessages(body).map((message) => [message.id, message.from, message.name, message.text]), [["wamid.1", "212661000001", "Hiba", "Bonjour"]]);
  assert.deepEqual(parseWebhookMessages({ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] }), [], "delivery statuses are not messages");
  const { payload, headers } = signed(body);
  assert.equal(verifyWebhookSignature(Buffer.from(payload), headers["x-hub-signature-256"], ENV.WHATSAPP_APP_SECRET), true);
  assert.equal(verifyWebhookSignature(Buffer.from(payload), headers["x-hub-signature-256"], "another-secret"), false);
  assert.equal(verifyWebhookSignature(Buffer.from(payload), undefined, ENV.WHATSAPP_APP_SECRET), false);
});

test("Meta's subscription is accepted with the verify token only", async (t) => {
  const { app } = await whatsAppApi(t);
  const ok = await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=4242" });
  assert.deepEqual([ok.statusCode, ok.body], [200, "4242"]);
  assert.equal((await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242" })).statusCode, 403);
});

test("the direction talks to the Director on WhatsApp, the team reports back, and a client waits for a person", async (t) => {
  const { app, inject, teamBook, meta, director } = await whatsAppApi(t);

  const unsigned = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: JSON.stringify(webhook("212661000001", "Bonjour")), headers: { "content-type": "application/json" } });
  assert.equal(unsigned.statusCode, 401);
  assert.equal(director.chats.length, 0);

  // The direction: an order to the Director, answered on WhatsApp.
  const order = signed(webhook("212661000001", "J'ai reçu 3000 DH de Mme Alami", "wamid.a"));
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...order })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...order })).statusCode, 200, "Meta may send the same call twice");
  await app.whatsApp.idle();
  assert.deepEqual(director.chats, [{ message: "J'ai reçu 3000 DH de Mme Alami", conversationId: null, userId: "whatsapp:212661000001" }], "handled once");
  assert.equal(meta.sent.length, 1);
  assert.equal(meta.sent[0].to, "212661000001");
  assert.equal(meta.sent[0].authorization, "Bearer test-access");
  assert.match(meta.sent[0].url, /\/1234567890\/messages$/);
  assert.match(meta.sent[0].text, /Bien noté : J'ai reçu 3000 DH/);
  assert.match(meta.sent[0].text, /1 message\(s\) préparé\(s\) : à relire et envoyer depuis le cockpit/);

  // The next message continues the same conversation.
  await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...signed(webhook("212661000001", "Et le bilan ?", "wamid.b")) });
  await app.whatsApp.idle();
  assert.equal(director.chats[1].conversationId, "conversation-1");

  // A team member: a report in the team feed, acknowledged, never an order.
  await teamBook.link("production", { name: "Youssef", role: "chef d'atelier", phone: "0612345678" });
  await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...signed(webhook("212612345678", "Découpe du BC 171 finie", "wamid.c")) });
  await app.whatsApp.idle();
  assert.equal(director.chats.length, 2);
  const report = (await teamBook.activity({ agent: "production" })).find((entry) => entry.kind === "compte_rendu");
  assert.match(report.text, /Youssef.*Découpe du BC 171 finie/);
  assert.equal(meta.sent.at(-1).to, "212612345678");
  assert.match(meta.sent.at(-1).text, /Bien reçu, Youssef/);
  assert.ok((await teamBook.newsFor("production")).some((entry) => entry.kind === "compte_rendu"), "the agent reads its own human's report");

  // Anyone else: kept for the cockpit, nobody answers automatically.
  const before = meta.sent.length;
  await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...signed(webhook("212677000000", "Bonjour, où en est mon lit ?", "wamid.d", "Mme Alami")) });
  await app.whatsApp.idle();
  assert.equal(meta.sent.length, before);
  assert.equal(director.chats.length, 2);

  const listed = JSON.parse((await inject({ method: "GET", url: "/api/whatsapp" })).body);
  assert.equal(listed.configured, true);
  assert.equal(listed.owners, 2);
  const client = listed.messages.find((message) => message.number === "212677000000");
  assert.deepEqual([client.direction, client.sender, client.name], ["in", "contact", "Mme Alami"]);

  // A person answers from the cockpit.
  const answer = await inject({ method: "POST", url: "/api/whatsapp/send", payload: { to: "+212 6 77 00 00 00", message: "Bonjour Madame, votre lit part demain.", recipient: "Mme Alami", kind: "reponse" } });
  assert.equal(answer.statusCode, 201, answer.body);
  assert.deepEqual([meta.sent.at(-1).to, meta.sent.at(-1).text], ["212677000000", "Bonjour Madame, votre lit part demain."]);
  assert.equal((await inject({ method: "POST", url: "/api/whatsapp/send", payload: { to: "pas un numéro", message: "x" } })).statusCode, 400);
});

test("outside the 24-hour window Meta refuses a free message, and the cockpit is told so", async (t) => {
  const meta = fakeMeta({ refuse: { to: "212677000000", code: 131047 } });
  const { inject, inbox } = await whatsAppApi(t, { meta });
  const refused = await inject({ method: "POST", url: "/api/whatsapp/send", payload: { to: "0677000000", message: "Relance", recipient: "Mme Alami" } });
  assert.equal(refused.statusCode, 409);
  assert.equal(JSON.parse(refused.body).details.code, "WHATSAPP_WINDOW_CLOSED");
  assert.equal((await inbox.messages())[0].status, "failed", "the failure is kept");
});

test("without the WHATSAPP_* keys the webhook stays closed and nothing is sent", async (t) => {
  const meta = fakeMeta();
  const { app, inject } = await whatsAppApi(t, { config: loadWhatsAppCloudConfig({}), meta });
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...signed(webhook("212661000001", "Bonjour")) })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1" })).statusCode, 403);
  assert.equal((await inject({ method: "POST", url: "/api/whatsapp/send", payload: { to: "0677000000", message: "x" } })).statusCode, 503);
  const status = JSON.parse((await inject({ method: "GET", url: "/api/whatsapp" })).body);
  assert.equal(status.configured, false);
  assert.equal(status.missing.length, 4);
  assert.equal(meta.sent.length, 0);
});
