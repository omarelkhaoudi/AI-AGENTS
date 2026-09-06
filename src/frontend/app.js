const state = {
  current: null,
  history: [],
  approvals: []
};

const DIRECTOR_SECTIONS = Object.freeze([
  ["CE QUI VA BIEN", "CE QUI VA BIEN"],
  ["RETARDS / PROBLEMES", "RETARDS / PROBLÈMES"],
  ["A ENCAISSER", "À ENCAISSER"],
  ["A COMMANDER", "À COMMANDER"],
  ["RISQUES / BLOCAGES", "RISQUES / BLOCAGES"],
  ["DECISIONS NECESSAIRES", "DÉCISIONS NÉCESSAIRES"],
  ["CE QUI NECESSITE UNE ACTION COMMERCIALE", "ACTION COMMERCIALE"],
  ["CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION", "ACTION MARKETING / COMMUNICATION"],
  ["CE QUI NECESSITE UNE INTERVENTION SAV", "INTERVENTION SAV"],
  ["CE QUI PRESENTE UN RISQUE JURIDIQUE", "RISQUE JURIDIQUE"]
]);

// CDC section 29 asks the situation question to answer with, among other things,
// revenue, collections and receivables as three separate figures, and purchase
// needs as a fourth. The Director already computes them; the cockpit read the
// ten headings and the provenance and dropped the figures on the floor.
//
// Each row names the aggregate it reads, the totals it shows and the count that
// goes beside them. Collections and receivables share one aggregate and differ
// by which totals they read: the second is the overdue share of the first.
const DIRECTOR_FIGURES = Object.freeze([
  ["CHIFFRE D'AFFAIRES", "invoices", "totalsByCurrency", "invoices", "facture(s)"],
  ["ENCAISSEMENTS", "payments", "totalsByCurrency", "receivables", "creance(s)"],
  ["CREANCES EN RETARD", "payments", "overdueTotalsByCurrency", "overdue", "en retard"]
]);

const AGENT_ROSTER = Object.freeze([
  ["director", "🧠 Direction"],
  ["commercial", "💼 Commercial"],
  ["finance", "💰 Finance"],
  ["production", "🏭 Production"],
  ["purchasing", "📦 Achats"],
  ["hr", "👥 RH"],
  ["marketing", "📢 Marketing"],
  ["community_manager", "👥 Community Manager", "Marketing"],
  ["legal", "⚖️ Juridique"],
  ["after_sales", "🛠 SAV"]
]);

const VOICE_INTERFACE = Object.freeze({
  status: "prepared_offline",
  enabled: false,
  externalConnectionsEnabled: false
});

const form = document.querySelector("#director-form");
const messageInput = document.querySelector("#director-message");
const summarySubtitle = document.querySelector("#summary-subtitle");
const summaryContent = document.querySelector("#summary-content");
const planList = document.querySelector("#plan-list");
const agentResults = document.querySelector("#agent-results");
const agentRoster = document.querySelector("#agent-roster");
const approvalList = document.querySelector("#approval-list");
const historyList = document.querySelector("#history-list");
const apiStatus = document.querySelector("#api-status");
const uiState = document.querySelector("#ui-state");
const voicePlaceholder = document.querySelector("#voice-placeholder");

voicePlaceholder.dataset.voiceStatus = VOICE_INTERFACE.status;
voicePlaceholder.dataset.externalConnectionsEnabled = String(VOICE_INTERFACE.externalConnectionsEnabled);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitDirectorRequest(messageInput.value);
});

document.querySelectorAll("[data-scenario]").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.scenario;
    messageInput.focus();
  });
});

document.querySelector("#refresh-approvals").addEventListener("click", () => refreshApprovals());

// The cockpit authenticates like any other client. In demo mode the server
// hands out a real token; otherwise the token is supplied by the operator.
let apiToken = null;

