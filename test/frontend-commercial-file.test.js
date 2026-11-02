import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRepository, buildApi, calculateDocumentTotals } from "../src/index.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

/**
 * The commercial file panel of the cockpit, driven the way a person drives it.
 *
 * The module is loaded and executed against a document stub, as in
 * frontend-bootstrap.test.js, but its fetch is wired to the real API instead of
 * to hand-written responses. So no amount is stated here that the backend did
 * not compute, and the panel is read back to see what it did with it.
 */

const CASE_ITEMS = Object.freeze([
  { designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 },
  { designation: "Matelas enfant", unit: "U", quantity: 1, unitPriceHt: 1600 },
  { designation: "Bureau evolutif", unit: "U", quantity: 1, unitPriceHt: 6800 },
  { designation: "Armoire trois portes", unit: "U", quantity: 1, unitPriceHt: 8900 },
  { designation: "Papier peint personnalise", unit: "U", quantity: 1, unitPriceHt: 3400 },
  { designation: "Eclairage LED indirect", unit: "U", quantity: 1, unitPriceHt: 4500 },
  { designation: "Livraison et installation", unit: "U", quantity: 1, unitPriceHt: 2500 }
]);

const DISCOUNT = Object.freeze({ percent: 5, appliesToIndexes: Object.freeze([0, 2, 3]) });

// --- the browser the module thinks it is running in ----------------------------

// The module attaches its click handlers to the buttons it has just written into
// innerHTML, so a test that clicks "Générer" has to find them. The attribute
// selector is resolved against the HTML the module actually produced.
function buttonsIn(html, attribute) {
  const buttons = [];
  for (const match of String(html).matchAll(/<button\b[^>]*>/g)) {
    if (!match[0].includes(`${attribute}=`)) {
      continue;
    }
    const node = element();
    for (const attr of match[0].matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      node.dataset[attr[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = attr[2];
    }
    buttons.push(node);
  }
  return buttons;
}

function element() {
  return {
    dataset: {},
    className: "",
    innerHTML: "",
    textContent: "",
    value: "",
    style: {},
    href: "",
    download: "",
    listeners: {},
    // Kept so a test can click the button the module just wired, rather than
    // calling the handler it would have wired.
    wired: [],
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    focus() {},
    append() {},
    remove() {},
    click() {},
    querySelector: () => element(),
    querySelectorAll(selector) {
      const found = buttonsIn(this.innerHTML, selector.replace(/^\[|\]$/g, ""));
      this.wired.push(...found);
      return found;
    }
  };
}

function documentStub() {
  const nodes = new Map();
  return {
    nodes,
    body: element(),
    createElement: () => element(),
    querySelector(selector) {
      if (!nodes.has(selector)) {
        nodes.set(selector, element());
      }
      return nodes.get(selector);
    },
    querySelectorAll() {
      return [];
    }
  };
}

function storageStub() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

// The cockpit's fetch, answered by the real server. The demo session hands out a
// real token, so the module authenticates exactly as it does in a browser.
function fetchThroughApi(app, secret, calls) {
  return async (url, options = {}) => {
    const target = String(url);
    const call = { url: target, method: options.method ?? "GET", body: null };
    calls.push(call);

    if (target.includes("/api/auth/demo-session")) {
      return { ok: true, status: 200, json: async () => ({ token: secret, user: { id: "test-leader" } }) };
    }

    const response = await app.inject({
      method: options.method ?? "GET",
      url: target,
      headers: options.headers ?? {},
      payload: options.body
    });
    call.body = response.body;
    call.statusCode = response.statusCode;
    return {
      ok: response.statusCode < 400,
      status: response.statusCode,
      json: async () => JSON.parse(response.body),
      blob: async () => response.rawPayload
    };
  };
}

async function loadCockpit(t) {
  const repository = new InMemoryRepository();
  const documentOutputDir = await mkdtemp(join(tmpdir(), "hkids-cockpit-file-"));
  const app = buildApi({ repository, documentOutputDir });
  const principal = await createAuthenticatedUser(repository, { id: "test-leader", role: "leader" });

  const doc = documentStub();
  const calls = [];
  const saved = {
    document: globalThis.document,
    sessionStorage: globalThis.sessionStorage,
    fetch: globalThis.fetch,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL
  };

  globalThis.document = doc;
  globalThis.sessionStorage = storageStub();
  globalThis.fetch = fetchThroughApi(app, principal.secret, calls);
  URL.createObjectURL = () => "blob:commercial-file";
  URL.revokeObjectURL = () => {};

  t.after(async () => {
    globalThis.document = saved.document;
    globalThis.sessionStorage = saved.sessionStorage;
    globalThis.fetch = saved.fetch;
    URL.createObjectURL = saved.createObjectURL;
    URL.revokeObjectURL = saved.revokeObjectURL;
    await app.close();
    await rm(documentOutputDir, { recursive: true, force: true });
  });

  // The query string defeats the module cache, so each test evaluates it afresh.
  await import(`../src/frontend/app.js?commercial=${Math.random()}`);
  return { doc, calls, repository, documentOutputDir };
}

// Fills the panel and submits it, the way a person does.
async function consultFile(t, { items = CASE_ITEMS, discount = true } = {}) {
  const loaded = await loadCockpit(t);
  const { doc } = loaded;

  doc.nodes.get("#file-client").value = "MADAME EXEMPLE";
  doc.nodes.get("#file-address").value = "Ville Exemple";
  doc.nodes.get("#file-date").value = "06/09/2026";
  doc.nodes.get("#file-payment-method").value = "virement bancaire";
  doc.nodes.get("#file-payment-rule").value = "hkids-60-20-20-2026";
  doc.nodes.get("#file-discount-percent").value = discount ? String(DISCOUNT.percent) : "";
  doc.nodes.get("#file-discount-lines").value = discount ? DISCOUNT.appliesToIndexes.join(",") : "";
  doc.nodes.get("#file-items").value = JSON.stringify(items);

  const submit = doc.nodes.get("#file-form").listeners.submit;
  assert.equal(submit?.length, 1, "the panel must listen for the submission");
  await submit[0]({ preventDefault() {} });

  return loaded;
}

function amountsIn(html) {
  return (String(html).match(/[\d ]+,\d{2} DH/g) ?? [])
    .map((amount) => Number(amount.replace(/[^\d,]/g, "").replace(",", ".")));
}

function answerOf(calls, route) {
  const call = calls.find((entry) => entry.url.includes(route));
  assert.ok(call, `the panel must call ${route}`);
  return JSON.parse(call.body);
}

// --- the panel the server actually sends ------------------------------------------

// The tests below drive the module against a document stub, so they would still
// pass if the panel were removed from the page. This one reads what the server
// serves: it catches the section being deleted.
test("the served page carries the commercial file panel and its fields", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const page = await inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Dossier commercial H-KIDS/);
  for (const id of [
    "file-form", "file-client", "file-address", "file-date", "file-payment-method",
    "file-payment-rule", "file-discount-percent", "file-discount-lines", "file-items",
    "file-state", "file-summary", "file-deliverables", "file-missing", "file-files"
  ]) {
    assert.match(page.body, new RegExp(`id="${id}"`), id);
  }

  // The four approved plans, and no fifth offered by the page.
  for (const rule of [
    "hkids-60-20-20-2026", "hkids-50-30-20-exception",
    "hkids-40-40-20-exception", "hkids-100-exception"
  ]) {
    assert.match(page.body, new RegExp(rule), rule);
  }

  const script = await inject({ method: "GET", url: "/app/app.js" });
  assert.equal(script.statusCode, 200);
  assert.match(script.body, /\/api\/commercial-files\/preview/);
  assert.match(script.body, /\/api\/commercial-files\/render/);
});

