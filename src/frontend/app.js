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
  ["DECISIONS NECESSAIRES", "DÉCISIONS NÉCESSAIRES"]
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

await refreshApprovals();
renderAgentRoster([]);

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
    const response = await fetch("/api/approvals");
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
    const response = await postJson(`/api/approvals/${id}/${decision}`, {
      approverId: "director-ui-demo"
    });
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
    headers: { "content-type": "application/json" },
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