async function resolveApiToken() {
  if (apiToken) {
    return apiToken;
  }

  const stored = sessionStorage.getItem("aiAgentsApiToken");
  if (stored) {
    apiToken = stored;
    return apiToken;
  }

  const response = await fetch("/api/auth/demo-session");
  if (!response.ok) {
    throw new Error("Authentification requise: aucun jeton disponible.");
  }
  const payload = await response.json();
  apiToken = payload.token;
  sessionStorage.setItem("aiAgentsApiToken", apiToken);
  return apiToken;
}

async function authHeaders() {
  return { authorization: `Bearer ${await resolveApiToken()}` };
}

async function submitDirectorRequest(message) {
  const cleanMessage = message.trim();
  if (!cleanMessage) {
    renderError("La demande ne peut pas etre vide.");
    return;
  }

  setLoading(true);
  try {
    const response = await postJson("/api/director/requests", { message: cleanMessage });
    state.current = response;
    state.history = [response, ...state.history.filter((entry) => entry.requestId !== response.requestId)].slice(0, 8);
    renderCurrent(response);
    await refreshApprovals();
  } catch (error) {
    renderError(error.message);
  } finally {
    setLoading(false);
  }
}

async function refreshApprovals() {
  try {
    const response = await fetch("/api/approvals", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de recuperer les approvals.");
    }
    const payload = await response.json();
    state.approvals = payload.approvals ?? [];
    renderApprovals();
  } catch (error) {
    approvalList.innerHTML = card("Erreur approvals", escapeHtml(error.message), "warning");
  }
}

async function decideApproval(id, decision) {
  const statusTarget = approvalList.querySelector(`[data-approval-id="${id}"] .approval-status`);
  try {
    const response = await postJson(`/api/approvals/${id}/${decision}`, {});
    statusTarget.textContent = decision === "approve"
      ? `Action executee: ${response.execution?.status ?? "completed"}`
      : "Action rejetee.";
    await refreshApprovals();
  } catch (error) {
    statusTarget.textContent = error.message;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "La requete a echoue.");
  }
  return payload;
}

function renderCurrent(response) {
  apiStatus.textContent = formatStatus(response.status);
  apiStatus.style.color = response.status === "requires_approval" ? "#9f3412" : "#667085";
  uiState.textContent = response.status === "partial"
    ? "Reponse partielle: certains agents n'ont pas pu repondre."
    : response.status === "requires_approval"
      ? "Approval en attente: aucune action sensible n'a ete executee."
      : "Reponse recue.";
  renderSummary(response);
  renderPlan(response);
  renderAgents(response);
  renderAgentRoster((response.results ?? []).map((result) => result.agent));
  renderHistory();
}

function renderSummary(response) {
  summarySubtitle.textContent = response.message;
  const minimumSections = response.summary?.minimumSections ?? {};
  const domainSources = response.summary?.domainSources ?? [];

  summaryContent.className = "";
  summaryContent.innerHTML = `
    <p>${escapeHtml(response.summary?.headline ?? "Synthese indisponible.")}</p>
    ${renderFigures(response.summary?.aggregates)}
    ${renderDirectorSections(minimumSections)}
    ${renderProvenance(domainSources)}
  `;
}

function renderPlan(response) {
  const results = response.results ?? [];
  planList.innerHTML = results.map((result, index) => `
    <li>
      <strong>${index === 0 ? "Director -> " : ""}${escapeHtml(formatAgent(result.agent))}</strong>
      <span>${escapeHtml(result.tool ?? "aucun tool")} - ${escapeHtml(result.status)}</span>
    </li>
  `).join("");
}

function renderAgents(response) {
  const results = response.results ?? [];
  if (results.length === 0) {
    agentResults.innerHTML = '<p class="empty">Aucun agent sollicite.</p>';
    return;
  }
  agentResults.innerHTML = results.map((result) => {
    const items = Array.isArray(result.result?.items) ? result.result.items : [];
    const itemList = items.slice(0, 4).map((item) => `
      <li>${escapeHtml(describeItem(item))}</li>
    `).join("");
    const statusClass = result.status === "completed" ? "ok" : "warning";
    return `
      <article class="agent-card">
        <header>
          <div>
            <h3>${escapeHtml(formatAgent(result.agent))}</h3>
            <p class="muted">${escapeHtml(result.tool ?? "Action preparee")}</p>
          </div>
          <span class="tag ${statusClass}">${escapeHtml(result.status)}</span>
        </header>
        ${renderResultProvenance(result)}
        ${items.length > 0 ? `<ul>${itemList}</ul>` : '<p class="muted">Aucun resultat execute pour le moment.</p>'}
      </article>
    `;
  }).join("");
}

