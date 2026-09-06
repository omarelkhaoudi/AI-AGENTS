import assert from "node:assert/strict";
import test from "node:test";

// The cockpit ran its bootstrap while the module was still being evaluated:
// "await refreshApprovals()" sat above "let apiToken = null", so the first thing
// the page did was read a binding still in its temporal dead zone. Every load
// painted "Erreur approvals / Cannot access 'apiToken' before initialization",
// and any later action silently overwrote it, which is why the panel looked
// healthy as soon as anyone submitted a request.
//
// Reading the source could not catch that: function declarations hoist, so the
// call looked correct. The module is therefore loaded and executed here, against
// a document stub, exactly as a browser would.

function element() {
  const node = {
    dataset: {},
    innerHTML: "",
    textContent: "",
    value: "",
    style: {},
    // Listeners are kept so a test can do what a user does: submit the form and
    // read what the page then rendered, instead of asserting on the source.
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler);
    },
    focus() {},
    querySelector: () => element(),
    querySelectorAll: () => []
  };
  return node;
}

// One node per selector, kept so a test can read what the module rendered into it.
function documentStub() {
  const nodes = new Map();
  return {
    nodes,
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

// Loads the real module with the globals a browser provides. The query string
// defeats the module cache so each test gets a fresh evaluation.
async function loadCockpit({ fetchImpl }) {
  const doc = documentStub();
  const calls = [];
  const saved = {
    document: globalThis.document,
    sessionStorage: globalThis.sessionStorage,
    fetch: globalThis.fetch
  };

  globalThis.document = doc;
  globalThis.sessionStorage = storageStub();
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return fetchImpl(url, options);
  };

  try {
    await import(`../src/frontend/app.js?bootstrap=${Math.random()}`);
    return { doc, calls, error: null };
  } catch (error) {
    return { doc, calls, error };
  } finally {
    globalThis.document = saved.document;
    globalThis.sessionStorage = saved.sessionStorage;
    globalThis.fetch = saved.fetch;
  }
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

function serve(url) {
  if (String(url).includes("/api/auth/demo-session")) {
    return jsonResponse({ token: "aia_test-token", user: { id: "demo-leader", role: "leader" } });
  }
  if (String(url).includes("/api/approvals")) {
    return jsonResponse({ approvals: [] });
  }
  throw new Error(`unexpected request: ${url}`);
}

test("loading the cockpit does not throw", async () => {
  const { error } = await loadCockpit({ fetchImpl: serve });

  assert.equal(error, null, `the module failed to evaluate: ${error?.message}`);
});

test("the approvals panel loads without an error card", async () => {
  const { doc, error } = await loadCockpit({ fetchImpl: serve });
  const approvals = doc.nodes.get("#approval-list");

  assert.equal(error, null);
  assert.ok(approvals, "the approvals panel must have been rendered into");
  assert.doesNotMatch(approvals.innerHTML, /Erreur approvals/);
  assert.doesNotMatch(approvals.innerHTML, /before initialization/);
  // With nothing pending, the panel says so rather than staying blank.
  assert.match(approvals.innerHTML, /Aucune approval en attente/);
});

// The bootstrap must authenticate the way any client does: fetch a real token,
// then present it. No hardcoded credential, no unauthenticated approvals call.
test("the approvals request carries a token obtained from the demo session", async () => {
  const { calls, error } = await loadCockpit({ fetchImpl: serve });

  assert.equal(error, null);
  const session = calls.find((call) => String(call.url).includes("/api/auth/demo-session"));
  const approvals = calls.find((call) => String(call.url).includes("/api/approvals"));

  assert.ok(session, "the cockpit must ask the server for a token");
  assert.ok(approvals, "the cockpit must load the approvals");
  assert.equal(approvals.options.headers.authorization, "Bearer aia_test-token");
  assert.equal(
    calls.indexOf(session) < calls.indexOf(approvals),
    true,
    "the token must be obtained before the approvals are requested"
  );
});

// A server that refuses to hand out a token must produce a readable message,
// not a crash. This is the path the operator sees outside demo mode.
test("a refused session is reported without breaking the page", async () => {
  const { doc, error } = await loadCockpit({
    fetchImpl: (url) => {
      if (String(url).includes("/api/auth/demo-session")) {
        return { ok: false, json: async () => ({}) };
      }
      return serve(url);
    }
  });
  const approvals = doc.nodes.get("#approval-list");

  assert.equal(error, null, "a refused token must not break module evaluation");
  assert.match(approvals.innerHTML, /Authentification requise/);
  assert.doesNotMatch(approvals.innerHTML, /before initialization/);
});

// CDC section 29 asks the situation question to answer with revenue, collections
// and receivables as three separate figures, and purchase needs as a fourth. The
// Director computed all four and the cockpit dropped them: nothing on screen.
//
// Driven the way a user drives it: the form is submitted and the panel is read.
// The response is built so collections and receivables DIVERGE, because on the
// demo set every receivable is overdue and the two figures read the same there,
// which would let this pass just as well if both rows showed one value.
const DIRECTOR_RESPONSE = Object.freeze({
  status: "completed",
  message: "Fais-moi le point sur mon entreprise aujourd'hui.",
  results: [],
  decisionsRequired: [],
  summary: {
    headline: "Point complete.",
    minimumSections: {},
    domainSources: [],
    aggregates: {
      invoices: {
        agent: "finance",
        tool: "get_revenue_summary",
        totalsByCurrency: { MAD: 20500, EUR: 300 },
        counts: { invoices: 3 }
      },
      payments: {
        agent: "finance",
        tool: "get_receivables_summary",
        totalsByCurrency: { MAD: 20500, EUR: 300 },
        overdueTotalsByCurrency: { MAD: 12000 },
        counts: { receivables: 3, overdue: 1 }
      },
      purchase_needs: {
        agent: "purchasing",
        tool: "get_material_requirements",
        counts: { orders: 2, lines: 2, shortages: 2 }
      },
      orders: {
        agent: "commercial",
        tool: "get_order_book_summary",
        countsByStatus: { in_production: 1, scheduled: 1 },
        counts: { orders: 2, fromQuote: 1 }
      },
      production: {
        agent: "production",
        tool: "get_production_schedule",
        counts: { records: 3, withoutOrder: 1 },
        productionWithoutOrder: ["order-sample-003"]
      }
    }
  }
});

async function submitAndReadSummary() {
  const { doc, error } = await loadCockpit({
    fetchImpl: (url) => {
      if (String(url).includes("/api/director/requests")) {
        return jsonResponse(DIRECTOR_RESPONSE);
      }
      return serve(url);
    }
  });
  assert.equal(error, null);

  doc.nodes.get("#director-message").value = "Fais-moi le point sur mon entreprise aujourd'hui.";
  const submit = doc.nodes.get("#director-form").listeners.submit;
  assert.equal(submit?.length, 1, "the cockpit must listen for the submission");

  // loadCockpit restores the real fetch once the module is evaluated, and the
  // submission happens after that, so the stub is reinstalled for its duration.
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes("/api/director/requests")
    ? jsonResponse(DIRECTOR_RESPONSE)
    : serve(url));
  try {
    await submit[0]({ preventDefault() {} });
  } finally {
    globalThis.fetch = saved;
  }

  return doc.nodes.get("#summary-content").innerHTML;
}

test("the summary panel reports the four figures CDC section 29 asks for", async () => {
  const html = await submitAndReadSummary();

  // The apostrophe is escaped on the way out, as every label is.
  assert.match(html, /CHIFFRE D&#039;AFFAIRES/);
  assert.match(html, /ENCAISSEMENTS/);
  assert.match(html, /CREANCES EN RETARD/);
  assert.match(html, /BESOINS MATIERES/);
});

test("the summary panel never merges currencies and never sums the figures", async () => {
  const html = await submitAndReadSummary();

  assert.match(html, /MAD 20500/);
  assert.match(html, /EUR 300/);
  // 20500 + 300, and 20500 + 300 + 12000: neither total may ever be rendered.
  assert.doesNotMatch(html, /20800/);
  assert.doesNotMatch(html, /32800/);

  // Receivables are the overdue share of collections, not a copy of them.
  assert.match(html, /MAD 12000/);
  const overdueRow = html.slice(html.indexOf("CREANCES EN RETARD"));
  assert.doesNotMatch(
    overdueRow.slice(0, overdueRow.indexOf("</li>")),
    /EUR/,
    "nothing is late in euros, and EUR 0 would say otherwise"
  );
});

// CDC section 29 lists orders as a rubric of its own, and the workshop holds one
// file more than the book does. Both are read on the same row: the count says
// what is registered, the anomaly says what is not, and neither hides the other.
test("the summary panel reports the order book and names the file with no order", async () => {
  const html = await submitAndReadSummary();

  assert.match(html, /COMMANDES/);
  assert.match(html, /2 au carnet/);
  assert.match(html, /in_production 1/);
  assert.match(html, /scheduled 1/);
  assert.match(html, /order-sample-003/);
  assert.match(html, /sans commande enregistree/);

  // The workshop count never becomes the order count.
  const row = html.slice(html.indexOf("COMMANDES"));
  assert.doesNotMatch(row.slice(0, row.indexOf("</li>")), /3 au carnet/);
});

// The datasheet panel, driven the way a person drives it: the form is filled and
// submitted, and the panel is read back. The responses are the ones the route
// actually returns, so what is checked here is the rendering, not the rule.
const DATASHEET_RESPONSES = Object.freeze({
  "PRD-ATLAS-PANEL": {
    status: "approval_required",
    request: { id: "req-1" },
    planStep: { id: "step-1" },
    datasheet: {
      reference: "PRD-ATLAS-PANEL",
      datasheet: {
        id: "product-atlas-panel",
        name: "Demo Atlas Panel",
        reference: "PRD-ATLAS-PANEL",
        category: "finished_good",
        unit: "unit",
        status: "active",
        imageRef: "demo/products/prd-atlas-panel.jpg"
      },
      prices: [{ amount: 4200, currency: "MAD", unit: "unit", validFrom: "2026-07-29" }],
      issues: []
    },
    approval: { id: "a-1", status: "pending", requestedAction: "prepare_quote_from_datasheet" }
  },
  "MAT-PACK-B": {
    status: "refused",
    request: { id: "req-2" },
    planStep: { id: "step-2" },
    datasheet: {
      reference: "MAT-PACK-B",
      datasheet: { name: "Demo Packaging B", reference: "MAT-PACK-B", category: "packaging", unit: "units", status: "active" },
      prices: [
        { amount: 18, currency: "MAD", unit: "units", validFrom: "2026-06-29" },
        { amount: 21, currency: "MAD", unit: "units", validFrom: "2026-08-18" }
      ],
      issues: ["several_prices_in_force"]
    }
  },
  "MAT-ALU-A": {
    status: "refused",
    request: { id: "req-3" },
    planStep: { id: "step-3" },
    datasheet: {
      reference: "MAT-ALU-A",
      datasheet: { name: "Demo Aluminum Sheet A", reference: "MAT-ALU-A", category: "raw_material", unit: "sheets", status: "active" },
      prices: [],
      issues: ["no_price_for_product"]
    }
  }
});

async function submitDatasheet(reference) {
  const { doc, error } = await loadCockpit({ fetchImpl: serve });
  assert.equal(error, null);

  doc.nodes.get("#datasheet-reference").value = reference;
  doc.nodes.get("#datasheet-customer").value = "customer-atlas";
  doc.nodes.get("#datasheet-quantity").value = "12";

  const submit = doc.nodes.get("#datasheet-form").listeners.submit;
  assert.equal(submit?.length, 1, "the panel must listen for the submission");

  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes("/api/quotes/datasheet")) {
      return jsonResponse(DATASHEET_RESPONSES[reference]);
    }
    return serve(url, options);
  };
  try {
    await submit[0]({ preventDefault() {} });
  } finally {
    globalThis.fetch = saved;
  }

  return { html: doc.nodes.get("#datasheet-result").innerHTML, doc, calls };
}

