import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemorySocialInbox } from "../src/agent/social-inbox.js";
import { socialTools } from "../src/agent/social-tools.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { createMetaSocialClient, loadMetaSocialConfig, parseMetaWebhook } from "../src/integrations/meta-social.js";
import { createSocialService } from "../src/social/social-service.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const NOW = new Date("2026-11-16T10:00:00Z");
const clock = () => NOW;
const ENV = Object.freeze({
  META_PAGE_ID: "page-1",
  META_PAGE_ACCESS_TOKEN: "test-page-token",
  META_INSTAGRAM_ID: "ig-1",
  META_VERIFY_TOKEN: "test-verify",
  META_APP_SECRET: "test-secret"
});
const config = loadMetaSocialConfig(ENV);

// Meta's Graph API as far as these tests need it: it records each call and
// answers as Meta does, or refuses when told to.
function fakeGraph({ refuse = null, containerStatus = ["IN_PROGRESS", "FINISHED"] } = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/v\d+\.\d+\//, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, authorization: init.headers?.authorization, url });
    const answer = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
    if (refuse && refuse.path === path) {
      return answer({ error: { message: "refused", code: refuse.code ?? 100, error_subcode: refuse.subcode } }, 400);
    }
    if (path === "page-1/messages") return answer({ recipient_id: body.recipient.id, message_id: "m_out_1" });
    if (path.endsWith("/replies") || path.endsWith("/comments")) return answer({ id: "reply-1" });
    if (path === "ig-1/media" && init.method === "POST") return answer({ id: "container-1" });
    if (path === "container-1") return answer({ status_code: containerStatus[Math.min(polls++, containerStatus.length - 1)] });
    if (path === "ig-1/media_publish") return answer({ id: "ig-post-1" });
    if (path === "page-1/photos") return answer({ id: "photo-1", post_id: "page-1_post-1" });
    if (path === "page-1/feed") return answer({ id: "page-1_post-2" });
    if (path === "page-1") return answer({ name: "H-Kids", followers_count: 1200 });
    if (path === "page-1/posts") return answer({ data: [{ id: "p1", message: "Lit cabane", created_time: "2026-11-10", reactions: { summary: { total_count: 40 } }, comments: { summary: { total_count: 5 } } }] });
    if (path === "ig-1") return answer({ username: "hkids.ma", followers_count: 5400, media_count: 210 });
    if (path === "ig-1/media") return answer({ data: [{ id: "i1", caption: "Chambre Montessori", like_count: 320, comments_count: 18 }] });
    return answer({ error: { message: `unexpected ${path}` } }, 404);
  };
  return { calls, fetchImpl };
}

function instagramMessage(text, mid = "mid.1", sender = "igsid-42") {
  return { object: "instagram", entry: [{ id: "ig-1", time: 1794823200000, messaging: [{ sender: { id: sender }, recipient: { id: "ig-1" }, timestamp: 1794823200000, message: { mid, text } }] }] };
}

