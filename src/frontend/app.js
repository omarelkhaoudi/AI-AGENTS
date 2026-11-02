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

// How each heading reads at a glance: its icon, and its tone. Green is good
// news, red needs attention, amber needs a decision, blue is money or material
// to follow; the others stay neutral.
const SECTION_META = Object.freeze({
  "CE QUI VA BIEN": { icon: "check-circle", tone: "good" },
  "RETARDS / PROBLEMES": { icon: "clock", tone: "danger" },
  "A ENCAISSER": { icon: "wallet", tone: "info" },
  "A COMMANDER": { icon: "cart", tone: "info" },
  "RISQUES / BLOCAGES": { icon: "alert", tone: "danger" },
  "DECISIONS NECESSAIRES": { icon: "user-check", tone: "warn" },
  "CE QUI NECESSITE UNE ACTION COMMERCIALE": { icon: "trend", tone: "neutral" },
  "CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION": { icon: "megaphone", tone: "neutral" },
  "CE QUI NECESSITE UNE INTERVENTION SAV": { icon: "wrench", tone: "neutral" },
  "CE QUI PRESENTE UN RISQUE JURIDIQUE": { icon: "scale", tone: "neutral" }
});

const FIGURE_ICONS = Object.freeze({
  "CHIFFRE D'AFFAIRES": "trend",
  ENCAISSEMENTS: "wallet",
  "CREANCES EN RETARD": "alert",
  COMMANDES: "package",
  "BESOINS MATIERES": "cart"
});

// The team, in the order of CDC section 15. Each agent has initials and a hue
// of its own, so it is recognised in every list without reading its name.
const AGENT_ROSTER = Object.freeze([
  { id: "director", initials: "Di", color: "#24584a", role: "Orchestre l'équipe et consolide le point du jour." },
  { id: "commercial", initials: "Co", color: "#2c6e9b", role: "Devis, relances clients et pipeline commercial." },
  { id: "finance", initials: "Fi", color: "#3f7d4e", role: "Encaissements, créances, factures et échéances." },
  { id: "production", initials: "Pr", color: "#b8641e", role: "Planning atelier, avancement et retards." },
  { id: "purchasing", initials: "Ac", color: "#7a5ba6", role: "Matières, fournisseurs, stock et besoins d'achat." },
  { id: "hr", initials: "RH", color: "#a64b6b", role: "Présences, contrats et besoins de personnel." },
  { id: "marketing", initials: "Ma", color: "#c2852b", role: "Campagnes, offres et positionnement." },
  { id: "community_manager", initials: "CM", color: "#d0688a", role: "Réseaux sociaux et contenus.", parent: "Marketing" },
  { id: "legal", initials: "Ju", color: "#4f5d75", role: "Contrats, clauses, risques et échéances juridiques." },
  { id: "after_sales", initials: "SA", color: "#2f8a87", role: "Réclamations, garanties et qualité après livraison." }
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
const approvalCount = document.querySelector("#approval-count");
const toastRegion = document.querySelector("#toast-region");
const sendButton = form.querySelector("button[type='submit']");

voicePlaceholder.dataset.voiceStatus = VOICE_INTERFACE.status;
voicePlaceholder.dataset.externalConnectionsEnabled = String(VOICE_INTERFACE.externalConnectionsEnabled);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await askDirector(messageInput.value);
});

// Ctrl+Enter (Cmd+Enter on a Mac) sends from the composer.
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    askDirector(messageInput.value);
  }
});

// A chip asks its question straight away: picking one is the request.
document.querySelectorAll("[data-scenario]").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.scenario;
    messageInput.focus();
    askDirector(messageInput.value);
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

// The Director answers as a conversational agent when the server has one
// configured; otherwise the cockpit keeps the keyword Director it always had.
const agentState = { enabled: false, conversationId: null, busy: false };
const agentPanel = document.querySelector("#agent-panel");
const agentThread = document.querySelector("#agent-thread");

const DOCUMENT_LABELS = Object.freeze({
  quote: "Devis",
  purchase_order: "Bon de commande",
  invoice: "Facture",
  delivery_note: "Bon de livraison"
});

async function askDirector(message) {
  if (agentState.enabled) {
    await sendToAgent(message);
    return;
  }
  await submitDirectorRequest(message);
}

async function checkAgentStatus() {
  try {
    const response = await fetch("/api/agent/status", { headers: await authHeaders() });
    agentState.enabled = response.ok && (await response.json()).configured === true;
  } catch {
    agentState.enabled = false;
  }
  if (agentState.enabled) {
    messageInput.value = "";
    messageInput.placeholder = "Ex. : Fais-moi un devis pour Meriem, un lit nuage à 3000 DH";
    uiState.textContent = "Director IA connecté. Écrivez votre demande comme à un assistant.";
  }
}