function renderAgentRoster(activeAgents) {
  const active = new Set(["director", ...activeAgents]);
  agentRoster.innerHTML = AGENT_ROSTER.map(([id, label, parent]) => `
    <span class="agent-chip ${active.has(id) ? "active" : ""}" title="${parent ? `Sous ${parent}` : "Agent"}">
      ${escapeHtml(label)}${parent ? ` <small>↳ ${escapeHtml(parent)}</small>` : ""}
    </span>
  `).join("");
}

function renderApprovals() {
  const localApprovals = state.current?.decisionsRequired?.filter((decision) => decision.type === "approval") ?? [];
  const approvals = mergeApprovals(localApprovals, state.approvals);
  if (approvals.length === 0) {
    approvalList.innerHTML = '<p class="empty">Aucune approval en attente.</p>';
    return;
  }

  approvalList.innerHTML = approvals.map((approval) => `
    <article class="approval-card" data-approval-id="${escapeHtml(approval.id)}">
      <header>
        <div>
          <h3>${escapeHtml(approval.action)}</h3>
          <p>${escapeHtml(approval.reason ?? "Validation humaine requise.")}</p>
        </div>
        <span class="tag warning">${escapeHtml(approval.status)}</span>
      </header>
      <p class="muted">Agent: ${escapeHtml(formatAgent(approval.agent))} - Risque: ${escapeHtml(approval.risk ?? "medium")}</p>
      <p class="approval-status muted">Validation requise. Aucune execution avant autorisation humaine.</p>
      <div class="approval-actions">
        <button type="button" data-approve="${escapeHtml(approval.id)}">Autoriser</button>
        <button type="button" class="danger" data-reject="${escapeHtml(approval.id)}">Refuser</button>
      </div>
    </article>
  `).join("");

  approvalList.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", () => decideApproval(button.dataset.approve, "approve"));
  });
  approvalList.querySelectorAll("[data-reject]").forEach((button) => {
    button.addEventListener("click", () => decideApproval(button.dataset.reject, "reject"));
  });
}

function renderHistory() {
  if (state.history.length === 0) {
    historyList.innerHTML = '<p class="empty">Aucune demande recente.</p>';
    return;
  }

  historyList.innerHTML = state.history.map((entry) => `
    <article class="history-item" data-history-id="${escapeHtml(entry.requestId)}">
      <header>
        <h3>${escapeHtml(entry.status)}</h3>
        <span class="tag demo">demo</span>
      </header>
      <p>${escapeHtml(entry.message)}</p>
    </article>
  `).join("");

  historyList.querySelectorAll("[data-history-id]").forEach((item) => {
    item.addEventListener("click", () => {
      const selected = state.history.find((entry) => entry.requestId === item.dataset.historyId);
      if (selected) {
        state.current = selected;
        renderCurrent(selected);
      }
    });
  });
}

function mergeApprovals(localApprovals, pendingApprovals) {
  const mapped = [
    ...localApprovals.map((approval) => ({
      id: approval.approvalId,
      action: approval.action,
      reason: approval.reason,
      agent: approval.agent,
      risk: approval.risk,
      status: approval.status
    })),
    ...pendingApprovals.map((approval) => ({
      id: approval.id,
      action: approval.requestedAction,
      reason: approval.reason,
      agent: approval.requestingAgent,
      risk: approval.risk,
      status: approval.status
    }))
  ];
  return [...new Map(mapped.map((approval) => [approval.id, approval])).values()];
}

