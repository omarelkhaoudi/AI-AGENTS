import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { createFileWorkshopStore, createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// The client's follow-up link: an unguessable address per purchase order, where
// the client sees the real progress, the finished steps, the planned delivery,
// the payment schedule, the published photos and the documents of the sale, and
// nothing that stays inside the company. Invented clients and figures only.

const NOW = new Date("2026-11-06T09:00:00Z");
const clock = () => NOW;
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-portal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote",
  documentNumber: "170",
  date: "02/11/2026",
  object: "Lit cabane",
  client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const otherQuote = { ...quote, documentNumber: "180", client: { name: "Autre Client", address: "Rabat" }, object: "Bureau" };
const order = {
  ...quote,
  documentType: "purchase_order",
  documentNumber: "171",
  date: "03/11/2026",
  payment: { termsRule: "hkids-po-50-50" },
  specifications: ["Bois clair"],
  quoteReference: "170"
};

async function documentsWith(t, ...inputs) {
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: await tempDir(t) });
  for (const input of inputs) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  return documents;
}

const tokenOf = (link) => link.path.split("/").at(-1);

test("a link is made once, switched off for good, and a new one replaces it", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const workshop = createWorkshop({ store: createMemoryWorkshopStore({ clock }), documentService: documents, clock });

  await assert.rejects(workshop.openPortal("999"), { code: "WORKSHOP_ORDER_NOT_FOUND" });
  const first = await workshop.openPortal("171");
  assert.match(first.path, /^\/suivi\/[A-Za-z0-9_-]{32}$/);
  assert.equal(first.url, null, "no public address configured: the path only");
  assert.deepEqual(await workshop.openPortal("171"), first, "asking again gives the same link");
  assert.equal((await workshop.order("171")).portal.path, first.path);

  const closed = await workshop.closePortal("171");
  assert.equal(closed.portal, null);
  assert.equal(await workshop.clientView(tokenOf(first)), null, "a link switched off opens nothing");

  const second = await workshop.openPortal("171");
  assert.notEqual(second.path, first.path, "a link switched off is never switched back on");
  assert.ok(await workshop.clientView(tokenOf(second)));
  assert.equal(await workshop.clientView(tokenOf(first)), null);
  assert.deepEqual((await workshop.order("171")).journal.map((entry) => entry.text), [
    "Lien de suivi client créé.",
    "Lien de suivi client désactivé.",
    "Lien de suivi client créé."
  ]);

  const configured = createWorkshop({ store: createMemoryWorkshopStore({ clock }), documentService: documents, clock, publicBaseUrl: "https://cockpit.example.ma/" });
  const link = await configured.openPortal("171");
  assert.equal(link.url, `https://cockpit.example.ma${link.path}`);
});

test("the client sees progress, steps, delivery and schedule, never a note, a person in charge or why a step is blocked", async (t) => {
  const documents = await documentsWith(t, quote, otherQuote, order);
  const store = createMemoryWorkshopStore({ clock });
  const workshop = createWorkshop({ store, documentService: documents, clock });
  await workshop.advance("171", "etude_technique", { status: "terminee", responsible: "Youssef", doneDate: "04/11/2026", note: "Plans revus par Karim" });
  await workshop.setTeam("171", { lead: "Samir", architect: "Cabinet Bennani", architectPhone: "0612345678", liaison: "Youssef", drafter: "Karim" });
  const drawing = await workshop.depositCncFile("171", { content: Buffer.from("G21\nG0 X0 Y0\nM30\n"), name: "panneaux-171.nc", note: "MDF 18 mm" });
  await workshop.decideCncFile("171", drawing, { approve: true });
  await workshop.advance("171", "approvisionnement", { status: "terminee" });
  await workshop.advance("171", "decoupe_cnc", { status: "bloquee", responsible: "Samir", note: "Panneaux en rupture chez le fournisseur" });
  await workshop.advance("171", "livraison_installation", { plannedDate: "20/11/2026" });
  const token = tokenOf(await workshop.openPortal("171"));

  const view = await workshop.clientView(token);

  assert.deepEqual(view.order, { number: "171", date: "03/11/2026", object: "Lit cabane", client: "Client Exemple" });
  assert.deepEqual(view.progress, { done: 3, total: 8, percent: 38 });
  assert.equal(view.finished, false);
  assert.deepEqual(view.steps.slice(0, 5).map((step) => [step.label, step.state, step.doneDate]), [
    ["Étude technique", "terminee", "2026-11-04"],
    ["Dessin CNC", "terminee", "2026-11-06"],
    ["Approvisionnement", "terminee", "2026-11-06"],
    ["Découpe CNC", "en_cours", null],
    ["Assemblage", "a_venir", null]
  ]);
  assert.equal(view.plannedDelivery, "2026-11-20");
  assert.deepEqual(view.schedule.map((part) => [part.percent, part.amount]), [[50, 2250], [50, 2250]]);
  assert.deepEqual(view.documents.map((entry) => entry.label), ["Devis n° 170", "Bon de commande n° 171"]);
  assert.equal(view.company.name.length > 0, true);

  const shown = JSON.stringify(view);
  for (const internal of ["Youssef", "Samir", "Karim", "rupture", "bloquee", "journal", "responsible", "note", "Autre Client", "Bureau", "Bennani", "0612345678", "panneaux-171", "MDF 18", "G21", "cnc"]) {
    assert.ok(!shown.includes(internal), `the client never sees « ${internal} »`);
  }
});