async function sendToAgent(message) {
  const text = message.trim();
  if (!text || agentState.busy) {
    return;
  }
  agentState.busy = true;
  agentPanel.hidden = false;
  appendBubble("user", escapeHtml(text));
  messageInput.value = "";
  const pending = appendBubble("agent pending", '<span class="typing"><i></i><i></i><i></i></span>');
  sendButton.disabled = true;
  sendButton.className = "primary send-button is-loading";
  uiState.textContent = "Le Director réfléchit…";
  try {
    const response = await postJson("/api/agent/chat", { message: text, conversationId: agentState.conversationId });
    agentState.conversationId = response.conversationId;
    pending.remove?.();
    appendBubble("agent", formatAgentText(response.reply), response.documents ?? [], response.agentRuns ?? [], response.messages ?? []);
    uiState.textContent = "Réponse reçue.";
    if (response.directorResponse) {
      state.current = { ...response.directorResponse, receivedAt: Date.now() };
      state.history = [state.current, ...state.history].slice(0, 8);
      renderCurrent(state.current);
    }
  } catch (error) {
    pending.remove?.();
    appendBubble("agent error", escapeHtml(error.message));
    uiState.textContent = error.message;
  } finally {
    agentState.busy = false;
    sendButton.disabled = false;
    sendButton.className = "primary send-button";
  }
}