test("the datasheet panel reports the product, the price and the three provenances", async () => {
  const { html, doc, calls } = await submitDatasheet("PRD-ATLAS-PANEL");

  assert.match(html, /approval_required/);
  assert.match(html, /PRD-ATLAS-PANEL/);
  assert.match(html, /Demo Atlas Panel/);
  assert.match(html, /finished_good/);
  assert.match(html, /unit/);
  assert.match(html, /active/);
  assert.match(html, /demo\/products\/prd-atlas-panel\.jpg/);
  assert.match(html, /MAD 4200/);
  assert.match(html, /2026-07-29/);

  for (const block of ["fromDatasheet", "fromPriceList", "fromRequest"]) {
    assert.match(html, new RegExp(block), block);
  }
  assert.match(html, /pending/);
  assert.match(html, /prepare_quote_from_datasheet/);

  // The approval card comes from the panel that already existed, refreshed
  // through the route the cockpit has always used. No second mechanism.
  assert.ok(calls.some((url) => url.includes("/api/quotes/datasheet")));
  assert.ok(calls.some((url) => url.includes("/api/approvals")));
  assert.doesNotMatch(doc.nodes.get("#datasheet-state").textContent, /Erreur/);
});

test("two prices in force are both shown and neither is selected", async () => {
  const { html } = await submitDatasheet("MAT-PACK-B");

  assert.match(html, /refused/);
  assert.match(html, /several_prices_in_force/);
  assert.match(html, /MAD 18/);
  assert.match(html, /MAD 21/);
  // Neither is marked as the one: no selection, no default, no approval opened.
  assert.doesNotMatch(html, /selected|choisi|retenu/i);
  assert.match(html, /aucune approbation ouverte/);
});

// The panel must never state a figure the data does not carry. A total would be
// the easiest one to add and the hardest to notice.
test("the panel never computes a total and never invents an amount", async () => {
  const nominal = await submitDatasheet("PRD-ATLAS-PANEL");
  assert.doesNotMatch(nominal.html, /50400/, "quantity times price is never rendered");

  const withoutPrice = await submitDatasheet("MAT-ALU-A");
  assert.match(withoutPrice.html, /no_price_for_product/);
  assert.doesNotMatch(withoutPrice.html, /fromPriceList/, "no price means no price row");
  assert.doesNotMatch(withoutPrice.html, /MAD/, "and no currency either");
  assert.match(withoutPrice.html, /aucun montant propose/);
});