test("the client's page and its data open without signing in; an unknown and a switched-off link answer alike", async (t) => {
  const documents = await documentsWith(t, quote, otherQuote, order);
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore: createMemoryWorkshopStore({ clock }),
    publicBaseUrl: ""
  });
  t.after(() => app.close());
  const anonymous = (options) => app.inject(options);

  assert.equal((await anonymous({ method: "POST", url: "/api/workshop/171/portal", payload: { action: "ouvrir" } })).statusCode, 401, "only the cockpit makes a link");
  const opened = await inject({ method: "POST", url: "/api/workshop/171/portal", payload: { action: "ouvrir" }, headers: { host: "cockpit.example.ma" } });
  assert.equal(opened.statusCode, 200, opened.body);
  const { link } = JSON.parse(opened.body);
  assert.match(link.url, /^http:\/\/cockpit\.example\.ma\/suivi\/[A-Za-z0-9_-]{32}$/, "without PUBLIC_BASE_URL, the address the cockpit is opened from");
  const token = tokenOf(link);

  const page = await anonymous({ method: "GET", url: link.path });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.body, /\/app\/suivi\.js/);
  assert.equal((await anonymous({ method: "GET", url: "/app/suivi.js" })).statusCode, 200);

  const data = await anonymous({ method: "GET", url: `/api/public/suivi/${token}` });
  assert.equal(data.statusCode, 200, data.body);
  assert.equal(data.headers["cache-control"], "no-store");
  assert.equal(data.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(data.headers["referrer-policy"], "no-referrer");
  assert.equal(JSON.parse(data.body).order.number, "171");

  const pdf = await anonymous({ method: "GET", url: `/api/public/suivi/${token}/documents/quote/170` });
  assert.equal(pdf.statusCode, 200);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
  assert.equal((await anonymous({ method: "GET", url: `/api/public/suivi/${token}/documents/quote/180` })).statusCode, 404, "another client's quote is not part of this sale");
  assert.equal((await anonymous({ method: "GET", url: `/api/public/suivi/${token}/documents/invoice/170` })).statusCode, 404);

  const unknown = await anonymous({ method: "GET", url: `/api/public/suivi/${"x".repeat(32)}` });
  assert.equal((await inject({ method: "POST", url: "/api/workshop/171/portal", payload: { action: "fermer" } })).statusCode, 200);
  const switchedOff = await anonymous({ method: "GET", url: `/api/public/suivi/${token}` });
  assert.equal(unknown.statusCode, 404);
  assert.equal(switchedOff.statusCode, 404);
  assert.equal(switchedOff.body, unknown.body, "nothing tells a switched-off link from one that never existed");
  assert.equal((await anonymous({ method: "GET", url: `/api/public/suivi/${token}/documents/quote/170` })).statusCode, 404);
  assert.equal((await inject({ method: "POST", url: "/api/workshop/171/portal", payload: { action: "rien" } })).statusCode, 400);
  assert.equal((await inject({ method: "POST", url: "/api/workshop/999/portal", payload: { action: "ouvrir" } })).statusCode, 404);
});

test("a photo published from the cockpit shows on the link until it is removed", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore: createMemoryWorkshopStore({ clock }),
    publicBaseUrl: "https://cockpit.example.ma"
  });
  t.after(() => app.close());

  const { link } = JSON.parse((await inject({ method: "POST", url: "/api/workshop/171/portal", payload: { action: "ouvrir" } })).body);
  assert.equal(link.url, `https://cockpit.example.ma${link.path}`);
  const token = tokenOf(link);

  assert.equal((await app.inject({ method: "POST", url: "/api/workshop/171/photos", payload: { photo: PIXEL } })).statusCode, 401);
  assert.equal((await inject({ method: "POST", url: "/api/workshop/171/photos", payload: { photo: "pas une photo" } })).statusCode, 400);
  const published = await inject({ method: "POST", url: "/api/workshop/171/photos", payload: { photo: PIXEL, caption: "Assemblage terminé" } });
  assert.equal(published.statusCode, 201, published.body);
  const { id } = JSON.parse(published.body);

  const view = JSON.parse((await app.inject({ method: "GET", url: `/api/public/suivi/${token}` })).body);
  assert.deepEqual(view.photos.map((photo) => [photo.id, photo.caption]), [[id, "Assemblage terminé"]]);
  const image = await app.inject({ method: "GET", url: `/api/public/suivi/${token}/photos/${id}` });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal(image.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ method: "GET", url: `/api/public/suivi/${"y".repeat(32)}/photos/${id}` })).statusCode, 404);

  const { orders } = JSON.parse((await inject({ method: "GET", url: "/api/workshop" })).body);
  assert.deepEqual(orders[0].photos.map((photo) => photo.caption), ["Assemblage terminé"]);

  assert.equal((await inject({ method: "DELETE", url: `/api/workshop/171/photos/${id}` })).statusCode, 204);
  assert.equal((await inject({ method: "DELETE", url: `/api/workshop/171/photos/${id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/public/suivi/${token}/photos/${id}` })).statusCode, 404);
});