function appendBubble(kind, html, documents = [], runs = [], messages = []) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind}`;
  bubble.innerHTML = `
    ${kind.startsWith("agent") ? avatar("director") : ""}
    <div class="bubble-body">
      ${runs.length > 0 ? teamStrip(runs) : ""}
      <div class="bubble-text">${html}</div>
      ${documents.map((entry, index) => documentCard(entry, index)).join("")}
      ${messages.map((draft) => messageCard(draft)).join("")}
    </div>
  `;
  agentThread.appendChild(bubble);
  bubble.querySelectorAll("[data-whatsapp]").forEach((button) => {
    button.addEventListener("click", () => openWhatsApp(button));
  });
  bubble.querySelectorAll("[data-validate]").forEach((button) => {
    const entry = documents[Number(button.dataset.validate)];
    button.addEventListener("click", () => validateAgentDocument(entry, button));
  });
  bubble.scrollIntoView?.({ behavior: "smooth", block: "end" });
  return bubble;
}

const MESSAGE_KIND_LABELS = Object.freeze({
  relance_devis: "Relance devis",
  relance_paiement: "Relance paiement",
  retard: "Retard",
  commande_fournisseur: "Commande fournisseur",
  sav: "SAV",
  autre: "Message"
});

// A message an agent drafted. Nothing is sent from here: the button opens
// WhatsApp with the number and the text filled in, and Hiba presses Send there.
// Both stay editable until then.
function messageCard(draft) {
  return `
    <article class="msg-card">
      <header>
        ${avatar(draft.agent)}
        <div>
          <strong>${escapeHtml(draft.recipient)}</strong>
          <span>${escapeHtml(MESSAGE_KIND_LABELS[draft.kind] ?? "Message")} · préparé par ${escapeHtml(formatAgent(draft.agent))}</span>
        </div>
        <span class="tag ${draft.phone ? "ok" : "warning"} msg-status">${draft.phone ? "Prêt" : "Numéro à compléter"}</span>
      </header>
      <label class="msg-field">Numéro WhatsApp
        <input class="msg-phone" value="${escapeHtml(draft.phone ? `+${draft.phone}` : "")}" placeholder="06 12 34 56 78">
      </label>
      <textarea class="msg-text" rows="${Math.min(10, Math.max(3, draft.message.split("\n").length + 1))}">${escapeHtml(draft.message)}</textarea>
      <div class="doc-actions">
        <button type="button" class="whatsapp-button" data-whatsapp>${icon("send")}Envoyer via WhatsApp</button>
        <span class="muted">S'ouvre dans WhatsApp : vous relisez, puis vous appuyez sur Envoyer.</span>
      </div>
    </article>
  `;
}

// Same rule as the server: a Moroccan 06/07/05 number gets its 212 prefix.
function whatsAppNumber(value) {
  const digits = String(value ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (/^0[5-7]\d{8}$/.test(digits)) {
    return `212${digits.slice(1)}`;
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function openWhatsApp(button) {
  const card = button.closest(".msg-card");
  const number = whatsAppNumber(card.querySelector(".msg-phone").value);
  const status = card.querySelector(".msg-status");
  if (!number) {
    status.className = "tag warning msg-status";
    status.textContent = "Numéro à compléter";
    card.querySelector(".msg-phone").focus();
    return;
  }
  const text = card.querySelector(".msg-text").value;
  globalThis.open?.(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  status.className = "tag ok msg-status";
  status.textContent = "Ouvert dans WhatsApp";
}

// Which agents worked on the answer, what they read, and what each one said.
function teamStrip(runs) {
  return `
    <div class="team-strip">
      ${runs.map((run) => `
        <details class="team-run">
          <summary>
            ${avatar(run.agent)}
            <span><strong>${escapeHtml(formatAgent(run.agent))}</strong><small>${escapeHtml(run.tools.length > 0 ? `a lu : ${run.tools.join(", ")}` : "a répondu")}</small></span>
          </summary>
          <div class="team-answer">${formatAgentText(run.answer)}</div>
        </details>
      `).join("")}
    </div>
  `;
}

// The model may answer with **bold** and line breaks; nothing else is rendered.
function formatAgentText(reply) {
  return escapeHtml(reply)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function documentCard(entry, index) {
  const preview = entry.preview.document;
  const instalments = preview.payment?.instalments ?? [];
  return `
    <article class="doc-card">
      <header>
        <span class="doc-icon">${icon("file")}</span>
        <div>
          <strong>${escapeHtml(DOCUMENT_LABELS[preview.documentType] ?? preview.documentType)} n° ${escapeHtml(preview.documentNumber)}</strong>
          <span>${escapeHtml(preview.client.name)} · ${escapeHtml(preview.client.address)} · ${escapeHtml(preview.date)}</span>
        </div>
        <span class="tag warning doc-status">À valider</span>
      </header>
      <table class="document-table">
        <thead><tr><th>Désignation</th><th>Qté</th><th>Montant HT</th></tr></thead>
        <tbody>${preview.items.map((item) => `<tr><td>${escapeHtml(item.designation)}</td><td>${escapeHtml(String(item.quantity))}</td><td>${escapeHtml(formatDh(item.netAmountHt ?? item.amountHt))}</td></tr>`).join("")}</tbody>
      </table>
      <ul class="doc-totals">
        <li><span>Total HT</span><strong>${escapeHtml(formatDh(preview.totals.totalHt))}</strong></li>
        <li><span>TVA 20 %</span><strong>${escapeHtml(formatDh(preview.totals.tva))}</strong></li>
        <li class="grand"><span>Total TTC</span><strong>${escapeHtml(formatDh(preview.totals.totalTtc))}</strong></li>
      </ul>
      ${instalments.length > 0
        ? `<p class="muted">${instalments.map((part) => `${escapeHtml(String(part.percent))} % ${escapeHtml(part.due)} : ${escapeHtml(formatDh(part.amount))}`).join(" · ")}</p>`
        : preview.payment?.terms ? `<p class="muted">${escapeHtml(preview.payment.terms)}</p>` : ""}
      <div class="doc-actions">
        <button type="button" class="primary" data-validate="${index}">${icon("check")}Valider et générer</button>
        <span class="muted">Pour corriger, dites-le simplement au Director.</span>
      </div>
      <div class="doc-files"></div>
    </article>
  `;
}

// Generation is the same confirmed step as in the documents panel: the preview
// token the agent obtained, and her explicit confirmation.
async function validateAgentDocument(entry, button) {
  const card = button.closest(".doc-card");
  const files = card.querySelector(".doc-files");
  const status = card.querySelector(".doc-status");
  button.disabled = true;
  button.textContent = "Génération…";
  try {
    const payload = await postJson("/api/documents/generate", {
      ...entry.input,
      previewToken: entry.preview.previewToken,
      userConfirmation: true
    });
    status.className = "tag ok doc-status";
    status.textContent = "Généré";
    button.remove();
    files.innerHTML = ["pdf", "docx"].map((format) => `
      <button type="button" class="secondary" data-download-url="${escapeHtml(payload.files[format].downloadUrl)}" data-download-name="${escapeHtml(payload.files[format].name)}">${icon("file")}${format === "pdf" ? "Télécharger le PDF" : "Télécharger le Word"}</button>
    `).join("");
    files.querySelectorAll("[data-download-url]").forEach((link) => {
      link.addEventListener("click", () => downloadGeneratedDocument(link.dataset.downloadUrl, link.dataset.downloadName).catch((error) => showToast(error.message, "warn")));
    });
    showToast(`${DOCUMENT_LABELS[entry.input.documentType] ?? "Document"} n° ${entry.input.documentNumber} généré.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Valider et générer";
    files.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
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
    state.current = { ...response, receivedAt: Date.now() };
    state.history = [state.current, ...state.history.filter((entry) => entry.requestId !== response.requestId)].slice(0, 8);
    renderCurrent(state.current);
    showToast(response.status === "requires_approval" ? "Action préparée : votre validation est requise." : "Synthèse prête.", response.status === "requires_approval" ? "warn" : "ok");
    await refreshApprovals();
  } catch (error) {
    renderError(error.message);
  } finally {
    setLoading(false);
  }
}

const PUBLICATION_DECISION_LABELS = {
  approved: "Publication approuvée",
  rejected: "Publication refusée"
};

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
    statusTarget.textContent = decisionResultLabel(response, decision);
    showToast(decision === "approve" ? "Décision enregistrée." : "Refus enregistré : rien n'a été exécuté.", decision === "approve" ? "ok" : "warn");
    await refreshApprovals();
  } catch (error) {
    statusTarget.textContent = error.message;
  }
}

// A publication approval executes nothing: the decision is carried to the
// publication, and the answer says what became of it. Every other approval runs
// a tool and keeps the wording it had.
function decisionResultLabel(response, decision) {
  if (response.publication) {
    return PUBLICATION_DECISION_LABELS[response.publication.status]
      ?? `Publication: ${response.publication.status}`;
  }

  return decision === "approve"
    ? `Action executee: ${response.execution?.status ?? "completed"}`
    : "Action rejetee.";
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error ?? "La requete a echoue.");
    error.details = payload.details ?? null;
    throw error;
  }
  return payload;
}

