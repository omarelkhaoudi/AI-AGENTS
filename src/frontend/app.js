const state = {
  current: null,
  history: [],
  approvals: []
};

const form = document.querySelector("#director-form");
const messageInput = document.querySelector("#director-message");
const summarySubtitle = document.querySelector("#summary-subtitle");
const summaryContent = document.querySelector("#summary-content");
const planList = document.querySelector("#plan-list");
const agentResults = document.querySelector("#agent-results");
const approvalList = document.querySelector("#approval-list");
const historyList = document.querySelector("#history-list");
const apiStatus = document.querySelector("#api-status");

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
  apiStatus.textContent = response.status === "requires_approval" ? "Validation requise" : "Demo mock";
  apiStatus.style.color = response.status === "requires_approval" ? "#9f3412" : "#667085";
  renderSummary(response);
  renderPlan(response);
  renderAgents(response);
  renderHistory();
}

function renderSummary(response) {
  summarySubtitle.textContent = response.message;
  const sections = [
    ["Urgent", response.summary?.urgent?.length ?? 0],
    ["A encaisser", response.summary?.receivables?.length ?? 0],
    ["Retards", response.summary?.delayed?.length ?? 0],
    ["Achats", response.summary?.purchaseNeeds?.length ?? 0],
    ["SAV", response.summary?.afterSales?.length ?? 0],
    ["Decisions", response.decisionsRequired?.length ?? 0]
  ];

  summaryContent.className = "";
  summaryContent.innerHTML = `
    <p>${escapeHtml(response.summary?.headline ?? "Synthese indisponible.")}</p>
    <ul class="summary-list">
      ${sections.map(([label, count]) => `<li><strong>${label}</strong><br><span>${count} element(s)</span></li>`).join("")}
    </ul>
    <p class="muted">Source: demo_mock. Ces informations ne sont pas des donnees reelles de l'entreprise.</p>
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
        ${result.result?.demo ? '<span class="tag demo">demo_mock</span>' : ""}
        ${items.length > 0 ? `<ul>${itemList}</ul>` : '<p class="muted">Aucun resultat execute pour le moment.</p>'}
      </article>
    `;
  }).join("");
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
      <p class="approval-status muted">En attente de decision.</p>
      <div class="approval-actions">
        <button type="button" data-approve="${escapeHtml(approval.id)}">Approuver</button>
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

function formatAgent(agentId) {
  const names = {
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

function renderError(message) {
  summarySubtitle.textContent = "Erreur";
  summaryContent.className = "";
  summaryContent.innerHTML = `<p>${escapeHtml(message)}</p>`;
}

function setLoading(isLoading) {
  form.querySelector("button[type='submit']").disabled = isLoading;
  form.querySelector("button[type='submit']").textContent = isLoading ? "Analyse en cours..." : "Envoyer au Director";
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