test("the link and the photos survive a restart", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const path = join(await tempDir(t), "atelier.json");
  const before = createWorkshop({ store: createFileWorkshopStore({ path, clock }), documentService: documents, clock });
  const token = tokenOf(await before.openPortal("171"));
  const id = await before.publishPhoto("171", PIXEL, { caption: "Découpe" });

  const after = createWorkshop({ store: createFileWorkshopStore({ path, clock }), documentService: documents, clock });
  assert.equal((await after.clientView(token)).photos[0].caption, "Découpe");
  assert.equal((await after.clientPhoto(token, id)).format, "png");
  assert.equal(await after.removePhoto("171", id), true);
  assert.equal(await after.clientPhoto(token, id), null);
});

// The agents, with the model's answers written in advance.
function agentWith(documents, workshopStore, scripts) {
  const calls = [];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      const who = Object.keys(scripts).find((key) => payload.instructions.includes(key));
      return scripts[who].shift();
    } } },
    documentService: documents,
    workshopStore,
    publicBaseUrl: "https://cockpit.example.ma",
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock
  });
  return { agent, calls };
}
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });
const outputOf = (payload) => JSON.parse(payload.input.at(-1).output);

test("asked to send the link, the Director makes it and the Commercial writes it into the client's message", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const { agent, calls } = agentWith(documents, workshopStore, {
    "Tu es le Director IA": [
      call("lien_suivi_client", { numero: "171", action: "creer" }, "l1"),
      call("deleguer_a_un_agent", { agent: "commercial", mission: "Message WhatsApp à Client Exemple avec son lien de suivi du BC 171." }, "d1"),
      say("Le message avec le lien de suivi est prêt.")
    ],
    "Tu es l'agent Commercial": [
      call("lien_suivi_client", { numero: "171", action: "creer" }, "c1"),
      say("Message préparé.")
    ],
    "Tu es l'agent Production": []
  });

  await agent.chat({ message: "Envoie le lien de suivi au client du BC 171" });

  const director = calls.filter((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  const made = outputOf(director[1]);
  assert.equal(made.ok, true);
  assert.match(made.lien, /^https:\/\/cockpit\.example\.ma\/suivi\/[A-Za-z0-9_-]{32}$/);
  assert.ok(!("attention" in made), "the public address is configured");

  const commercial = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  assert.ok(commercial[0].tools.some((tool) => tool.name === "lien_suivi_client"));
  assert.equal(outputOf(commercial[1]).lien, made.lien, "the same link, not a second one");

  const book = await createWorkshop({ store: workshopStore, documentService: documents, clock }).order("171");
  assert.equal(book.journal[0].by, "director");
});

test("a photo of the conversation is published on the link only through the Director, and only an existing one", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const { agent, calls } = agentWith(documents, workshopStore, {
    "Tu es le Director IA": [
      call("publier_photo_suivi", { numero: "171", photo: 2, legende: "Assemblage" }, "p1"),
      call("publier_photo_suivi", { numero: "171", photo: 1, legende: "Assemblage terminé" }, "p2"),
      call("lien_suivi_client", { numero: "171", action: "desactiver" }, "l1"),
      say("Photo publiée, lien coupé.")
    ]
  });

  await agent.chat({ message: "Mets cette photo sur le suivi du BC 171", photos: [PIXEL] });

  const director = calls.filter((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.match(outputOf(director[1]).erreur, /pas de photo n° 2/);
  const published = outputOf(director[2]);
  assert.equal(published.ok, true);
  assert.match(published.visible, /dès que le lien/, "no link yet: it says so");
  assert.equal(outputOf(director[3]).ok, true);

  const book = await createWorkshop({ store: workshopStore, documentService: documents, clock }).order("171");
  assert.deepEqual(book.photos.map((photo) => photo.caption), ["Assemblage terminé"]);
  assert.equal(book.portal, null);
});

test("only the Commercial, among the agents, is given the client link", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const { agent, calls } = agentWith(documents, createMemoryWorkshopStore({ clock }), {
    "Tu es le Director IA": [
      call("deleguer_a_un_agent", { agent: "production", mission: "Où en est le BC 171 ?" }, "d1"),
      say("Rien de nouveau.")
    ],
    "Tu es l'agent Production": [
      call("lien_suivi_client", { numero: "171", action: "creer" }, "x1"),
      say("Je ne peux pas.")
    ]
  });

  await agent.chat({ message: "Où en est le 171 ?" });

  const director = calls.find((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.ok(director.tools.some((tool) => tool.name === "publier_photo_suivi"));
  const production = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"));
  assert.ok(!production[0].tools.some((tool) => tool.name === "lien_suivi_client"));
  assert.equal(outputOf(production[1]).ok, false);
});