function renderCurrent(response) {
  apiStatus.textContent = formatStatus(response.status);
  apiStatus.style.color = response.status === "requires_approval" ? "#e0763f" : "";
  uiState.textContent = response.status === "partial"
    ? "Réponse partielle : certains agents n'ont pas pu répondre."
    : response.status === "requires_approval"
      ? "Validation en attente : aucune action sensible n'a été exécutée."
      : `Réponse reçue${response.receivedAt ? ` ${formatRelativeTime(response.receivedAt)}` : ""}.`;
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
    <p class="summary-headline">${escapeHtml(response.summary?.headline ?? "Synthese indisponible.")}</p>
    ${renderFigures(response.summary?.aggregates)}
    ${renderPriorities(response.summary?.urgent)}
    <div class="section-title"><h3>Le point en dix rubriques</h3></div>
    ${renderDirectorSections(minimumSections)}
    ${renderProvenance(domainSources)}
  `;
}

// What deserves attention first: the urgent signals, at most five, each with
// the agent that raised it and whether a decision is waiting on it.
function renderPriorities(urgent) {
  const entries = Array.isArray(urgent) ? urgent.slice(0, 5) : [];
  if (entries.length === 0) {
    return "";
  }
  return `
    <div class="section-title"><h3>À traiter en priorité</h3><span class="tag danger">${escapeHtml(String(urgent.length))} urgent(s)</span></div>
    <ul class="priority-list">
      ${entries.map((entry) => `
        <li>
          ${avatar(entry.agent)}
          <div class="priority-text">
            <strong>${escapeHtml(entry.label ?? describeSectionEntry(entry))}</strong>
            <span>${escapeHtml(formatAgent(entry.agent))}</span>
          </div>
          ${entry.item?.requiresDecision ? '<span class="tag warning">Décision</span>' : '<span class="tag danger">Urgent</span>'}
        </li>
      `).join("")}
    </ul>
  `;
}

function renderPlan(response) {
  const results = response.results ?? [];
  planList.innerHTML = results.map((result) => {
    const done = result.status === "completed";
    return `
      <li>
        ${avatar(result.agent)}
        <div class="step-text">
          <strong>${escapeHtml(formatAgent(result.agent))}</strong>
          <span>${escapeHtml(result.tool ?? "aucun outil")}</span>
        </div>
        <span class="step-status ${done ? "done" : "wait"}" title="${escapeHtml(result.status)}">${icon(done ? "check" : "clock")}</span>
      </li>
    `;
  }).join("");
}

function renderAgents(response) {
  const results = response.results ?? [];
  if (results.length === 0) {
    agentResults.innerHTML = '<p class="empty">Aucun agent sollicité.</p>';
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
            ${avatar(result.agent)}
            <div>
              <h3>${escapeHtml(formatAgent(result.agent))}</h3>
              <p class="muted">${escapeHtml(result.tool ?? "Action préparée")}</p>
            </div>
          </div>
          <span class="tag ${statusClass}">${escapeHtml(result.status)}</span>
        </header>
        ${renderResultProvenance(result)}
        ${items.length > 0 ? `<ul>${itemList}</ul>` : '<p class="muted">Aucun résultat pour le moment.</p>'}
      </article>
    `;
  }).join("");
}

function renderAgentRoster(activeAgents) {
  const active = new Set(["director", ...activeAgents]);
  agentRoster.innerHTML = AGENT_ROSTER.map((agent) => `
    <article class="agent-chip ${active.has(agent.id) ? "active" : ""}">
      <header>
        ${avatar(agent.id, "lg")}
        <div>
          <strong>${escapeHtml(formatAgent(agent.id))}</strong>
          ${agent.parent ? `<small>↳ sous ${escapeHtml(agent.parent)}</small>` : '<small>Agent spécialisé</small>'}
        </div>
        ${active.has(agent.id) && agent.id !== "director" ? '<span class="tag ok">a répondu</span>' : ""}
      </header>
      <p>${escapeHtml(agent.role)}</p>
    </article>
  `).join("");
}