function describeItem(item) {
  return item.label ??
    item.customerName ??
    item.supplierName ??
    item.subject ??
    item.orderId ??
    item.id ??
    "Signal demo";
}

// One label per currency, never a sum. Two amounts in two currencies are two
// amounts, and adding them would invent money. A currency that is owed but has
// nothing late in it is simply absent from the overdue row rather than shown at
// zero, because zero late would say something the data does not say.
function renderAmounts(totals) {
  const entries = Object.entries(totals ?? {});
  if (entries.length === 0) {
    return '<span class="muted">aucun montant</span>';
  }
  return entries
    .map(([currency, amount]) => `<span class="tag">${escapeHtml(currency)} ${escapeHtml(String(amount))}</span>`)
    .join(" ");
}

// Amounts are rendered as the Director computed them. No locale formatting: the
// separator would depend on the machine, and a figure a reader has to reconcile
// with another screen is worth less than a figure that is simply the same one.
function renderFigures(aggregates) {
  const figures = aggregates ?? {};
  const rows = DIRECTOR_FIGURES
    .filter(([, domain]) => figures[domain])
    .map(([label, domain, totalsKey, countKey, countLabel]) => {
      const aggregate = figures[domain];
      const count = aggregate.counts?.[countKey] ?? 0;
      return `
        <li>
          <strong>${escapeHtml(label)}</strong>
          ${renderAmounts(aggregate[totalsKey])}
          <span class="muted">${escapeHtml(String(count))} ${escapeHtml(countLabel)}</span>
        </li>
      `;
    });

  // The order book carries no amount either, and must never be shown one: CDC
  // section 29 asks how many orders there are, not what they are worth. The
  // workshop file with no registered order is named on the same row, so the count
  // and the gap are read together instead of one hiding the other.
  const orders = figures.orders;
  if (orders) {
    const byStatus = Object.entries(orders.countsByStatus ?? {})
      .map(([status, count]) => `${escapeHtml(status)} ${escapeHtml(String(count))}`)
      .join(", ");
    const withoutOrder = figures.production?.productionWithoutOrder ?? [];
    rows.push(`
      <li>
        <strong>COMMANDES</strong>
        <span class="tag">${escapeHtml(String(orders.counts?.orders ?? 0))} au carnet</span>
        <span class="muted">${byStatus || "aucun statut"}</span>
        ${withoutOrder.length > 0
          ? `<span class="muted">anomalie: ${escapeHtml(String(withoutOrder.length))} production(s) sans commande enregistree (${withoutOrder.map((id) => escapeHtml(id)).join(", ")})</span>`
          : ""}
      </li>
    `);
  }

  // Purchase needs carry no amount at all: the demo set prices nothing, so this
  // row counts what is missing instead of valuing it.
  const materials = figures.purchase_needs;
  if (materials) {
    const counts = materials.counts ?? {};
    rows.push(`
      <li>
        <strong>BESOINS MATIERES</strong>
        <span class="tag">${escapeHtml(String(counts.shortages ?? 0))} rupture(s)</span>
        <span class="muted">${escapeHtml(String(counts.lines ?? 0))} ligne(s), ${escapeHtml(String(counts.orders ?? 0))} commande(s)</span>
      </li>
    `);
  }

  if (rows.length === 0) {
    return '<p class="muted">Aucun chiffre disponible.</p>';
  }
  return `<ul class="summary-list director-figures">${rows.join("")}</ul>`;
}

function renderDirectorSections(minimumSections) {
  return `
    <div class="director-sections">
      ${DIRECTOR_SECTIONS.map(([key, label]) => {
        const entries = minimumSections[key] ?? [];
        return `
          <section class="director-section">
            <h3>${escapeHtml(label)}</h3>
            ${entries.length > 0
              ? `<ul>${entries.slice(0, 6).map((entry) => `<li>${escapeHtml(describeSectionEntry(entry))}</li>`).join("")}</ul>`
              : '<p class="empty">Aucun resultat.</p>'}
          </section>
        `;
      }).join("")}
    </div>
  `;
}