function signed(body, secret = ENV.META_APP_SECRET) {
  const raw = JSON.stringify(body);
  return { payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` } };
}

function service({ graph = fakeGraph(), connected = true } = {}) {
  const repository = new InMemoryRepository();
  const inbox = createMemorySocialInbox({ clock });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const client = connected ? createMetaSocialClient({ config, fetchImpl: graph.fetchImpl, sleep: async () => {} }) : null;
  const social = createSocialService({ inbox, client, config: connected ? config : loadMetaSocialConfig({}), repository, teamBook, clock });
  return { social, repository, inbox, teamBook, graph };
}

test("the settings come from .env; without the app secret the Page is not connected", () => {
  assert.equal(config.configured, true);
  assert.equal(config.apiVersion, "v27.0");
  const partial = loadMetaSocialConfig({ META_PAGE_ID: "x" });
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.missing, ["META_PAGE_ACCESS_TOKEN", "META_VERIFY_TOKEN", "META_APP_SECRET"]);
  assert.equal(createMetaSocialClient({ config: partial }), null);
});

test("a webhook call is read into messages and comments, without the company's own echoes", () => {
  const events = [
    ...parseMetaWebhook(instagramMessage("Bonjour, combien coûte le lit château ?"), config),
    ...parseMetaWebhook({ object: "instagram", entry: [{ id: "ig-1", time: 1794823200, messaging: [{ sender: { id: "ig-1" }, recipient: { id: "igsid-42" }, timestamp: 1794823200000, message: { mid: "mid.echo", text: "Merci", is_echo: true } }], changes: [{ field: "comments", value: { id: "c-1", text: "Prix ?", from: { id: "igsid-7", username: "salma" }, media: { id: "media-9" } } }] }] }, config),
    ...parseMetaWebhook({ object: "page", entry: [{ id: "page-1", time: 1794823200, changes: [
      { field: "feed", value: { item: "comment", verb: "add", comment_id: "fbc-1", post_id: "page-1_post-1", message: "Livrez-vous à Rabat ?", from: { id: "fb-9", name: "Karim B." }, created_time: 1794823200 } },
      { field: "feed", value: { item: "reaction", verb: "add", from: { id: "fb-9" } } },
      { field: "feed", value: { item: "comment", verb: "add", comment_id: "fbc-2", message: "Merci !", from: { id: "page-1", name: "H-Kids" } } }
    ] }] }, config)
  ];
  assert.deepEqual(events.map((event) => [event.kind, event.platform, event.externalId, event.senderName, event.text]), [
    ["message", "instagram", "mid.1", "", "Bonjour, combien coûte le lit château ?"],
    ["comment", "instagram", "c-1", "@salma", "Prix ?"],
    ["comment", "facebook", "fbc-1", "Karim B.", "Livrez-vous à Rabat ?"]
  ]);
  assert.equal(events[0].at, "2026-11-16T10:00:00.000Z");
  assert.deepEqual(parseMetaWebhook({ object: "whatsapp_business_account", entry: [] }, config), []);
});

test("the client sends with the Page token in the header, and tells when the 24-hour window is closed", async () => {
  const graph = fakeGraph();
  const client = createMetaSocialClient({ config, fetchImpl: graph.fetchImpl, sleep: async () => {} });
  assert.equal(await client.sendMessage({ platform: "instagram", recipientId: "igsid-42", text: "Bonjour !" }), "m_out_1");
  assert.deepEqual(graph.calls[0].body, { recipient: { id: "igsid-42" }, messaging_type: "RESPONSE", message: { text: "Bonjour !" } });
  assert.equal(graph.calls[0].authorization, "Bearer test-page-token");
  assert.equal(graph.calls[0].url.includes("test-page-token"), false, "the token never travels in a URL");
  await client.replyToComment({ platform: "instagram", commentId: "c-1", text: "Merci" });
  await client.replyToComment({ platform: "facebook", commentId: "fbc-1", text: "Merci" });
  assert.deepEqual(graph.calls.slice(1).map((call) => call.path), ["c-1/replies", "fbc-1/comments"]);
  await assert.rejects(client.sendMessage({ platform: "instagram", recipientId: "x", text: "a".repeat(1001) }), { code: "META_TEXT_TOO_LONG" });

  const closed = createMetaSocialClient({ config, fetchImpl: fakeGraph({ refuse: { path: "page-1/messages", code: 10, subcode: 2534022 } }).fetchImpl });
  await assert.rejects(closed.sendMessage({ platform: "instagram", recipientId: "igsid-42", text: "Bonjour" }), { code: "META_OUTSIDE_WINDOW" });
});

test("Instagram publishes a picture once Meta prepared it; Facebook a photo or a text", async () => {
  const graph = fakeGraph();
  const client = createMetaSocialClient({ config, fetchImpl: graph.fetchImpl, sleep: async () => {} });
  assert.equal(await client.publish({ channel: "instagram", caption: "Nouveau lit", imageUrl: "https://cdn.example/lit.jpg" }), "ig-post-1");
  assert.deepEqual(graph.calls.map((call) => call.path), ["ig-1/media", "container-1", "container-1", "ig-1/media_publish"]);
  assert.deepEqual(graph.calls[0].body, { image_url: "https://cdn.example/lit.jpg", caption: "Nouveau lit" });
  await assert.rejects(client.publish({ channel: "instagram", caption: "Sans photo" }), { code: "META_IMAGE_REQUIRED" });
  assert.equal(await client.publish({ channel: "facebook", caption: "Photo", imageUrl: "https://cdn.example/lit.jpg" }), "page-1_post-1");
  assert.equal(await client.publish({ channel: "facebook", caption: "Texte seul" }), "page-1_post-2");
  assert.deepEqual(graph.calls.at(-2).body, { url: "https://cdn.example/lit.jpg", caption: "Photo" });
  const failing = createMetaSocialClient({ config, fetchImpl: fakeGraph({ containerStatus: ["ERROR"] }).fetchImpl, sleep: async () => {} });
  await assert.rejects(failing.publish({ channel: "instagram", caption: "x", imageUrl: "https://cdn.example/x.png" }), { code: "META_MEDIA_FAILED" });
});

test("a message is recorded once, its reply waits for the direction, and only the approval sends it", async () => {
  const { social, repository, graph, teamBook } = service();
  const first = await social.receive(instagramMessage("Bonjour, combien coûte le lit château ?"));
  assert.equal((await social.receive(instagramMessage("Bonjour, combien coûte le lit château ?"))).length, 0, "Meta may send the same call twice");
  assert.equal((await teamBook.activity({ agent: "community_manager" }))[0].text.startsWith("Instagram — message de un abonné"), true);

  const { reply, approval } = await social.proposeReply({ itemId: first[0].id, text: "Bonjour ! Pour quelle dimension ?", by: "community_manager" });
  assert.equal(approval.requestedAction, "reply_social_message");
  assert.match(approval.reason, /combien coûte le lit château/);
  assert.equal(graph.calls.length, 0, "nothing is sent before the direction's word");
  await assert.rejects(social.proposeReply({ itemId: first[0].id, text: "Autre", by: "community_manager" }), { code: "SOCIAL_REPLY_PENDING" });

  const approved = await repository.approveApproval(approval.id, { approverId: "hiba" });
  const decided = await social.decideReply(approved);
  assert.equal(decided.sent, true);
  assert.equal(decided.reply.status, "envoyee");
  assert.equal(graph.calls[0].body.recipient.id, "igsid-42");
  assert.equal((await social.item(first[0].id)).status, "repondu");
  assert.equal((await social.decideReply(approved)).sent, false, "a decision is carried once");
  assert.equal(reply.status, "a_valider");
});

test("a refused reply sends nothing, and without Meta's keys an approved one says it could not leave", async () => {
  const { social, repository, graph } = service();
  const [item] = await social.receive(instagramMessage("Salam"));
  const { approval } = await social.proposeReply({ itemId: item.id, text: "Salam !", by: "community_manager" });
  const refused = await social.decideReply(await repository.rejectApproval(approval.id, { approverId: "hiba" }));
  assert.equal(refused.reply.status, "refusee");
  assert.equal(graph.calls.length, 0);
  assert.equal((await social.item(item.id)).status, "nouveau", "the message waits for another answer");

  const offline = service({ connected: false });
  const [waiting] = await offline.social.receive(instagramMessage("Bonjour"));
  const pending = await offline.social.proposeReply({ itemId: waiting.id, text: "Bonjour !", by: "community_manager" });
  const result = await offline.social.decideReply(await offline.repository.approveApproval(pending.approval.id, { approverId: "hiba" }));
  assert.equal(result.reply.status, "echec");
  assert.match(result.reply.error, /pas encore reliés/);
});

// Law 09-08: the first private answer to a person tells who processes their
// data and where to exercise their rights; the following ones do not repeat it,
// a public comment never carries it, and a refused answer did not count.
test("the first private answer to a person carries the 09-08 notice, once", async () => {
  const { social, repository } = service();
  const notice = /Loi 09-08 : H KIDS traite vos données .* hkidsmaroc@gmail\.com\./;
  const [first] = await social.receive(instagramMessage("Bonjour", "mid.a"));
  const refused = await social.proposeReply({ itemId: first.id, text: "Bonjour !", by: "community_manager" });
  assert.match(refused.reply.text, notice);
  assert.match(refused.approval.reason, notice, "the direction sees it before approving");
  await social.decideReply(await repository.rejectApproval(refused.approval.id, { approverId: "hiba" }));

  const again = await social.proposeReply({ itemId: first.id, text: "Bonjour, que cherchez-vous ?", by: "community_manager" });
  assert.match(again.reply.text, notice, "the refused one never reached them");
  await social.decideReply(await repository.approveApproval(again.approval.id, { approverId: "hiba" }));

  const [second] = await social.receive(instagramMessage("Et le prix ?", "mid.b"));
  const later = await social.proposeReply({ itemId: second.id, text: "3 000 DH.", by: "community_manager" });
  assert.equal(later.reply.text, "3 000 DH.");

  const [other] = await social.receive(instagramMessage("Salam", "mid.c", "igsid-77"));
  assert.match((await social.proposeReply({ itemId: other.id, text: "Salam !", by: "community_manager" })).reply.text, notice);
});

test("the CM qualifies a prospect and hands it to the Commercial, who sees it in its news", async () => {
  const { social, teamBook } = service();
  const [item] = await social.receive(instagramMessage("Bonjour, je veux un lit cabane pour 2 enfants à Casablanca"));
  const prospect = await social.upsertProspect({ itemId: item.id, fields: { nom: "Salma", ville: "Casablanca" }, by: "community_manager" });
  assert.equal(prospect.id, "P-001");
  assert.equal(prospect.reseau, "instagram");
  await assert.rejects(social.handOver({ id: "P-001", by: "community_manager" }), { code: "SOCIAL_PROSPECT_INCOMPLETE" });
  await social.upsertProspect({ id: "P-001", fields: { besoin: "Lit cabane superposé, 2 enfants" }, status: "qualifie", by: "community_manager" });
  const handed = await social.handOver({ id: "P-001", note: "Demande des dimensions de la chambre", by: "community_manager" });
  assert.equal(handed.status, "transmis");
  assert.deepEqual(handed.history.map((entry) => entry.status), ["nouveau", "qualifie", "transmis"]);
  const news = await teamBook.newsFor("commercial");
  assert.match(news.at(-1).text, /P-001 transmis au Commercial.*Salma — Casablanca — Lit cabane superposé/);
  assert.equal((await social.item(item.id)).prospect, "P-001");
});

test("a post waits for approval, then leaves at its time with its hashtags", async () => {
  const { social, repository, graph } = service();
  await assert.rejects(social.proposePublication({ channel: "instagram", caption: "Sans photo", date: "2026-11-20", time: "18:00", by: "marketing" }), { code: "SOCIAL_IMAGE_REQUIRED" });
  await assert.rejects(social.proposePublication({ channel: "facebook", caption: "Hier", date: "2026-11-15", time: "18:00", by: "marketing" }), { code: "PUBLICATION_SCHEDULE_IN_PAST" });
  const { publication, approval } = await social.proposePublication({ channel: "instagram", caption: "Le lit château", hashtags: ["#HKids", "chambreenfant"], date: "2026-11-20", time: "18:30", imageUrl: "https://cdn.example/chateau.jpg", by: "marketing" });
  assert.equal(publication.status, "pending_approval");
  assert.equal(publication.scheduledAt, "2026-11-20T17:30:00.000Z", "18:30 in Morocco (UTC+1)");
  assert.match(approval.reason, /20 à 18:30|2026-11-20 à 18:30/);

  assert.deepEqual(await social.publishDue(new Date("2026-11-21T00:00:00Z")), { published: [], failed: [] }, "nothing leaves before approval");
  await repository.approveApproval(approval.id, { approverId: "hiba" });
  const { applyPublicationApprovalDecision } = await import("../src/social/publication-service.js");
  await applyPublicationApprovalDecision(repository, approval.id);
  assert.equal((await social.publishDue(new Date("2026-11-20T17:00:00Z"))).published.length, 0, "not before its time");
  assert.equal((await repository.getPublication(publication.id)).status, "scheduled");
  const { published } = await social.publishDue(new Date("2026-11-20T17:31:00Z"));
  assert.equal(published[0].status, "published");
  assert.equal(published[0].externalId, "ig-post-1");
  assert.equal(graph.calls[0].body.caption, "Le lit château\n\n#HKids #chambreenfant");
});

test("the CM holds all the tools, Marketing the posts and the figures, the Commercial the prospects", async () => {
  const { social } = service();
  const names = (agent) => socialTools({ social }, agent).map((entry) => entry.tool.name);
  assert.deepEqual(names("community_manager"), ["boite_reseaux", "preparer_reponse_reseaux", "fiche_prospect", "transmettre_prospect", "prospects_reseaux", "preparer_publication", "statistiques_reseaux"]);
  assert.deepEqual(names("marketing"), ["preparer_publication", "statistiques_reseaux", "prospects_reseaux"]);
  assert.deepEqual(names("commercial"), ["prospects_reseaux", "fiche_prospect"]);
  assert.deepEqual(names("finance"), []);

  await social.receive(instagramMessage("Combien pour une chambre complète ?"));
  const tools = Object.fromEntries(socialTools({ social }, "community_manager").map((entry) => [entry.tool.name, entry.run]));
  const inbox = await tools.boite_reseaux({ statut: "a_traiter" });
  assert.equal(inbox.messages[0].type, "message privé");
  const answer = await tools.preparer_reponse_reseaux({ message_id: inbox.messages[0].id, reponse: "Avec plaisir ! Quelles dimensions ?" });
  assert.match(answer.statut, /À valider/);
  assert.equal((await tools.preparer_reponse_reseaux({ message_id: "inconnu", reponse: "x" })).ok, false);
  const post = await tools.preparer_publication({ reseau: "facebook", texte: "Portes ouvertes samedi", hashtags: [], date: "21/11/2026", heure: "10:00", image_url: "" });
  assert.equal(post.ok, true);
  const stats = await tools.statistiques_reseaux({});
  assert.equal(stats.instagram.abonnes, 5400);
  assert.equal(stats.facebook.publications[0].reactions, 40);
  assert.equal(stats.cockpit.messages_a_traiter, 0, "the message has a reply waiting for approval");
});

test("the server: Meta's webhook is signed, and approving the reply in « À valider » sends it", async (t) => {
  const graph = fakeGraph();
  const repository = new InMemoryRepository();
  const socialStore = createMemorySocialInbox({ clock });
  const { app, inject } = await buildAuthenticatedApi({
    repository,
    directorAgent: { isConfigured: () => false, chat: async () => ({}) },
    socialConfig: config,
    socialStore,
    socialFetch: graph.fetchImpl,
    whatsAppTranscriber: null,
    clock
  });
  t.after(() => app.close());

  const challenge = await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=77" });
  assert.deepEqual([challenge.statusCode, challenge.body], [200, "77"]);
  assert.equal((await app.inject({ method: "GET", url: "/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=77" })).statusCode, 403);
  const body = instagramMessage("Bonjour, prix du lit cabane ?");
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/meta", payload: JSON.stringify(body), headers: { "content-type": "application/json" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/webhooks/meta", ...signed(body) })).statusCode, 200);

  const listed = JSON.parse((await inject({ method: "GET", url: "/api/social" })).body);
  assert.equal(listed.connecte, true);
  assert.equal(listed.items.length, 1);

  const service = createSocialService({ inbox: socialStore, client: null, config, repository, clock });
  const { approval } = await service.proposeReply({ itemId: listed.items[0].id, text: "Bonjour ! Pour quelles dimensions ?", by: "community_manager" });
  const approved = await inject({ method: "POST", url: `/api/approvals/${approval.id}/approve`, payload: {} });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(JSON.parse(approved.body).socialReply.reply.status, "envoyee");
  assert.match(graph.calls.at(-1).body.message.text, /^Bonjour ! Pour quelles dimensions \?\n\nLoi 09-08 : /, "the first private answer carries the 09-08 notice");
});