function renderApprovals() {
  const localApprovals = state.current?.decisionsRequired?.filter((decision) => decision.type === "approval") ?? [];
  const approvals = mergeApprovals(localApprovals, state.approvals);
  const pending = approvals.filter((approval) => approval.status === "pending").length;
  approvalCount.textContent = String(pending);
  approvalCount.hidden = pending === 0;
  if (approvals.length === 0) {
    approvalList.innerHTML = `
      <div class="all-clear">
        <span class="badge">${icon("check-circle")}</span>
        <h3>Tout est à jour</h3>
        <p>Aucune approval en attente.</p>
      </div>
    `;
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
      <div class="approval-meta">
        ${avatar(approval.agent)}
        <span>${escapeHtml(formatAgent(approval.agent))}</span>
        <span class="tag ${["high", "critical"].includes(approval.risk) ? "danger" : "warning"}">Risque ${escapeHtml(approval.risk ?? "medium")}</span>
      </div>
      <p class="approval-status muted">Validation requise. Aucune exécution avant autorisation humaine.</p>
      <div class="approval-actions">
        <button type="button" class="primary" data-approve="${escapeHtml(approval.id)}">${icon("check")}Autoriser</button>
        <button type="button" class="danger" data-reject="${escapeHtml(approval.id)}">${icon("x")}Refuser</button>
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
    historyList.innerHTML = '<p class="empty">Aucune demande récente.</p>';
    return;
  }

  historyList.innerHTML = state.history.map((entry) => `
    <article class="history-item" data-history-id="${escapeHtml(entry.requestId)}">
      <span class="history-dot ${entry.status === "completed" ? "" : "warn"}" aria-hidden="true"></span>
      <div>
        <p>${escapeHtml(entry.message)}</p>
        <small>${escapeHtml(formatStatus(entry.status))}${entry.receivedAt ? ` · ${escapeHtml(formatRelativeTime(entry.receivedAt))}` : ""}</small>
      </div>
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
          <span class="kpi-icon">${icon(FIGURE_ICONS[label])}</span>
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
        <span class="kpi-icon">${icon(FIGURE_ICONS.COMMANDES)}</span>
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
        <span class="kpi-icon">${icon(FIGURE_ICONS["BESOINS MATIERES"])}</span>
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
        const meta = SECTION_META[key] ?? { icon: "sparkles", tone: "neutral" };
        const shown = entries.slice(0, 4);
        return `
          <section class="director-section" data-tone="${meta.tone}" data-empty="${entries.length === 0}">
            <header>
              <span class="section-icon">${icon(meta.icon)}</span>
              <h3>${escapeHtml(label)}</h3>
              <span class="section-count">${escapeHtml(String(entries.length))}</span>
            </header>
            ${entries.length > 0
              ? `<ul>${shown.map((entry) => `<li>${escapeHtml(describeSectionEntry(entry))}</li>`).join("")}</ul>
                 ${entries.length > shown.length ? `<p class="more">+ ${entries.length - shown.length} autre(s)</p>` : ""}`
              : '<p class="empty">Rien à signaler.</p>'}
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
    <details class="provenance">
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
  uiState.textContent = "Erreur : la demande n'a pas pu être traitée.";
  summaryContent.className = "";
  summaryContent.innerHTML = card("La demande n'a pas abouti", escapeHtml(message), "warning");
  planList.innerHTML = "";
  showToast("La demande n'a pas abouti.", "warn");
}

// While the Director works, the report is drawn as a skeleton and the team is
// shown being consulted, so the wait reads as work in progress.
function setLoading(isLoading) {
  sendButton.disabled = isLoading;
  sendButton.textContent = isLoading ? "Analyse en cours..." : "Envoyer au Director";
  sendButton.className = `primary send-button${isLoading ? " is-loading" : ""}`;
  if (!isLoading) {
    return;
  }
  uiState.textContent = "Le Director consulte les agents…";
  summaryContent.className = "";
  summaryContent.innerHTML = `
    <div class="skeleton" aria-label="Chargement">
      <div class="shimmer" style="width:60%"></div>
      <div class="skeleton-row">${'<div class="shimmer block"></div>'.repeat(4)}</div>
      <div class="skeleton-row">${'<div class="shimmer tall"></div>'.repeat(2)}<div></div><div></div></div>
      <div class="shimmer" style="width:85%"></div>
      <div class="shimmer" style="width:70%"></div>
    </div>
  `;
  planList.innerHTML = AGENT_ROSTER.filter((agent) => agent.id !== "director").map((agent, index) => `
    <li class="is-pending" style="--n:${index}">
      ${avatar(agent.id)}
      <div class="step-text"><strong>${escapeHtml(formatAgent(agent.id))}</strong><span>consultation…</span></div>
    </li>
  `).join("");
}

// The documents stepper: steps before the current one are done.
function setDocumentStep(step) {
  document.querySelectorAll(".stepper li").forEach((item, index) => {
    item.className = index + 1 < step ? "is-done" : index + 1 === step ? "is-active" : "";
  });
}

function icon(name) {
  return `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function avatar(agentId, size = "") {
  const agent = AGENT_ROSTER.find((entry) => entry.id === agentId);
  const initials = agent?.initials ?? String(agentId ?? "?").slice(0, 2);
  return `<span class="avatar ${size}" style="--c:${agent?.color ?? "#6b756f"}" title="${escapeHtml(formatAgent(agentId))}">${escapeHtml(initials)}</span>`;
}

// A short confirmation in the corner, gone after a few seconds.
function showToast(message, tone = "ok") {
  const toast = `<div class="toast ${tone}">${icon(tone === "ok" ? "check-circle" : "alert")}<span>${escapeHtml(message)}</span></div>`;
  toastRegion.innerHTML = toast;
  const timer = setTimeout(() => {
    toastRegion.innerHTML = "";
  }, 3800);
  timer?.unref?.();
}

function formatRelativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 45) {
    return "à l'instant";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `il y a ${minutes} min`;
  }
  return `il y a ${Math.round(minutes / 60)} h`;
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
const documentSpecifications = document.querySelector("#document-specifications");
const documentImage = document.querySelector("#document-image");
let lastDocumentPreview = null;
let documentReferenceImage = "";