function renderProvenance(domainSources) {
  if (!Array.isArray(domainSources) || domainSources.length === 0) {
    return '<p class="muted">Provenance indisponible.</p>';
  }
  return `
    <details class="provenance" open>
      <summary>Provenance des informations</summary>
      <ul>
        ${domainSources.map((entry) => `
          <li>
            <strong>${escapeHtml(formatAgent(entry.agent))}</strong>
            <span>${escapeHtml(entry.domain ?? "domain_unknown")}</span>
            <span>${escapeHtml(entry.dataSource ?? "source_unknown")}</span>
            <span>${escapeHtml(entry.sourceProvider ?? "provider_unknown")}</span>
            <span>${escapeHtml(entry.sourceId ?? "source_id_unknown")}</span>
          </li>
        `).join("")}
      </ul>
    </details>
  `;
}

function renderResultProvenance(result) {
  const parts = [
    result.domain,
    result.dataSource,
    result.sourceProvider,
    result.sourceId
  ].filter(Boolean);
  return parts.length > 0
    ? `<p class="source-line">${parts.map((part) => `<span class="tag demo">${escapeHtml(part)}</span>`).join("")}</p>`
    : "";
}

function describeSectionEntry(entry) {
  const item = entry.item ?? entry;
  const source = entry.domain ? ` (${entry.domain})` : "";
  return `${formatAgent(entry.agent)} - ${describeItem(item)}${source}`;
}

function formatAgent(agentId) {
  const names = {
    director: "Direction",
    after_sales: "SAV",
    commercial: "Commercial",
    finance: "Finance",
    production: "Production",
    purchasing: "Achats",
    marketing: "Marketing",
    community_manager: "Community Manager",
    hr: "RH",
    legal: "Juridique"
  };
  return names[agentId] ?? agentId ?? "Agent";
}

function formatStatus(status) {
  const labels = {
    completed: "Demo mock",
    partial: "Reponse partielle",
    requires_approval: "Validation requise",
    failed: "Erreur"
  };
  return labels[status] ?? status ?? "Demo mock";
}

function renderError(message) {
  summarySubtitle.textContent = "Erreur";
  uiState.textContent = "Erreur: la demande n'a pas pu etre traitee.";
  summaryContent.className = "";
  summaryContent.innerHTML = `<p>${escapeHtml(message)}</p>`;
}

function setLoading(isLoading) {
  form.querySelector("button[type='submit']").disabled = isLoading;
  form.querySelector("button[type='submit']").textContent = isLoading ? "Analyse en cours..." : "Envoyer au Director";
  uiState.textContent = isLoading ? "Chargement: Director analyse la demande." : uiState.textContent;
}