// --- consulting the file ---------------------------------------------------------

test("consulting the file shows the amounts the backend computed", async (t) => {
  const { doc } = await consultFile(t);
  const summary = doc.nodes.get("#file-summary").innerHTML;
  const expected = calculateDocumentTotals(CASE_ITEMS, 0.2, {
    discount: { ...DISCOUNT, label: "Remise exceptionnelle" }
  }).totals;

  assert.equal(expected.totalBrutHt, 51700);
  assert.equal(expected.totalTtc, 59658);

  assert.match(summary, /Total brut HT/);
  assert.match(summary, /51 700,00 DH/);
  assert.match(summary, /Remise/);
  assert.match(summary, /1 985,00 DH/);
  assert.match(summary, /49 715,00 DH/);
  assert.match(summary, /9 943,00 DH/);
  assert.match(summary, /59 658,00 DH/);
  assert.match(doc.nodes.get("#file-state").textContent, /Dossier consulté/);
});

test("the payment schedule shown is the one the backend built", async (t) => {
  const { doc, calls } = await consultFile(t);
  const summary = doc.nodes.get("#file-summary").innerHTML;
  const schedule = answerOf(calls, "/api/commercial-files/preview").file.schedule;

  assert.match(summary, /Échéancier/);
  for (const installment of schedule.installments) {
    assert.match(summary, new RegExp(`${installment.percent} %`), String(installment.percent));
    assert.match(summary, new RegExp(installment.condition), installment.condition);
  }
});

test("the panel computes nothing of its own", async (t) => {
  const { doc, calls } = await consultFile(t);
  const payload = answerOf(calls, "/api/commercial-files/preview");

  // Every figure on screen has to be one the API sent. A locally derived amount
  // — a sum, a percentage, a per-line total — would not be in this set.
  const sent = new Set([
    ...Object.values(payload.file.totals).map(Number),
    ...payload.file.schedule.installments.map((entry) => Number(entry.amountTtc))
  ]);

  const rendered = amountsIn(doc.nodes.get("#file-summary").innerHTML);
  assert.ok(rendered.length >= 8, "the summary must actually carry figures");
  for (const amount of rendered) {
    assert.ok(sent.has(amount), `${amount} was rendered but the API never sent it`);
  }
});