documentType.addEventListener("change", () => applyDocumentType());
applyDocumentType();

// Shows the fields of the chosen document type. A purchase order has its own
// number series, so its next free number is asked to the server.
async function applyDocumentType() {
  const type = documentType.value;
  documentForm.querySelectorAll("[data-only-for]").forEach((element) => {
    element.hidden = element.dataset.onlyFor !== type;
  });
  documentForm.querySelectorAll("[data-hide-for]").forEach((element) => {
    element.hidden = element.dataset.hideFor === type;
  });
  const options = [...(documentPaymentTermsRule.options ?? [])];
  if (options.find((option) => option.selected)?.hidden) {
    documentPaymentTermsRule.value = options.find((option) => !option.hidden)?.value ?? "";
  }
  if (type === "purchase_order") {
    try {
      const response = await fetch("/api/documents/purchase-orders/next-number", { headers: await authHeaders() });
      if (response.ok) {
        documentNumber.value = (await response.json()).documentNumber;
      }
    } catch {
      // The number stays editable; the server refuses a number already issued.
    }
  }
}

// The visual is reduced in the browser before it is sent: a phone photo is
// several megabytes, and the order only needs it legible on an A4 page.
documentImage.addEventListener("change", async () => {
  documentReferenceImage = "";
  const file = documentImage.files?.[0];
  if (!file) {
    return;
  }
  try {
    documentReferenceImage = await downscaleImage(file, 1600, 0.85);
    documentState.textContent = "Visuel chargé.";
  } catch {
    documentState.textContent = "Le visuel n'a pas pu être lu.";
  }
});

function downscaleImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image illisible"));
    };
    image.src = url;
  });
}

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
    setDocumentStep(2);
  } catch (error) {
    lastDocumentPreview = null;
    documentPreview.className = "";
    documentPreview.innerHTML = card("Erreur de validation", describeDocumentError(error), "warning");
    documentState.textContent = error.message;
  }
}