function card(title, body, tone = "") {
  return `<article class="approval-card ${tone}"><h3>${escapeHtml(title)}</h3><p>${body}</p></article>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// The datasheet panel. It calls one route of its own, POST /api/quotes/datasheet,
// because the Director builds a fixed input for every step it plans and a product
// reference has no way through it. Everything else is the cockpit as it was:
// postJson carries the token, and the approval card comes from refreshApprovals.
const datasheetForm = document.querySelector("#datasheet-form");
const datasheetReference = document.querySelector("#datasheet-reference");
const datasheetCustomer = document.querySelector("#datasheet-customer");
const datasheetQuantity = document.querySelector("#datasheet-quantity");
const datasheetState = document.querySelector("#datasheet-state");
const datasheetResult = document.querySelector("#datasheet-result");
const documentForm = document.querySelector("#document-form");
const documentType = document.querySelector("#document-type");
const documentNumber = document.querySelector("#document-number");
const documentDate = document.querySelector("#document-date");
const documentReference = document.querySelector("#document-reference");
const documentObject = document.querySelector("#document-object");
const documentClient = document.querySelector("#document-client");
const documentAddress = document.querySelector("#document-address");
const documentPaymentMethod = document.querySelector("#document-payment-method");
const documentPaymentTermsRule = document.querySelector("#document-payment-terms");
const documentPaymentTermsManual = document.querySelector("#document-payment-terms-manual");
const documentNote = document.querySelector("#document-note");
const documentItems = document.querySelector("#document-items");
const documentState = document.querySelector("#document-state");
const documentPreview = document.querySelector("#document-preview");
let lastDocumentPreview = null;

datasheetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitDatasheetQuote();
});

document.querySelectorAll("[data-datasheet]").forEach((button) => {
  button.addEventListener("click", () => {
    datasheetReference.value = button.dataset.datasheet;
    datasheetReference.focus();
  });
});

async function submitDatasheetQuote() {
  datasheetState.textContent = "Preparation en cours...";
  try {
    const payload = await postJson("/api/quotes/datasheet", {
      productReference: datasheetReference.value,
      customerId: datasheetCustomer.value,
      quantity: Number(datasheetQuantity.value)
    });

    renderDatasheetQuote(payload);
    datasheetState.textContent = payload.status === "approval_required"
      ? "Devis prepare: votre validation est requise."
      : "Preparation refusee: la base ne permet pas de repondre.";

    // The approval card comes from the panel that already exists. No second
    // approval mechanism is created here, and none is needed.
    await refreshApprovals();
  } catch (error) {
    datasheetResult.className = "";
    datasheetResult.innerHTML = card("Erreur preparation", escapeHtml(error.message), "warning");
    datasheetState.textContent = error.message;
  }
}

// The three provenances are rendered as three separate rows, in the order a
// reader follows them: what the product says, what the price list says, what was
// asked for. No fourth row: quantity times price belongs to none of the three,
// and a figure with no origin is exactly what this panel exists to avoid.
function renderDatasheetQuote(payload) {
  const sheet = payload.datasheet ?? {};
  datasheetResult.className = "";
  datasheetResult.innerHTML = `
    <p><strong>${escapeHtml(payload.status ?? "inconnu")}</strong></p>
    ${renderDatasheetIssues(sheet.issues ?? [])}
    ${renderDatasheetProduct(sheet.datasheet)}
    ${renderDatasheetPrices(sheet.prices ?? [])}
    ${renderDatasheetRequest(payload)}
  `;
}

function renderDatasheetIssues(issues) {
  if (issues.length === 0) {
    return "";
  }
  return `
    <ul class="summary-list">
      ${issues.map((issue) => `<li><strong>${escapeHtml(issue)}</strong></li>`).join("")}
    </ul>
  `;
}

function renderDatasheetProduct(product) {
  if (!product) {
    return '<p class="muted">Aucune fiche produit: la reference est introuvable.</p>';
  }
  return `
    <ul class="summary-list">
      <li>
        <strong>fromDatasheet</strong>
        <span>${escapeHtml(product.reference ?? "")}</span>
        <span>${escapeHtml(product.name ?? "")}</span>
        <span class="muted">${escapeHtml(product.category ?? "")} · ${escapeHtml(product.unit ?? "")} · ${escapeHtml(product.status ?? "")}</span>
        <span class="muted">${escapeHtml(product.imageRef ?? "aucune image")}</span>
      </li>
    </ul>
  `;
}

// Every price in force is shown and none is marked as chosen. Two tariffs is an
// ambiguity for a person to settle, not a choice this panel may make.
function renderDatasheetPrices(prices) {
  if (prices.length === 0) {
    return '<p class="muted">Aucun prix en vigueur, donc aucun montant propose.</p>';
  }
  return `
    <ul class="summary-list">
      ${prices.map((price) => `
        <li>
          <strong>fromPriceList</strong>
          <span class="tag">${escapeHtml(price.currency ?? "")} ${escapeHtml(String(price.amount))}</span>
          <span class="muted">${escapeHtml(price.unit ?? "")} · depuis ${escapeHtml(price.validFrom ?? "")}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderDatasheetRequest(payload) {
  const approval = payload.approval;
  return `
    <ul class="summary-list">
      <li>
        <strong>fromRequest</strong>
        <span>${escapeHtml(datasheetCustomer.value)}</span>
        <span class="muted">${escapeHtml(datasheetQuantity.value)}</span>
      </li>
      <li>
        <strong>Approbation</strong>
        ${approval
          ? `<span class="tag warning">${escapeHtml(approval.status)}</span><span class="muted">${escapeHtml(approval.requestedAction)}</span>`
          : '<span class="muted">aucune approbation ouverte</span>'}
      </li>
    </ul>
  `;
}

documentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await previewHkidsDocument();
});

async function previewHkidsDocument() {
  documentState.textContent = "Validation de l'aperçu...";
  try {
    const payload = await postJson("/api/documents/preview", collectDocumentInput());
    lastDocumentPreview = payload;
    renderDocumentPreview(payload);
    documentState.textContent = "Aperçu validé. Vérifiez puis générez.";
  } catch (error) {
    lastDocumentPreview = null;
    documentPreview.className = "";
    documentPreview.innerHTML = card("Erreur de validation", escapeHtml(error.message), "warning");
    documentState.textContent = error.message;
  }
}

function collectDocumentInput() {
  const items = JSON.parse(documentItems.value);
  const totalHt = items.reduce((sum, item) => sum + Number(item.amountHt), 0);
  const tva = Math.round(totalHt * 0.2 * 100) / 100;
  const totalTtc = Math.round((totalHt + tva) * 100) / 100;
  return {
    documentType: documentType.value,
    documentNumber: documentNumber.value,
    date: documentDate.value,
    object: documentObject.value,
    deliveryNoteReference: documentReference.value,
    client: {
      name: documentClient.value,
      address: documentAddress.value
    },
    items,
      totals: {
        totalHt,
        tva,
        totalTtc
      },
    payment: {
      method: documentPaymentMethod.value,
      termsRule: documentPaymentTermsRule.value,
      terms: documentPaymentTermsManual.value
    },
    note: documentNote.value
  };
}

function renderDocumentPreview(payload) {
  const document = payload.document;
  const invoice = document.documentType === "invoice";
  documentPreview.className = "";
  documentPreview.innerHTML = `
    <article class="approval-card">
      <div class="card-head">
        <div>
          <p class="eyebrow">Vérification H-KIDS</p>
          <h3>${escapeHtml(document.documentType === "invoice" ? "Facture" : "Bon de livraison")} ${escapeHtml(document.documentNumber)}</h3>
        </div>
        <span class="tag">${escapeHtml(payload.status)}</span>
      </div>
      <ul class="summary-list">
        <li><strong>Type de document</strong><span>${escapeHtml(document.documentType)}</span></li>
        <li><strong>Numéro</strong><span>${escapeHtml(document.documentNumber)}</span></li>
        <li><strong>Date</strong><span>${escapeHtml(document.date)}</span></li>
        ${document.deliveryNoteReference ? `<li><strong>Référence BL</strong><span>${escapeHtml(document.deliveryNoteReference)}</span></li>` : ""}
        ${document.object ? `<li><strong>Objet</strong><span>${escapeHtml(document.object)}</span></li>` : ""}
        <li><strong>Client</strong><span>${escapeHtml(document.client.name)}</span></li>
        <li><strong>Adresse</strong><span>${escapeHtml(document.client.address)}</span></li>
      </ul>
      <table class="document-table">
        <thead><tr>${
          invoice
            ? "<th>Désignation</th><th>Qté</th><th>Unité</th><th>Pu Brut</th><th>TVA</th><th>Pu TTC</th><th>Total HT</th><th>Total TTC</th>"
            : "<th>Désignation</th><th>Qté</th><th>Prix unitaire HT</th><th>Montant HT</th>"
        }</tr></thead>
        <tbody>${document.items.map((item) => `
          ${invoice ? `
            <tr>
              <td>${escapeHtml(item.designation)}</td>
              <td>${escapeHtml(String(item.quantity))}</td>
              <td>${escapeHtml(item.unit)}</td>
              <td>${escapeHtml(formatDh(item.unitPriceHt))}</td>
              <td>${escapeHtml(formatDh(item.tva))}</td>
              <td>${escapeHtml(formatDh(item.unitPriceTtc))}</td>
              <td>${escapeHtml(formatDh(item.amountHt))}</td>
              <td>${escapeHtml(formatDh(item.totalTtc))}</td>
            </tr>
          ` : `
            <tr>
              <td>${escapeHtml(item.designation)}</td>
              <td>${escapeHtml(String(item.quantity))}</td>
              <td>${escapeHtml(formatDh(item.unitPriceHt))}</td>
              <td>${escapeHtml(formatDh(item.amountHt))}</td>
            </tr>
          `}
        `).join("")}</tbody>
      </table>
      <ul class="summary-list">
        <li><strong>Total HT</strong><span>${escapeHtml(formatDh(document.totals.totalHt))}</span></li>
        <li><strong>TVA</strong><span>${escapeHtml(formatDh(document.totals.tva))}</span></li>
        <li><strong>Total TTC</strong><span>${escapeHtml(formatDh(document.totals.totalTtc))}</span></li>
        <li><strong>Conditions de paiement</strong><span>${escapeHtml(document.payment.terms)}</span></li>
        <li><strong>Moyen de paiement</strong><span>${escapeHtml(document.payment.method)}</span></li>
        ${document.note ? `<li><strong>Note</strong><span>${escapeHtml(document.note)}</span></li>` : ""}
      </ul>
      <div class="actions">
        <button type="button" id="document-generate">Valider et générer</button>
      </div>
      <div id="document-files"></div>
    </article>
  `;
  documentPreview.querySelector("#document-generate").addEventListener("click", generateHkidsDocument);
}

async function generateHkidsDocument() {
  if (!lastDocumentPreview) {
    return;
  }
  documentState.textContent = "Génération en cours...";
  const filesTarget = documentPreview.querySelector("#document-files");
  try {
    const payload = await postJson("/api/documents/generate", {
      ...collectDocumentInput(),
      previewToken: lastDocumentPreview.previewToken,
      userConfirmation: true
    });
    filesTarget.innerHTML = `
      <ul class="summary-list">
        <li><strong>PDF</strong><button type="button" class="link-button" data-download-url="${escapeHtml(payload.files.pdf.downloadUrl)}" data-download-name="${escapeHtml(payload.files.pdf.name)}">${escapeHtml(payload.files.pdf.name)}</button></li>
        <li><strong>Word</strong><button type="button" class="link-button" data-download-url="${escapeHtml(payload.files.docx.downloadUrl)}" data-download-name="${escapeHtml(payload.files.docx.name)}">${escapeHtml(payload.files.docx.name)}</button></li>
      </ul>
    `;
    filesTarget.querySelectorAll("[data-download-url]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await downloadGeneratedDocument(button.dataset.downloadUrl, button.dataset.downloadName);
        } catch (error) {
          documentState.textContent = error.message;
        }
      });
    });
    documentState.textContent = "Document généré.";
  } catch (error) {
    filesTarget.innerHTML = card("Erreur génération", escapeHtml(error.message), "warning");
    documentState.textContent = error.message;
  }
}

// A download link cannot carry the bearer token, so a plain <a href> answered
// 401. The button fetches with the header, then hands the blob to the browser.
async function downloadGeneratedDocument(url, name) {
  const response = await fetch(url, { headers: await authHeaders() });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? "Le telechargement a echoue.");
  }

  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function formatDh(value) {
  return `${new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value)).replace(/\u202f/g, " ")} DH`;
}

// Last, because it is the only part that runs rather than declares. It used to
// sit above the declarations, where the top level await suspended evaluation
// before let apiToken was reached: refreshApprovals then read a binding still in
// its temporal dead zone and the approvals panel showed
// "Cannot access 'apiToken' before initialization" on every page load.
//
// Function declarations hoist, so the call looked fine; let bindings do not.
// Anything that runs must therefore come after everything it depends on.
renderAgentRoster([]);
await refreshApprovals();