test("no discount asked for means no discount rows and no zero invented", async (t) => {
  const { doc } = await consultFile(t, { discount: false });
  const summary = doc.nodes.get("#file-summary").innerHTML;

  assert.doesNotMatch(summary, /Total brut HT/);
  assert.doesNotMatch(summary, /Remise/);
  assert.match(summary, /51 700,00 DH/);
});

// --- who each deliverable is for ---------------------------------------------------

test("client documents and internal deliverables are shown apart", async (t) => {
  const { doc } = await consultFile(t);
  const html = doc.nodes.get("#file-deliverables").innerHTML;

  assert.match(html, /Documents client/);
  assert.match(html, /Livrables internes/);

  const client = html.slice(html.indexOf("Documents client"), html.indexOf("Livrables internes"));
  const internal = html.slice(html.indexOf("Livrables internes"));

  assert.match(client, /Devis/);
  assert.match(client, /Facture/);
  assert.match(client, /Bon de livraison/);
  assert.match(client, /CLIENT/);
  assert.doesNotMatch(client, /INTERNE/);
  assert.match(internal, /INTERNE/);

  // The classifications Hiba has not settled are shown as unsettled.
  assert.match(html, /destinataire à confirmer/);
});

test("a deliverable with no renderer says why instead of offering a button", async (t) => {
  const { doc } = await consultFile(t);
  const html = doc.nodes.get("#file-deliverables").innerHTML;

  // The apostrophe is escaped on the way out, as every label is.
  assert.match(html, /n&#039;a pas encore de rendu/);
  // Every commercial document is drawn in code, so all three can be produced.
  assert.deepEqual(
    buttonsIn(html, "data-render").map((button) => button.dataset.render).sort(),
    ["delivery_note", "invoice", "quote"]
  );
});

// The panel has no opinion of its own: it offers a button where the backend says
// a deliverable is producible, and nowhere else. With the templates configured
// the invoice and the delivery note become producible and gain one; the annexes
// have no renderer and keep their reason instead.
test("the buttons follow the backend when the templates are configured", async (t) => {
  const { doc } = await consultFile(t);
  const html = doc.nodes.get("#file-deliverables").innerHTML;

  assert.deepEqual(
    buttonsIn(html, "data-render").map((button) => button.dataset.render).sort(),
    ["delivery_note", "invoice", "quote"]
  );
  // The three commercial documents become producible; the annexes do not.
  assert.match(html, /n&#039;a pas encore de rendu/);
});

// --- missing information ------------------------------------------------------------

test("missing project information is listed, and nothing fills it in", async (t) => {
  const { doc } = await consultFile(t);
  const html = doc.nodes.get("#file-missing").innerHTML;

  assert.match(html, /Informations manquantes/);
  assert.match(html, /Date de livraison souhaitée/);
  assert.match(html, /Adresse complète/);
  assert.match(html, /information manquante, à demander au client/);
  assert.match(html, /bloquante/);
  assert.doesNotMatch(html, /undefined/);
});

// --- generating and downloading --------------------------------------------------------

test("generating the quote offers the two files, and downloading goes through the API", async (t) => {
  const { doc, calls } = await consultFile(t);

  const generate = doc.nodes.get("#file-deliverables").wired.find((node) => node.dataset.render === "quote");
  assert.ok(generate, "the quote must offer a button");
  await generate.listeners.click[0]();

  const files = doc.nodes.get("#file-files").innerHTML;
  assert.match(files, /Devis/);
  assert.match(files, /PDF/);
  assert.match(files, /DOCX/);
  assert.match(files, /devis_HKIDS_sans-numero_06_09_2026\.pdf/);
  assert.match(files, /devis_HKIDS_sans-numero_06_09_2026\.docx/);
  assert.match(doc.nodes.get("#file-state").textContent, /Aucun envoi client/);

  const download = doc.nodes.get("#file-files").wired.find((node) => node.dataset.downloadName?.endsWith(".pdf"));
  assert.ok(download, "the produced file must be downloadable");
  assert.match(download.dataset.downloadUrl, /^\/api\/documents\/[^/]+\/download$/);
  await download.listeners.click[0]();

  const served = calls.find((call) => /\/api\/documents\/[^/]+\/download$/.test(call.url));
  assert.ok(served, "the download must go through the route that already serves documents");
  assert.equal(served.statusCode, 200);
  assert.doesNotMatch(doc.nodes.get("#file-state").textContent, /echoue/);

  // Nothing left this API: no customer, no third party.
  assert.ok(calls.every((call) => call.url.startsWith("/api/")), "the panel talks to this API only");
});

// --- errors ------------------------------------------------------------------------------

test("a refused file is reported, and the panels are cleared", async (t) => {
  const { doc } = await consultFile(t, { items: [] });

  assert.match(doc.nodes.get("#file-summary").innerHTML, /Erreur dossier/);
  assert.equal(doc.nodes.get("#file-deliverables").innerHTML, "");
  assert.equal(doc.nodes.get("#file-missing").innerHTML, "");
  assert.equal(doc.nodes.get("#file-files").innerHTML, "");
  assert.doesNotMatch(doc.nodes.get("#file-state").textContent, /Dossier consulté/);
});