// The field names and codes say what to correct; the bare message does not.
function describeDocumentError(error) {
  const details = error.details ?? {};
  const lines = (details.errors ?? []).map((entry) => `${entry.field} : ${entry.message}`);
  if (details.code === "PURCHASE_ORDER_NUMBER_USED") {
    lines.push(`Le numéro ${details.documentNumber} est déjà attribué. Prochain numéro libre : ${details.nextNumber}.`);
  }
  return [escapeHtml(error.message), ...lines.map(escapeHtml)].join("<br>");
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
    note: documentNote.value,
    ...(documentType.value === "purchase_order" ? {
      specifications: documentSpecifications.value.split("\n").map((line) => line.trim()).filter(Boolean),
      referenceImage: documentReferenceImage
    } : {})
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
          <h3>${escapeHtml({ invoice: "Facture", purchase_order: "Bon de commande" }[document.documentType] ?? "Bon de livraison")} ${escapeHtml(document.documentNumber)}</h3>
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
            ? "<th>Désignation</th><th>Qté</th><th>Unité</th><th>PU HT</th><th>TVA</th><th>PU TTC</th><th>Total HT</th><th>Total TTC</th>"
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
        ${(document.payment.instalments ?? []).map((instalment) => `<li><strong>${escapeHtml(`${instalment.percent} % ${instalment.due}`)}</strong><span>${escapeHtml(formatDh(instalment.amount))}</span></li>`).join("")}
        ${document.payment.method ? `<li><strong>Moyen de paiement</strong><span>${escapeHtml(document.payment.method)}</span></li>` : ""}
        ${document.note ? `<li><strong>Note</strong><span>${escapeHtml(document.note)}</span></li>` : ""}
        ${(document.specifications ?? []).length > 0 ? `<li><strong>Caractéristiques</strong><span>${document.specifications.map(escapeHtml).join("<br>")}</span></li>` : ""}
        ${document.referenceImage ? `<li><strong>Visuel</strong><span><img src="${escapeHtml(document.referenceImage)}" alt="Visuel de référence" style="max-width:160px;max-height:160px"></span></li>` : ""}
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
    setDocumentStep(3);
    showToast("PDF et Word générés.");
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

// The cockpit is one page with several views. The view is kept in the URL hash
// so a reload, or a link sent to a colleague, lands on the same screen.
const COCKPIT_VIEWS = Object.freeze({
  director: "Briefing du jour",
  approvals: "Validations",
  documents: "Documents H-KIDS",
  quotes: "Préparation de devis",
  file: "Dossier commercial",
  team: "Équipe IA"
});

function showView(name) {
  const view = Object.hasOwn(COCKPIT_VIEWS, name ?? "") ? name : "director";
  document.querySelector("#director-title").textContent = COCKPIT_VIEWS[view];
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view;
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    if (button.dataset.view === view) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  if (globalThis.location && globalThis.location.hash !== `#${view}`) {
    globalThis.history?.replaceState?.(null, "", `#${view}`);
  }
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
globalThis.addEventListener?.("hashchange", () => showView(globalThis.location.hash.slice(1)));

// "/" anywhere outside a field jumps to the composer, as in most command bars.
globalThis.addEventListener?.("keydown", (event) => {
  const target = event.target;
  const typing = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  if (event.key === "/" && !typing) {
    event.preventDefault();
    showView("director");
    messageInput.focus();
  }
});

// The greeting follows the hour, and the date is the leader's own day.
function renderGreeting(now = new Date()) {
  const hour = now.getHours();
  const greeting = hour < 5 || hour >= 18 ? "Bonsoir" : "Bonjour";
  document.querySelector("#greeting").textContent = `${greeting}, que veux-tu faire ?`;
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(now);
}

// Theme: follows the system by default; the button cycles system, light and
// dark, and the choice is remembered on this browser only.
const THEMES = Object.freeze([
  { id: "system", label: "Thème : système", icon: "monitor" },
  { id: "light", label: "Thème : clair", icon: "sun" },
  { id: "dark", label: "Thème : sombre", icon: "moon" }
]);

function readStoredTheme() {
  try {
    return globalThis.localStorage?.getItem("cockpitTheme") ?? "system";
  } catch {
    return "system";
  }
}

function applyTheme(id) {
  const theme = THEMES.find((entry) => entry.id === id) ?? THEMES[0];
  const root = document.documentElement;
  if (root) {
    if (theme.id === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme.id;
    }
  }
  document.querySelector("#theme-label").textContent = theme.label;
  document.querySelector("#theme-icon").setAttribute?.("href", `#i-${theme.icon}`);
  try {
    globalThis.localStorage?.setItem("cockpitTheme", theme.id);
  } catch {
    // Storage may be blocked; the theme still applies for this visit.
  }
  return theme.id;
}

let currentTheme = "system";
document.querySelector("#theme-toggle").addEventListener("click", () => {
  const index = THEMES.findIndex((entry) => entry.id === currentTheme);
  currentTheme = applyTheme(THEMES[(index + 1) % THEMES.length].id);
});

// --- commercial file ---------------------------------------------------------
//
// A presentation layer and nothing else. Every amount shown here comes from the
// API answer; this file never adds, multiplies or takes a percentage, and it
// never sends anything to a customer.
const fileForm = document.querySelector("#file-form");
const fileClient = document.querySelector("#file-client");
const fileAddress = document.querySelector("#file-address");
const fileDate = document.querySelector("#file-date");
const filePaymentMethod = document.querySelector("#file-payment-method");
const filePaymentRule = document.querySelector("#file-payment-rule");
const fileDiscountPercent = document.querySelector("#file-discount-percent");
const fileDiscountLines = document.querySelector("#file-discount-lines");
const fileItems = document.querySelector("#file-items");
const fileState = document.querySelector("#file-state");
const fileSummary = document.querySelector("#file-summary");
const fileDeliverables = document.querySelector("#file-deliverables");
const fileMissing = document.querySelector("#file-missing");
const fileFiles = document.querySelector("#file-files");

fileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await describeCommercialFile();
});

// The exact body the API expects, so a render request repeats the file the user
// just read rather than a second version of it.
function collectCommercialFileInput() {
  const percent = Number(fileDiscountPercent.value);
  const indexes = fileDiscountLines.value
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value));

  return {
    client: { name: fileClient.value, address: fileAddress.value },
    items: JSON.parse(fileItems.value),
    paymentMethod: filePaymentMethod.value,
    paymentScheduleRuleId: filePaymentRule.value || null,
    dates: { quoteDate: fileDate.value },
    // A discount is sent only when one was asked for. An empty field is not a
    // discount of zero, and an unnamed line is not every line.
    discount: Number.isFinite(percent) && percent > 0 && indexes.length > 0
      ? { percent, appliesToIndexes: indexes, label: "Remise exceptionnelle" }
      : null
  };
}

async function describeCommercialFile() {
  fileState.textContent = "Consultation du dossier...";
  try {
    const payload = await postJson("/api/commercial-files/preview", collectCommercialFileInput());
    renderCommercialFile(payload);
    fileState.textContent = "Dossier consulté.";
  } catch (error) {
    fileSummary.className = "";
    fileSummary.innerHTML = card("Erreur dossier", escapeHtml(error.message), "warning");
    fileDeliverables.innerHTML = "";
    fileMissing.innerHTML = "";
    fileFiles.innerHTML = "";
    fileState.textContent = error.message;
  }
}

function renderCommercialFile(payload) {
  const totals = payload.file.totals;
  fileSummary.className = "";
  fileSummary.innerHTML = `
    <ul class="summary-list">
      ${totals.totalDiscount > 0 ? `<li><strong>Total brut HT</strong><span>${escapeHtml(formatDh(totals.totalBrutHt))}</span></li>` : ""}
      ${totals.totalDiscount > 0 ? `<li><strong>Remise</strong><span>${escapeHtml(formatDh(totals.totalDiscount))}</span></li>` : ""}
      <li><strong>Total HT</strong><span>${escapeHtml(formatDh(totals.totalHt))}</span></li>
      <li><strong>TVA</strong><span>${escapeHtml(formatDh(totals.tva))}</span></li>
      <li><strong>Total TTC</strong><span>${escapeHtml(formatDh(totals.totalTtc))}</span></li>
    </ul>
    ${renderCommercialSchedule(payload.file.schedule)}
  `;
  renderCommercialDeliverables(payload.deliverables);
  renderCommercialMissingInformation(payload.missingInformation);
  fileFiles.innerHTML = "";
}

function renderCommercialSchedule(schedule) {
  if (!schedule) {
    return card("Échéancier", "Aucun échéancier choisi pour ce dossier.", "warning");
  }
  return `
    <h3>Échéancier</h3>
    <ul class="summary-list">
      ${schedule.installments.map((entry) => `
        <li>
          <strong>${escapeHtml(String(entry.percent))} %</strong>
          <span>${escapeHtml(formatDh(entry.amountTtc))}</span>
          <span class="muted">${escapeHtml(entry.condition)}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

// Client-facing and internal are kept visibly apart: the point of the split is
// that nobody sends an internal working paper to a customer by accident.
function renderCommercialDeliverables(deliverables) {
  const group = (audience) => deliverables
    .filter((entry) => entry.audience === audience)
    .map((entry) => `
      <li>
        <strong>${escapeHtml(entry.label)}</strong>
        <span class="tag ${entry.audience === "client" ? "ok" : ""}">${entry.audience === "client" ? "CLIENT" : "INTERNE"}</span>
        ${entry.audienceConfirmed ? "" : '<span class="tag warning">destinataire à confirmer</span>'}
        ${entry.rendering.available
          ? `<button type="button" class="secondary" data-render="${escapeHtml(entry.kind)}">Générer</button>`
          : `<span class="muted">${escapeHtml(entry.rendering.reason)}</span>`}
      </li>
    `).join("");

  fileDeliverables.innerHTML = `
    <h3>Documents client</h3>
    <ul class="summary-list">${group("client")}</ul>
    <h3>Livrables internes</h3>
    <ul class="summary-list">${group("internal")}</ul>
  `;

  fileDeliverables.querySelectorAll("[data-render]").forEach((button) => {
    button.addEventListener("click", () => generateCommercialDeliverable(button.dataset.render));
  });
}

// Reported, never filled in.
function renderCommercialMissingInformation(missing) {
  if (!missing || missing.length === 0) {
    fileMissing.innerHTML = "";
    return;
  }
  fileMissing.innerHTML = `
    <h3>Informations manquantes</h3>
    <ul class="summary-list">
      ${missing.map((entry) => `
        <li>
          <strong>${escapeHtml(entry.label)}</strong>
          <span class="muted">${escapeHtml(entry.message)}</span>
          ${entry.critical ? '<span class="tag warning">bloquante</span>' : ""}
        </li>
      `).join("")}
    </ul>
  `;
}

async function generateCommercialDeliverable(deliverable) {
  fileState.textContent = "Génération en cours...";
  try {
    const payload = await postJson("/api/commercial-files/render", {
      ...collectCommercialFileInput(),
      deliverable
    });
    fileFiles.innerHTML = `
      <h3>${escapeHtml(payload.deliverable.label)}</h3>
      <ul class="summary-list">
        ${["pdf", "docx"].map((format) => `
          <li>
            <strong>${format.toUpperCase()}</strong>
            <button type="button" class="link-button" data-download-url="${escapeHtml(payload.files[format].downloadUrl)}" data-download-name="${escapeHtml(payload.files[format].name)}">${escapeHtml(payload.files[format].name)}</button>
          </li>
        `).join("")}
      </ul>
    `;
    fileFiles.querySelectorAll("[data-download-url]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await downloadGeneratedDocument(button.dataset.downloadUrl, button.dataset.downloadName);
        } catch (error) {
          fileState.textContent = error.message;
        }
      });
    });
    fileState.textContent = "Document généré. Aucun envoi client n'a été effectué.";
  } catch (error) {
    fileFiles.innerHTML = card("Erreur génération", escapeHtml(error.message), "warning");
    fileState.textContent = error.message;
  }
}

// Last, because it is the only part that runs rather than declares. It used to
// sit above the declarations, where the top level await suspended evaluation
// before let apiToken was reached: refreshApprovals then read a binding still in
// its temporal dead zone and the approvals panel showed
// "Cannot access 'apiToken' before initialization" on every page load.
//
// Function declarations hoist, so the call looked fine; let bindings do not.
// Anything that runs must therefore come after everything it depends on.
showView(globalThis.location?.hash?.slice(1));
currentTheme = applyTheme(readStoredTheme());
renderGreeting();
renderAgentRoster([]);
await checkAgentStatus();
renderHistory();
await refreshApprovals();
