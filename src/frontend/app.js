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
  { id: "administration", initials: "Ad", color: "#6b6f2a", role: "Registre des documents et dossiers clients." },
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
const briefingReport = document.querySelector("#briefing-report");
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
const photoInput = document.querySelector("#photo-input");
const photoButton = document.querySelector("#photo-button");
const photoTray = document.querySelector("#photo-tray");

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

// Photos and documents for the Director: picked with the button, dropped on the
// composer or pasted. A photo is shrunk to a JPEG here, so a phone photo of
// several megabytes travels as a few hundred kilobytes and can also become a
// purchase order's visual. A document (PDF, Word, Excel, text) travels as is;
// the server reads it.
const MAX_CHAT_PHOTOS = 4;
const MAX_CHAT_FILES = 4;
const MAX_CHAT_FILE_BYTES = 5 * 1024 * 1024;
const CHAT_FILE_EXTENSIONS = ["pdf", "docx", "xlsx", "txt", "csv", "md"];
const composerPhotos = [];
const composerFiles = [];

photoButton.addEventListener("click", () => photoInput.click());
photoInput.addEventListener("change", async () => {
  await addComposerAttachments(photoInput.files);
  photoInput.value = "";
});
messageInput.addEventListener("paste", async (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length > 0 && agentState.enabled) {
    event.preventDefault();
    await addComposerAttachments(files);
  }
});
form.addEventListener("dragover", (event) => {
  if (agentState.enabled && [...(event.dataTransfer?.types ?? [])].includes("Files")) {
    event.preventDefault();
    form.classList.add("is-dragging");
  }
});
form.addEventListener("dragleave", () => form.classList.remove("is-dragging"));
form.addEventListener("drop", async (event) => {
  form.classList.remove("is-dragging");
  if (!agentState.enabled || !event.dataTransfer?.files?.length) {
    return;
  }
  event.preventDefault();
  await addComposerAttachments(event.dataTransfer.files);
});
photoTray.addEventListener("click", (event) => {
  const photo = event.target.closest("[data-remove-photo]");
  const file = event.target.closest("[data-remove-file]");
  if (photo) {
    composerPhotos.splice(Number(photo.dataset.removePhoto), 1);
  } else if (file) {
    composerFiles.splice(Number(file.dataset.removeFile), 1);
  }
  renderPhotoTray();
});

async function addComposerAttachments(fileList) {
  for (const file of [...fileList]) {
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
    if (file.type.startsWith("image/")) {
      if (composerPhotos.length >= MAX_CHAT_PHOTOS) {
        showToast(`${MAX_CHAT_PHOTOS} photos au plus par message.`, "warn");
        continue;
      }
      try {
        composerPhotos.push(await downscaleImage(file, 1600, 0.85));
      } catch {
        showToast(`La photo « ${file.name} » n'a pas pu être lue.`, "warn");
      }
    } else if (!CHAT_FILE_EXTENSIONS.includes(extension)) {
      const hint = extension === "doc" || extension === "xls" ? " Enregistrez-le en .docx ou .xlsx, ou en PDF." : "";
      showToast(`« ${file.name} » n'est pas pris en charge : PDF, Word, Excel, texte ou CSV.${hint}`, "warn");
    } else if (file.size > MAX_CHAT_FILE_BYTES) {
      showToast(`« ${file.name} » dépasse 5 Mo.`, "warn");
    } else if (composerFiles.length >= MAX_CHAT_FILES) {
      showToast(`${MAX_CHAT_FILES} documents au plus par message.`, "warn");
    } else {
      try {
        composerFiles.push({ name: file.name, data: await readAsDataUrl(file) });
      } catch {
        showToast(`« ${file.name} » n'a pas pu être lu.`, "warn");
      }
    }
    renderPhotoTray();
  }
  messageInput.focus();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function fileChip(name) {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toUpperCase() ?? "";
  return `${icon("file")}<span class="file-chip-name">${escapeHtml(name)}</span><small>${escapeHtml(extension)}</small>`;
}

function renderPhotoTray() {
  photoTray.hidden = composerPhotos.length === 0 && composerFiles.length === 0;
  photoTray.innerHTML = [
    ...composerPhotos.map((url, index) => `
      <li>
        <img src="${url}" alt="Photo jointe ${index + 1}">
        <button type="button" class="photo-remove" data-remove-photo="${index}" title="Retirer cette photo" aria-label="Retirer la photo ${index + 1}">×</button>
      </li>
    `),
    ...composerFiles.map((file, index) => `
      <li class="file-chip">
        ${fileChip(file.name)}
        <button type="button" class="photo-remove" data-remove-file="${index}" title="Retirer ce document" aria-label="Retirer ${escapeHtml(file.name)}">×</button>
      </li>
    `)
  ].join("");
}

// A chip asks its question straight away: picking one is the request.
document.querySelectorAll("[data-scenario]").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.scenario;
    messageInput.focus();
    askDirector(messageInput.value);
  });
});

document.querySelector("#refresh-approvals").addEventListener("click", () => refreshApprovals());

// The cockpit authenticates like any other client. Signing in with an email and
// a password gives a session token, kept in this browser for 30 days. In demo
// mode, on a development machine, the server hands out a token instead and no
// sign-in is shown.
const SESSION_KEY = "hkidsSession";
const nativeFetch = globalThis.fetch.bind(globalThis);
const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
let apiToken = null;
let pendingLogin = null;

function readStoredToken() {
  try {
    return globalThis.localStorage?.getItem(SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

function keepSession(token) {
  apiToken = token;
  try {
    globalThis.localStorage?.setItem(SESSION_KEY, token);
  } catch {
    // Private browsing: the session lasts as long as the page.
  }
}

function forgetSession() {
  apiToken = null;
  try {
    globalThis.localStorage?.removeItem(SESSION_KEY);
  } catch {
    // Nothing kept, nothing to remove.
  }
}

function showSession({ user, demo }) {
  const name = user?.name ?? "";
  document.querySelector("#session-name").textContent = name;
  document.querySelector("#session-avatar").textContent = initials(name);
  document.querySelector("#session-box").hidden = demo === true;
}

// "Hiba Benali" → "HB", "Omar" → "O": the avatar of the person signed in.
function initials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

// One sign-in at a time: every request waiting for a token waits for this one.
function askLogin() {
  pendingLogin ??= new Promise((resolve) => {
    loginScreen.hidden = false;
    loginError.hidden = true;
    document.querySelector("#login-email").focus();
    loginForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = document.querySelector("#login-submit");
      submit.disabled = true;
      try {
        const response = await nativeFetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: loginForm.email.value, password: loginForm.password.value })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          loginError.textContent = response.status === 429
            ? "Trop d'essais. Patientez une minute avant de réessayer."
            : payload.error ?? "Connexion impossible.";
          loginError.hidden = false;
          return;
        }
        keepSession(payload.token);
        loginForm.password.value = "";
        loginScreen.hidden = true;
        pendingLogin = null;
        resolve({ user: payload.user, demo: false });
      } catch {
        loginError.textContent = "Le serveur ne répond pas. Vérifiez la connexion internet.";
        loginError.hidden = false;
      } finally {
        submit.disabled = false;
      }
    };
  });
  return pendingLogin;
}

// True when a session is open: one kept from an earlier visit that the server
// still accepts, or a demo token. False means the sign-in has to be shown.
async function ensureSession() {
  apiToken ??= readStoredToken();
  if (apiToken) {
    const me = await nativeFetch("/api/auth/me", { headers: { authorization: `Bearer ${apiToken}` } });
    if (me.ok) {
      showSession(await me.json());
      return true;
    }
    forgetSession();
  }
  const demo = await nativeFetch("/api/auth/demo-session");
  if (demo.ok) {
    const payload = await demo.json();
    keepSession(payload.token);
    showSession({ user: payload.user, demo: true });
    return true;
  }
  return false;
}

// A session that expires or is revoked while the page is open brings the
// sign-in back, instead of every panel failing one after the other.
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  const sentToken = Boolean(init?.headers?.authorization);
  if (response.status === 401 && sentToken && apiToken) {
    forgetSession();
    askLogin().then(showSession);
  }
  return response;
};

document.querySelector("#logout-button").addEventListener("click", async () => {
  if (apiToken) {
    await nativeFetch("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${apiToken}` } }).catch(() => {});
  }
  forgetSession();
  showSession(await askLogin());
});

async function resolveApiToken() {
  if (!apiToken && pendingLogin) {
    await pendingLogin;
  }
  if (!apiToken) {
    throw new Error("Authentification requise : connectez-vous.");
  }
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
  photoButton.hidden = !agentState.enabled;
  if (agentState.enabled) {
    messageInput.value = "";
    messageInput.placeholder = "Ex. : Je veux 100 000 DH de chiffre d'affaires ce mois";
    uiState.textContent = "Director IA connecté. Donnez-lui un objectif : il bâtit la stratégie et fait travailler les responsables.";
  }
}

async function sendToAgent(message) {
  const text = message.trim();
  const photos = composerPhotos.splice(0);
  const files = composerFiles.splice(0);
  if ((!text && photos.length === 0 && files.length === 0) || agentState.busy) {
    composerPhotos.push(...photos);
    composerFiles.push(...files);
    return;
  }
  agentState.busy = true;
  agentPanel.hidden = false;
  appendBubble("user", escapeHtml(text), [], [], [], { photos, files });
  messageInput.value = "";
  renderPhotoTray();
  const pending = appendBubble("agent pending", '<span class="typing"><i></i><i></i><i></i></span>');
  sendButton.disabled = true;
  sendButton.className = "primary send-button is-loading";
  uiState.textContent = "Le Director réfléchit…";
  try {
    const response = await postJson("/api/agent/chat", { message: text, photos, files, conversationId: agentState.conversationId });
    agentState.conversationId = response.conversationId;
    pending.remove?.();
    appendBubble("agent", formatAgentText(response.reply), response.documents ?? [], response.agentRuns ?? [], response.messages ?? [], { plan: response.plan, alerts: response.alerts, found: response.foundDocuments ?? [], exports: response.exports ?? [] });
    uiState.textContent = "Réponse reçue.";
    if (response.plan) {
      refreshPlans();
    }
    // Finance may have recorded money, an agent analysed an anomaly or moved
    // an order: the other views follow without a reload.
    refreshCash();
    refreshImprovement();
    refreshTeam();
    if (response.directorResponse) {
      state.current = { ...response.directorResponse, receivedAt: Date.now() };
      state.history = [state.current, ...state.history].slice(0, 8);
      renderCurrent(state.current);
    }
  } catch (error) {
    pending.remove?.();
    appendBubble("agent error", escapeHtml(error.message));
    uiState.textContent = error.message;
    // Nothing reached the Director: give the message and attachments back to retry.
    messageInput.value ||= text;
    if (composerPhotos.length === 0 && composerFiles.length === 0) {
      composerPhotos.push(...photos);
      composerFiles.push(...files);
      renderPhotoTray();
    }
  } finally {
    agentState.busy = false;
    sendButton.disabled = false;
    sendButton.className = "primary send-button";
  }
}

function appendBubble(kind, html, documents = [], runs = [], messages = [], { plan = null, alerts = null, photos = [], files = [], found = [], exports = [] } = {}) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind}`;
  bubble.innerHTML = `
    ${kind.startsWith("agent") ? avatar("director") : ""}
    <div class="bubble-body">
      ${plan ? planCard(plan) : ""}
      ${runs.length > 0 ? teamStrip(runs) : ""}
      ${photos.length > 0 ? `<div class="bubble-photos">${photos.map((url, index) => `<span><img src="${url}" alt="Photo jointe ${index + 1}"></span>`).join("")}</div>` : ""}
      ${files.length > 0 ? `<div class="bubble-files">${files.map((file) => `<span class="file-chip">${fileChip(file.name)}</span>`).join("")}</div>` : ""}
      ${html ? `<div class="bubble-text answer-text">${html}</div>` : ""}
      ${documents.map((entry, index) => documentCard(entry, index)).join("")}
      ${found.length > 0 ? foundCard(found) : ""}
      ${exports.map((file, index) => exportCard(file, index)).join("")}
      ${Array.isArray(alerts) ? alertsCard(alerts) : ""}
      ${messages.map((draft) => messageCard(draft)).join("")}
    </div>
  `;
  agentThread.appendChild(bubble);
  bubble.querySelectorAll("[data-whatsapp]").forEach((button) => {
    button.addEventListener("click", () => openWhatsApp(button));
  });
  bubble.querySelectorAll("[data-whatsapp-api]").forEach((button) => {
    button.addEventListener("click", () => sendDraftFromNumber(button));
  });
  bubble.querySelectorAll("[data-open-pdf]").forEach((button) => {
    button.addEventListener("click", () => openRegisterPdf(button.dataset.openPdf));
  });
  bubble.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => saveExport(exports[Number(button.dataset.export)]));
  });
  bubble.querySelectorAll("[data-validate]").forEach((button) => {
    const entry = documents[Number(button.dataset.validate)];
    button.addEventListener("click", () => validateAgentDocument(entry, button));
  });
  bubble.scrollIntoView?.({ behavior: "smooth", block: "end" });
  return bubble;
}

// The Director's action plan: what it set out to do, and how far it got.
function planCard(plan) {
  const done = plan.steps.filter((step) => step.status === "done").length;
  return `
    <article class="plan-card">
      <header>
        <span class="doc-icon">${icon("route")}</span>
        <div>
          <span class="eyebrow">Plan d'action${plan.number ? ` n° ${escapeHtml(String(plan.number))}` : ""} · <a href="#plans">suivre dans Plans</a></span>
          <strong>${escapeHtml(plan.objective)}</strong>
        </div>
        <span class="tag ${done === plan.steps.length ? "ok" : "warning"}">${done}/${plan.steps.length} étapes</span>
      </header>
      ${plan.measure ? objectiveGauge(plan.measure) : ""}
      ${plan.strategy ? `<p class="plan-strategy"><b>Stratégie :</b> ${escapeHtml(plan.strategy)}</p>` : ""}
      ${plan.priorities.length > 0 ? `<ol class="plan-priorities">${plan.priorities.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : ""}
      <ul class="plan-steps">
        ${plan.steps.map((step) => `
          <li class="${step.status === "done" ? "done" : ""}">
            ${avatar(step.agent)}
            <span>${escapeHtml(step.task)}${step.dueDate ? ` <small class="${step.overdue ? "late" : "muted"}">· avant le ${escapeHtml(formatIsoDay(step.dueDate))}</small>` : ""}</span>
            <span class="tag ${STEP_TONES[step.status] ?? ""}">${escapeHtml(STEP_STATUS_LABELS[step.status] ?? step.status)}</span>
          </li>
        `).join("")}
      </ul>
    </article>
  `;
}

// Where a figure stands: achieved against target, the gap and the pace needed.
// The figures are computed by the server from the business data.
function objectiveGauge(measure) {
  return `
    <div class="objective-gauge ${measure.reached ? "reached" : ""}">
      <div class="objective-figures">
        <span><small>${escapeHtml(measure.label)}</small><strong>${escapeHtml(formatDh(measure.achieved))}</strong></span>
        <span><small>Objectif</small><strong>${escapeHtml(formatDh(measure.target))}</strong></span>
        <span><small>Reste à faire</small><strong>${escapeHtml(formatDh(measure.gap))}</strong></span>
        <span><small>Par jour restant</small><strong>${escapeHtml(formatDh(measure.pacePerDay))}</strong></span>
      </div>
      <div class="progress" title="${measure.percent} %"><span style="width:${measure.percent}%"></span></div>
      <p class="progress-label">
        ${measure.percent} % · du ${escapeHtml(formatIsoDay(measure.period.from))} au ${escapeHtml(formatIsoDay(measure.period.to))} · ${measure.period.daysLeft} jour(s) restant(s)
        · devis ouverts : ${measure.openQuotes.count} (${escapeHtml(formatDh(measure.openQuotes.amount))})
        ${measure.demo ? "· <em>données de démonstration</em>" : ""}
      </p>
    </div>
  `;
}

const STEP_STATUS_LABELS = Object.freeze({ todo: "À faire", in_progress: "En cours", done: "Fait", blocked: "Bloqué" });
const STEP_TONES = Object.freeze({ todo: "", in_progress: "info", done: "ok", blocked: "danger" });
const PLAN_STATUS_LABELS = Object.freeze({ active: "En cours", done: "Terminé", abandoned: "Abandonné" });

function formatIsoDay(value) {
  const [year, month, day] = String(value).split("-");
  return day && month ? `${day}/${month}/${year}` : value;
}

// --- The day at a glance --------------------------------------------------------
// Six cards on the briefing, read from what the other views already load: the
// cash of the day, the validations waiting, the orders in the workshop, the
// plans under way, the rules to decide and the orders installed. Each opens
// its view.
const overviewGrid = document.querySelector("#overview");
const overview = { approvals: null, orders: null, plans: null, cash: null, improvement: null };
overviewGrid.addEventListener("click", (event) => {
  const tile = event.target.closest?.("[data-goto]");
  if (tile) {
    if (tile.dataset.filter) {
      workshopView.filter = tile.dataset.filter;
    }
    showView(tile.dataset.goto);
  }
});

function updateOverview(part) {
  Object.assign(overview, part);
  const { approvals, orders, plans, cash, improvement } = overview;
  const plural = (count, word) => `${count} ${word}${count > 1 ? "s" : ""}`;
  const toDecide = improvement?.rules.filter((rule) => rule.status === "proposee").length ?? 0;
  const toAnalyse = improvement?.anomalies.filter((anomaly) => anomaly.status === "a_analyser").length ?? 0;
  const inForce = improvement?.rules.filter((rule) => rule.status === "active").length ?? 0;
  const moved = cash ? cash.entries.filter((entry) => !entry.cancelled).length : 0;
  const watch = orders?.filter((order) => order.alerts.length > 0).length ?? 0;
  const installed = orders?.filter((order) => order.finished) ?? [];
  const toInvoice = installed.filter((order) => order.remaining > 0).length;
  const activePlans = plans?.filter((plan) => plan.status === "active") ?? [];
  const overdue = activePlans.reduce((sum, plan) => sum + (plan.progress?.overdue ?? 0), 0);
  const tiles = [
    {
      view: "cash", icon: "wallet", label: "Caisse du jour", money: true,
      value: cash ? formatShortDh(cash.closing) : null,
      tone: cash && cash.closing < 0 ? "danger" : "brand",
      hint: cash === null ? "chargement…" : moved > 0 ? `+\u00a0${formatShortDh(cash.totalIn)} · −\u00a0${formatShortDh(cash.totalOut)} aujourd'hui` : "aucun mouvement aujourd'hui"
    },
    {
      view: "approvals", icon: "shield", label: "À valider", value: approvals,
      tone: approvals > 0 ? "warn" : "good",
      hint: approvals === null ? "chargement…" : approvals > 0 ? `${plural(approvals, "action")} en attente de votre accord` : "rien n'attend votre accord"
    },
    {
      view: "orders", filter: watch > 0 ? "watch" : "active", icon: "wrench", label: "En atelier",
      value: orders ? orders.filter((order) => !order.finished).length : null,
      tone: watch > 0 ? "danger" : "brand",
      hint: orders === null ? "chargement…" : watch > 0 ? `${plural(watch, "commande")} à surveiller` : orders.length > 0 ? "aucune alerte" : "aucune commande au carnet"
    },
    {
      view: "plans", icon: "route", label: "Plans en cours", value: plans ? activePlans.length : null,
      tone: overdue > 0 ? "danger" : "info",
      hint: plans === null ? "chargement…" : overdue > 0 ? `${plural(overdue, "étape")} en retard` : activePlans.length > 0 ? "dans les temps" : "donnez un objectif au Director"
    },
    {
      view: "improvement", icon: "bulb", label: "Amélioration", value: improvement ? toDecide : null,
      tone: toDecide > 0 ? "warn" : toAnalyse > 0 ? "info" : "good",
      hint: improvement === null ? "chargement…" : toDecide > 0 ? `${plural(toDecide, "règle")} à valider` : toAnalyse > 0 ? `${plural(toAnalyse, "anomalie")} en analyse` : inForce > 0 ? `${plural(inForce, "règle")} en vigueur` : "aucune anomalie"
    },
    {
      view: "orders", filter: "done", icon: "check-circle", label: "Installées", value: orders ? installed.length : null,
      tone: toInvoice > 0 ? "warn" : "good",
      hint: orders === null ? "chargement…" : toInvoice > 0 ? `${plural(toInvoice, "commande")} reste à facturer` : installed.length > 0 ? "facturées en totalité" : "aucune pour l'instant"
    }
  ];
  overviewGrid.innerHTML = tiles.map((tile) => `
    <button type="button" class="overview-tile" data-tone="${tile.tone}" data-goto="${tile.view}" ${tile.filter ? `data-filter="${tile.filter}"` : ""}>
      <span class="overview-icon">${icon(tile.icon)}</span>
      <span class="overview-label">${escapeHtml(tile.label)}</span>
      <strong class="overview-value ${tile.money ? "is-money" : ""}">${tile.value ?? "–"}</strong>
      <small>${escapeHtml(tile.hint)}</small>
      <span class="overview-go" aria-hidden="true">${icon("arrow")}</span>
    </button>
  `).join("");
}

// --- Plans view ---------------------------------------------------------------
const plansList = document.querySelector("#plans-list");
const plansCount = document.querySelector("#plans-count");
document.querySelector("#refresh-plans").addEventListener("click", () => refreshPlans());

async function refreshPlans() {
  try {
    const response = await fetch("/api/plans", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger les plans.");
    }
    renderPlans((await response.json()).plans ?? []);
  } catch (error) {
    plansList.innerHTML = card("Plans indisponibles", escapeHtml(error.message), "warning");
  }
}

function renderPlans(plans) {
  const active = plans.filter((plan) => plan.status === "active");
  plansCount.textContent = String(active.length);
  plansCount.hidden = active.length === 0;
  updateOverview({ plans });
  if (plans.length === 0) {
    plansList.innerHTML = `
      <div class="all-clear">
        <span class="badge">${icon("route")}</span>
        <h3>Aucun plan pour le moment</h3>
        <p>Donnez un objectif au Director, par exemple « Je veux 100 000 DH de chiffre d'affaires ce mois » : il établit la stratégie, répartit le travail entre les responsables et la suit ici.</p>
      </div>
    `;
    return;
  }
  plansList.innerHTML = [...active, ...plans.filter((plan) => plan.status !== "active")].map((plan) => `
    <article class="plan-track ${plan.status}" data-plan-id="${escapeHtml(plan.id)}">
      <header>
        <div>
          <span class="eyebrow">Plan n° ${escapeHtml(String(plan.number))} · créé le ${escapeHtml(formatIsoDay(plan.createdAt.slice(0, 10)))}</span>
          <h3>${escapeHtml(plan.objective)}</h3>
          ${plan.strategy ? `<p class="muted">${escapeHtml(plan.strategy)}</p>` : ""}
        </div>
        <span class="tag ${plan.status === "active" ? "info" : plan.status === "done" ? "ok" : ""}">${escapeHtml(PLAN_STATUS_LABELS[plan.status] ?? plan.status)}</span>
      </header>
      ${plan.measure ? objectiveGauge(plan.measure) : ""}
      <div class="progress" title="${plan.progress.done}/${plan.progress.total} étapes">
        <span style="width:${plan.progress.percent}%"></span>
      </div>
      <p class="progress-label">
        ${plan.progress.done}/${plan.progress.total} étapes faites
        ${plan.progress.overdue > 0 ? `· <span class="late">${plan.progress.overdue} en retard</span>` : ""}
        ${plan.progress.blocked > 0 ? `· <span class="late">${plan.progress.blocked} bloquée(s)</span>` : ""}
      </p>
      <ul class="track-steps">
        ${plan.steps.map((step) => `
          <li class="${step.status}">
            ${avatar(step.agent)}
            <div>
              <strong>${escapeHtml(step.task)}</strong>
              <small>${escapeHtml(formatAgent(step.agent))}${step.dueDate ? ` · avant le <span class="${step.overdue ? "late" : ""}">${escapeHtml(formatIsoDay(step.dueDate))}</span>` : ""}</small>
              ${step.result ? `<details><summary>Résultat</summary><div class="answer-text">${formatAgentText(step.result)}</div></details>` : ""}
            </div>
            <select data-step="${step.index}" aria-label="Statut de l'étape ${step.index}" ${plan.status !== "active" ? "disabled" : ""}>
              ${Object.entries(STEP_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${value === step.status ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </li>
        `).join("")}
      </ul>
      <details class="journal">
        <summary>Journal du plan</summary>
        <ul>${[...plan.journal].reverse().map((entry) => `<li><small>${escapeHtml(formatIsoDay(entry.at.slice(0, 10)))} ${escapeHtml(entry.at.slice(11, 16))}</small> ${escapeHtml(entry.text)}</li>`).join("")}</ul>
      </details>
      <div class="doc-actions">
        ${plan.status === "active"
          ? `<button type="button" class="secondary" data-close="terminer">${icon("check")}Terminer le plan</button><button type="button" class="danger" data-close="abandonner">${icon("x")}Abandonner</button>`
          : `<button type="button" class="secondary" data-close="reouvrir">${icon("refresh")}Rouvrir</button>`}
      </div>
    </article>
  `).join("");

  plansList.querySelectorAll("[data-plan-id]").forEach((article) => {
    const id = article.dataset.planId;
    article.querySelectorAll("select[data-step]").forEach((select) => {
      select.addEventListener("change", async () => {
        await sendPlanChange(`/api/plans/${id}/steps/${select.dataset.step}`, "PATCH", { status: select.value });
      });
    });
    article.querySelectorAll("[data-close]").forEach((button) => {
      button.addEventListener("click", async () => {
        await sendPlanChange(`/api/plans/${id}/close`, "POST", { action: button.dataset.close });
      });
    });
  });
}

async function sendPlanChange(url, method, body) {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error((await response.json()).error ?? "La mise à jour a échoué.");
    }
    showToast("Plan mis à jour.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshPlans();
}

// --- Cash view ----------------------------------------------------------------
// The cash book Finance keeps: the balance of a day, its movements, the month by
// category, and a form for a movement typed by hand. Every figure comes from the
// server; this view adds nothing up.
const cashBalanceGrid = document.querySelector("#cash-balance");
const cashEntries = document.querySelector("#cash-entries");
const cashEntriesLabel = document.querySelector("#cash-entries-label");
const cashMonth = document.querySelector("#cash-month");
const cashMonthLabel = document.querySelector("#cash-month-label");
const cashDay = document.querySelector("#cash-day");
const cashForm = document.querySelector("#cash-form");
const cashAmount = document.querySelector("#cash-amount");
const cashCategory = document.querySelector("#cash-category");
const cashLabel = document.querySelector("#cash-label");
const cashMethod = document.querySelector("#cash-method");
const cashDate = document.querySelector("#cash-date");
const cashParty = document.querySelector("#cash-party");
const cashQuote = document.querySelector("#cash-quote");
const cashOrder = document.querySelector("#cash-order");
const cashConfidential = document.querySelector("#cash-confidential");
const cashConfidentialField = document.querySelector("#cash-confidential-field");
const cashSubmit = document.querySelector("#cash-submit");
const cashView = { data: null, kind: "entree" };

document.querySelector("#refresh-cash").addEventListener("click", () => refreshCash());
cashDay.addEventListener("change", () => refreshCash());
cashForm.addEventListener("change", (event) => {
  if (event.target?.name === "kind") {
    cashView.kind = event.target.value;
    fillCashChoices();
  }
});
cashForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitCashMovement(false);
});
const cashPending = document.querySelector("#cash-pending");
const cashPendingGroups = document.querySelector("#cash-pending-groups");
const EXPENSE_TONES = Object.freeze({ declaree: "warning", justifiee: "info", approuvee: "ok", rapprochee: "ok" });
for (const container of [cashEntries, cashPendingGroups]) {
  container.addEventListener("click", (event) => handleExpenseAction(event));
  container.addEventListener("change", (event) => {
    const input = event.target.closest?.("[data-receipt-for]");
    if (input?.files?.[0]) {
      uploadReceipt(input.dataset.receiptFor, input.files[0]);
    }
  });
}

// Opening a proof, approving, reconciling: the buttons of an expense, the
// same in the day's list and in the panel of expenses to put in order.
async function handleExpenseAction(event) {
  const view = event.target.closest?.("[data-receipt-view]");
  if (view) {
    const [number, id] = view.dataset.receiptView.split("/");
    await openReceipt(number, id);
    return;
  }
  const decision = event.target.closest?.("[data-expense-decision]");
  if (!decision) {
    return;
  }
  const [number, action] = decision.dataset.expenseDecision.split(":");
  const question = action === "approve"
    ? `Approuver la dépense n° ${number} ? Vous confirmez l'avoir vérifiée avec son justificatif.`
    : `Rapprocher la dépense n° ${number} ? Vous l'avez retrouvée sur le relevé de banque ou dans le comptage de la caisse.`;
  if (!globalThis.confirm?.(question)) {
    return;
  }
  decision.disabled = true;
  try {
    await postJson(`/api/cash/${number}/${action}`, {});
    showToast(action === "approve" ? `Dépense n° ${number} approuvée.` : `Dépense n° ${number} rapprochée.`);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshCash();
}

async function uploadReceipt(number, file) {
  try {
    await postJson(`/api/cash/${number}/receipts`, { name: file.name, data: await readAsDataUrl(file) });
    showToast(`Justificatif joint à la dépense n° ${number}.`);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshCash();
}

// A proof needs the session token, so it is fetched, then shown from memory.
async function openReceipt(number, id) {
  try {
    const response = await fetch(`/api/cash/${encodeURIComponent(number)}/receipts/${encodeURIComponent(id)}`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Justificatif introuvable.");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    showToast(error.message, "warn");
  }
}

// The state of an expense and what can be done next, for one line.
function expenseControls(entry) {
  if (entry.kind !== "sortie" || entry.cancelled) {
    return "";
  }
  if (entry.masked) {
    return `<div class="cash-expense"><span class="tag ${EXPENSE_TONES[entry.status] ?? "info"}">${escapeHtml(entry.statusLabel)}</span><span class="tag">réservée à la direction</span></div>`;
  }
  const receipts = entry.receipts.map((receipt, index) => `<button type="button" class="link-button" data-receipt-view="${entry.number}/${escapeHtml(receipt.id)}">${icon(receipt.mimeType === "application/pdf" ? "file" : "image")}Justificatif${entry.receipts.length > 1 ? ` ${index + 1}` : ""}</button>`).join("");
  const attach = entry.status === "declaree" || entry.status === "justifiee"
    ? `<label class="link-button cash-attach">${icon("paperclip")}${entry.receipts.length > 0 ? "Ajouter" : "Joindre le justificatif"}<input type="file" accept="image/jpeg,image/png,application/pdf" data-receipt-for="${entry.number}" class="visually-hidden"></label>`
    : "";
  const decide = entry.status === "justifiee" && entry.needsApproval
    ? `<button type="button" class="secondary cash-decide" data-expense-decision="${entry.number}:approve">${icon("check")}Approuver</button>`
    : (entry.status === "justifiee" && !entry.needsApproval) || entry.status === "approuvee"
      ? `<button type="button" class="link-button" data-expense-decision="${entry.number}:reconcile">${icon("check-circle")}Rapprocher</button>`
      : "";
  return `
    <div class="cash-expense">
      <span class="tag ${EXPENSE_TONES[entry.status] ?? "info"}">${escapeHtml(entry.statusLabel)}</span>
      ${entry.needsApproval && !entry.approval ? '<span class="tag danger">au-dessus du seuil</span>' : ""}
      ${receipts}${attach}${decide}
    </div>`;
}

function renderCashPending(pending) {
  const groups = [
    { title: "Sans justificatif", hint: "envoyez la photo du reçu au Director, ou joignez-la ici", entries: pending.missingReceipt },
    { title: "À approuver", hint: `au-dessus de ${formatDh(pending.threshold)}`, entries: pending.awaitingApproval },
    { title: "À rapprocher", hint: "à retrouver sur le relevé ou dans la caisse", entries: pending.toReconcile }
  ].filter((group) => group.entries.length > 0);
  cashPending.hidden = groups.length === 0;
  cashPendingGroups.innerHTML = groups.map((group) => `
    <div class="cash-pending-group">
      <h3>${escapeHtml(group.title)} <span class="tag info">${group.entries.length}</span> <small>${escapeHtml(group.hint)}</small></h3>
      <ul class="cash-entries">${[...group.entries].reverse().slice(0, 8).map((entry) => cashEntryLine(entry, { withDay: true })).join("")}</ul>
    </div>`).join("");
}

cashEntries.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-cash-cancel]");
  if (!button) {
    return;
  }
  const reason = globalThis.prompt?.("Pourquoi annuler ce mouvement ? Il restera au journal, barré.") ?? "";
  if (reason.trim() === "") {
    return;
  }
  try {
    await postJson(`/api/cash/${button.dataset.cashCancel}/cancel`, { reason });
    showToast("Mouvement annulé.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshCash();
});

function localIsoDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function refreshCash() {
  try {
    const day = cashDay.value ? `?day=${encodeURIComponent(cashDay.value)}` : "";
    const response = await fetch(`/api/cash${day}`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger la caisse.");
    }
    renderCash(await response.json());
  } catch (error) {
    cashBalanceGrid.innerHTML = card("Caisse indisponible", escapeHtml(error.message), "warning");
  }
}

function renderCash(data) {
  cashView.data = data;
  const { day, month, today } = data;
  if (day.day === today) {
    updateOverview({ cash: day });
  }
  cashDay.value ||= day.day;
  cashDate.value ||= today;
  cashDate.max = today;
  cashDay.max = today;
  fillCashChoices();
  const isToday = day.day === today;
  const when = isToday ? "aujourd'hui" : `le ${formatIsoDay(day.day)}`;
  const live = day.entries.filter((entry) => !entry.cancelled);
  const count = (kind) => live.filter((entry) => entry.kind === kind && entry.category !== data.categories.opening).length;
  cashBalanceGrid.innerHTML = `
    <div class="cash-tile"><span>Solde d'ouverture</span><strong>${formatDhNbsp(day.opening)}</strong><small>au début ${isToday ? "de la journée" : `du ${escapeHtml(formatIsoDay(day.day))}`}${day.carriedIn > 0 ? ` · + ${formatDhNbsp(day.carriedIn)} de solde de départ` : ""}</small></div>
    <div class="cash-tile" data-tone="good"><span>Entrées</span><strong>+\u00a0${formatDhNbsp(day.totalIn)}</strong><small>${count("entree")} mouvement${count("entree") > 1 ? "s" : ""} ${when}</small></div>
    <div class="cash-tile" data-tone="danger"><span>Sorties</span><strong>−\u00a0${formatDhNbsp(day.totalOut)}</strong><small>${count("sortie")} mouvement${count("sortie") > 1 ? "s" : ""} ${when}</small></div>
    <div class="cash-tile is-closing" data-tone="${day.closing < 0 ? "danger" : "brand"}"><span>Solde de clôture</span><strong>${formatDhNbsp(day.closing)}</strong><small>dont espèces ${formatDhNbsp(day.closingCash)} · banque ${formatDhNbsp(day.closingBank)}</small></div>
  `;

  if (data.pending) {
    renderCashPending(data.pending);
  }
  cashEntriesLabel.textContent = isToday ? "Mouvements du jour" : `Mouvements du ${formatIsoDay(day.day)}`;
  cashEntries.innerHTML = day.entries.length > 0
    ? [...day.entries].reverse().map((entry) => cashEntryLine(entry)).join("")
    : `<li class="cash-empty">Aucun mouvement ${escapeHtml(when)}. Annoncez-le au Director : « J'ai payé 1 200 DH de laque par chèque » ou « J'ai reçu l'acompte de Mme Alami, 2 700 DH en espèces ».</li>`;

  cashMonthLabel.textContent = `${new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(new Date(`${month.month}-15T12:00:00`))}`;
  const largest = Math.max(1, ...month.byCategory.map((entry) => entry.amount));
  cashMonth.innerHTML = `
    <dl class="cash-month-figures">
      <div><dt>Entrées</dt><dd class="text-good">+\u00a0${formatDhNbsp(month.totalIn)}</dd></div>
      <div><dt>Sorties</dt><dd class="text-danger">−\u00a0${formatDhNbsp(month.totalOut)}</dd></div>
      <div><dt>Résultat du mois</dt><dd>${formatDhNbsp(month.net)}</dd></div>
      <div><dt>Solde en fin de période</dt><dd>${formatDhNbsp(month.closing)}</dd></div>
    </dl>
    ${month.byCategory.length > 0 ? `
      <ul class="cash-bars">
        ${month.byCategory.map((entry) => `
          <li data-kind="${entry.kind}">
            <span>${escapeHtml(entry.label)} <small>(${entry.count})</small></span>
            <b>${entry.kind === "entree" ? "+" : "−"}\u00a0${formatDhNbsp(entry.amount)}</b>
            <i style="width:${Math.max(3, Math.round((entry.amount / largest) * 100))}%"></i>
          </li>
        `).join("")}
      </ul>` : '<p class="muted text-[13px]">Aucun mouvement ce mois-ci.</p>'}
  `;
}

function cashEntryLine(entry, { withDay = false } = {}) {
  const meta = [
    withDay ? formatIsoDay(entry.day) : "",
    entry.categoryLabel,
    entry.methodLabel,
    entry.party,
    entry.quoteNumber ? `devis n° ${entry.quoteNumber}` : "",
    entry.orderNumber ? `BC n° ${entry.orderNumber}` : "",
    entry.announcedBy && entry.announcedBy !== "cockpit" ? `annoncé par ${entry.announcedBy}` : "saisi au cockpit"
  ].filter(Boolean);
  return `
    <li class="cash-entry ${entry.cancelled ? "is-cancelled" : ""}" data-kind="${entry.kind}">
      <span class="cash-sign" aria-hidden="true">${icon(entry.kind === "entree" ? "plus" : "minus")}</span>
      <div class="min-w-0 flex-1">
        <strong>${entry.confidential && !entry.masked ? `${icon("shield")}` : ""}${escapeHtml(entry.label)}</strong>
        <small>n° ${entry.number} · ${escapeHtml(meta.join(" · "))}</small>
        ${entry.cancelled ? `<small class="cash-cancel-reason">Annulé : ${escapeHtml(entry.cancelled.reason)}</small>` : ""}
        ${expenseControls(entry)}
      </div>
      <b class="cash-amount">${entry.masked ? '<span class="muted">confidentiel</span>' : `${entry.kind === "entree" ? "+" : "−"}\u00a0${formatDhNbsp(entry.amount)}`}</b>
      ${entry.cancelled || entry.reconciliation || withDay || entry.masked ? "" : `<button type="button" class="icon-button cash-cancel" data-cash-cancel="${entry.number}" title="Annuler ce mouvement">${icon("x")}<span class="visually-hidden">Annuler le mouvement n° ${entry.number}</span></button>`}
    </li>
  `;
}

// The categories follow the direction of the movement; the opening balance is
// offered once, at the end of the takings.
function fillCashChoices() {
  const data = cashView.data;
  if (!data) {
    return;
  }
  const kind = cashView.kind;
  const options = Object.entries(data.categories[kind] ?? {});
  if (kind === "entree") {
    options.push([data.categories.opening, "Solde de départ de la caisse"]);
  }
  const chosen = options.some(([value]) => value === cashCategory.value) ? cashCategory.value : options[0]?.[0];
  cashCategory.innerHTML = options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === chosen ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
  if (!cashMethod.dataset.filled) {
    cashMethod.innerHTML = Object.entries(data.methods).map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === "especes" ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
    cashMethod.dataset.filled = "true";
  }
  cashSubmit.className = `primary mt-4 w-full justify-center ${kind === "sortie" ? "is-out" : ""}`;
  // Only the direction records a confidential expense or a salary.
  cashConfidentialField.hidden = kind !== "sortie" || data.confidential !== true;
  if (data.confidential !== true) {
    cashCategory.querySelector("option[value='salaire']")?.remove();
  }
}

async function submitCashMovement(confirmDuplicate) {
  const body = {
    kind: cashView.kind,
    amount: Number(String(cashAmount.value).replace(",", ".")),
    category: cashCategory.value,
    label: cashLabel.value,
    method: cashMethod.value,
    day: cashDate.value,
    party: cashParty.value,
    quoteNumber: cashQuote.value,
    orderNumber: cashOrder.value,
    confidential: cashView.kind === "sortie" && cashConfidential.checked,
    confirmDuplicate
  };
  cashSubmit.disabled = true;
  try {
    const response = await fetch("/api/cash", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (response.status === 409 && !confirmDuplicate) {
      cashSubmit.disabled = false;
      if (globalThis.confirm?.(`${payload.error}\n\nEnregistrer quand même ce second mouvement ?`)) {
        await submitCashMovement(true);
      }
      return;
    }
    if (!response.ok) {
      throw new Error(payload.error ?? "Le mouvement n'a pas été enregistré.");
    }
    showToast(`${body.kind === "entree" ? "Entrée" : "Sortie"} n° ${payload.entry.number} enregistrée.`);
    for (const field of [cashAmount, cashLabel, cashParty, cashQuote, cashOrder]) {
      field.value = "";
    }
    cashDay.value = payload.entry.day;
    renderCash({ ...cashView.data, day: payload.day });
    await refreshCash();
  } catch (error) {
    showToast(error.message, "warn");
  } finally {
    cashSubmit.disabled = false;
  }
}

// --- Continuous improvement view -------------------------------------------------
// The anomalies, what caused them, and the rules that keep them from coming
// back: proposed by the agent in charge, in force once the direction says so.
const IMPROVEMENT_FILTERS = Object.freeze([
  { id: "decide", label: "À valider", hint: "règles proposées par les agents" },
  { id: "analyse", label: "À analyser", hint: "en attente de leur cause" },
  { id: "open", label: "Anomalies ouvertes", hint: "pas encore levées" },
  { id: "rules", label: "Règles en vigueur", hint: "données aux agents à chaque mission" }
]);
const improvementStats = document.querySelector("#improvement-stats");
const improvementList = document.querySelector("#improvement-list");
const improvementCount = document.querySelector("#improvement-count");
const improvementView = { data: null, filter: null, busy: new Set() };
document.querySelector("#refresh-improvement").addEventListener("click", () => refreshImprovement());
improvementStats.addEventListener("click", (event) => {
  const tile = event.target.closest?.("[data-filter]");
  if (tile) {
    improvementView.filter = improvementView.filter === tile.dataset.filter ? null : tile.dataset.filter;
    renderImprovement(improvementView.data);
  }
});
improvementList.addEventListener("submit", async (event) => {
  const formNode = event.target.closest?.("[data-assign-form]");
  if (!formNode) {
    return;
  }
  event.preventDefault();
  const read = (name) => formNode.querySelector(`[name='${name}']`)?.value ?? "";
  const dueDate = read("dueDate");
  try {
    const result = await postJson(`/api/improvement/anomalies/${formNode.dataset.assignForm}/assign`, {
      agent: read("agent"), person: read("person"), phone: read("phone"), severity: read("severity"), instruction: read("instruction"),
      dueDate: dueDate ? dueDate.split("-").reverse().join("/") : ""
    });
    showToast(`Tâche n° ${formNode.dataset.assignForm} confiée : ${result.notified}.`);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshImprovement();
});
improvementList.addEventListener("click", async (event) => {
  const target = event.target.closest?.("[data-rule-decision], [data-analyse], [data-lift], [data-task-move], [data-closure]");
  if (!target) {
    return;
  }
  if (target.dataset.taskMove) {
    const [number, action] = target.dataset.taskMove.split(":");
    const note = action === "resolue" ? globalThis.prompt?.("Qu'est-ce qui a été fait ?") : "";
    if (action === "resolue" && !note?.trim()) {
      return;
    }
    await sendImprovementChange(`/api/improvement/anomalies/${number}/task`, { action, note }, action === "resolue" ? "Tâche notée résolue : confirmez sa clôture quand c'est vérifié." : "Tâche notée prise en charge.");
  }
  if (target.dataset.closure) {
    const [number, decision] = target.dataset.closure.split(":");
    const note = decision === "rouvrir" ? globalThis.prompt?.("Pourquoi rouvrir cette tâche ?") : "";
    if (decision === "rouvrir" && !note?.trim()) {
      return;
    }
    await sendImprovementChange(`/api/improvement/anomalies/${number}/closure`, { decision, note }, decision === "confirmer" ? "Clôture confirmée : l'anomalie est levée." : "Tâche rouverte : la personne en charge est prévenue.");
  }
  if (target.dataset.ruleDecision) {
    const [number, decision] = target.dataset.ruleDecision.split(":");
    const question = { refuser: "Refuser cette règle ? Elle ne sera pas appliquée.", retirer: "Retirer cette règle ? Les agents ne l'appliqueront plus." }[decision];
    if (question && !globalThis.confirm?.(question)) {
      return;
    }
    await sendImprovementChange(`/api/improvement/rules/${number}/decision`, { decision }, { valider: "Règle validée : elle s'applique dès la prochaine mission.", refuser: "Règle refusée.", retirer: "Règle retirée." }[decision]);
  }
  if (target.dataset.lift) {
    await sendImprovementChange(`/api/improvement/anomalies/${target.dataset.lift}/lift`, {}, "Anomalie levée.");
  }
  if (target.dataset.analyse) {
    const number = target.dataset.analyse;
    improvementView.busy.add(number);
    renderImprovement(improvementView.data);
    try {
      const result = await postJson(`/api/improvement/anomalies/${number}/analyse`, {});
      showToast(`${result.agent} a analysé l'anomalie n° ${number}.`);
    } catch (error) {
      showToast(error.message, "warn");
    }
    improvementView.busy.delete(number);
    await refreshImprovement();
  }
});

async function refreshImprovement() {
  try {
    const response = await fetch("/api/improvement", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger l'amélioration continue.");
    }
    renderImprovement(await response.json());
  } catch (error) {
    improvementList.innerHTML = card("Amélioration indisponible", escapeHtml(error.message), "warning");
  }
}

async function sendImprovementChange(url, body, success) {
  try {
    await postJson(url, body);
    showToast(success);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshImprovement();
}

function renderImprovement(data) {
  if (!data) {
    return;
  }
  improvementView.data = data;
  updateOverview({ improvement: data });
  const { anomalies, rules } = data;
  const proposed = rules.filter((rule) => rule.status === "proposee");
  const inForce = rules.filter((rule) => rule.status === "active");
  // An anomaly given as a task stays open until the direction confirms its closure.
  const open = anomalies.filter(isOpenAnomaly);
  const waiting = anomalies.filter((anomaly) => anomaly.status === "a_analyser");
  improvementCount.textContent = String(proposed.length);
  improvementCount.hidden = proposed.length === 0;
  if (anomalies.length === 0 && rules.length === 0) {
    improvementStats.innerHTML = "";
    improvementList.innerHTML = `
      <div class="all-clear">
        <span class="badge">${icon("bulb")}</span>
        <h3>Aucune anomalie pour le moment</h3>
        <p>Dès qu'une étape d'atelier est bloquée ou dépasse sa date prévue, elle apparaît ici et son agent en cherche la cause. Vous pouvez aussi signaler un problème au Director : « le client du BC 166 s'est plaint d'une rayure à la livraison ».</p>
      </div>
    `;
    return;
  }
  const counts = { decide: proposed.length, analyse: waiting.length, open: open.length, rules: inForce.length };
  improvementStats.innerHTML = IMPROVEMENT_FILTERS.map((entry) => `
    <button type="button" class="stat-tile ${entry.id === "decide" && counts.decide > 0 ? "is-alert" : ""}" data-filter="${entry.id}" aria-pressed="${improvementView.filter === entry.id}">
      <strong>${counts[entry.id]}</strong><span>${escapeHtml(entry.label)}</span><small>${escapeHtml(entry.hint)}</small>
    </button>
  `).join("");

  const anomalyOf = (number) => anomalies.find((anomaly) => anomaly.number === number);
  const show = (id) => improvementView.filter === null || improvementView.filter === id;
  const sections = [];
  if (show("decide") && proposed.length > 0) {
    sections.push(improvementSection("Règles à valider", "Proposées par les agents après une anomalie. Elles ne s'appliquent qu'une fois validées.", proposed.map((rule) => ruleCard(rule, anomalyOf)).join("")));
  }
  const listed = improvementView.filter === "analyse" ? waiting : open;
  if ((show("open") || show("analyse")) && listed.length > 0) {
    sections.push(improvementSection(improvementView.filter === "analyse" ? "À analyser" : "Anomalies ouvertes", "Un retard ou un blocage du carnet d'atelier, ou un problème signalé au Director.", listed.map((anomaly) => anomalyCard(anomaly, data.analysis)).join("")));
  }
  if (show("rules") && inForce.length > 0) {
    sections.push(improvementSection("Règles en vigueur", "Données à leur agent, et au Director, à chaque mission.", inForce.map((rule) => ruleCard(rule, anomalyOf)).join("")));
  }
  const past = [...anomalies.filter((anomaly) => !isOpenAnomaly(anomaly)), ...rules.filter((rule) => ["refusee", "retiree"].includes(rule.status))];
  if (improvementView.filter === null && past.length > 0) {
    sections.push(`
      <details class="panel improvement-history">
        <summary><strong>Historique</strong><small>${past.length} élément${past.length > 1 ? "s" : ""} : anomalies levées, règles refusées ou retirées</small></summary>
        <ul>${past.map((entry) => `<li><small>${escapeHtml(formatIsoDay((entry.liftedAt ?? entry.decidedAt ?? "").slice(0, 10)))}</small> ${entry.fact ? `Anomalie n° ${entry.number} levée : ${escapeHtml(entry.fact)}` : `Règle n° ${entry.number} « ${escapeHtml(entry.title)} » ${entry.status === "refusee" ? "refusée" : "retirée"}`}</li>`).join("")}</ul>
      </details>
    `);
  }
  improvementList.innerHTML = sections.length > 0 ? sections.join("") : '<p class="empty-filter">Rien dans cette catégorie.</p>';
}

function improvementSection(title, hint, body) {
  return `
    <section class="improvement-section">
      <header><h3>${escapeHtml(title)}</h3><p>${escapeHtml(hint)}</p></header>
      <div class="flex flex-col gap-3">${body}</div>
    </section>
  `;
}

function ruleCard(rule, anomalyOf) {
  const origins = (rule.anomalies ?? []).map(anomalyOf).filter(Boolean);
  const recurrences = rule.recurrences?.length ?? 0;
  return `
    <article class="rule-card" data-status="${rule.status}">
      <header>
        ${avatar(rule.owner)}
        <div class="min-w-0 flex-1">
          <span class="eyebrow">Règle n° ${rule.number} · ${escapeHtml(formatAgent(rule.owner))}</span>
          <h4>${escapeHtml(rule.title)}</h4>
        </div>
        <span class="tag ${rule.status === "active" ? "ok" : rule.status === "proposee" ? "warning" : ""}">${escapeHtml(improvementView.data.labels.rules[rule.status] ?? rule.status)}</span>
      </header>
      <dl class="rule-body">
        ${rule.trigger ? `<div><dt>Quand</dt><dd>${escapeHtml(rule.trigger)}</dd></div>` : ""}
        <div><dt>Action</dt><dd>${escapeHtml(rule.action)}</dd></div>
        ${origins.map((anomaly) => `<div><dt>Né de</dt><dd>Anomalie n° ${anomaly.number} : ${escapeHtml(anomaly.fact)}${anomaly.cause ? ` — <em>cause : ${escapeHtml(anomaly.cause)}</em>` : ""}</dd></div>`).join("")}
      </dl>
      ${recurrences > 0 ? `<p class="rule-warning">${icon("alert")}Revenue ${recurrences} fois malgré cette règle : à renforcer.</p>` : ""}
      ${rule.status === "proposee" ? `
        <div class="doc-actions">
          <button type="button" class="primary" data-rule-decision="${rule.number}:valider">${icon("check")}Valider la règle</button>
          <button type="button" class="secondary" data-rule-decision="${rule.number}:refuser">${icon("x")}Refuser</button>
        </div>` : ""}
      ${rule.status === "active" ? `<div class="doc-actions"><button type="button" class="link-button" data-rule-decision="${rule.number}:retirer">Retirer la règle</button></div>` : ""}
    </article>
  `;
}

function isOpenAnomaly(anomaly) {
  return anomaly.task ? anomaly.task.status !== "cloturee" : anomaly.status !== "levee";
}

function anomalyCard(anomaly, canAnalyse) {
  const busy = improvementView.busy.has(String(anomaly.number));
  const severity = anomaly.severity ?? "moyenne";
  return `
    <article class="anomaly-card" data-kind="${escapeHtml(anomaly.kind)}">
      <span class="anomaly-icon" aria-hidden="true">${icon(anomaly.kind === "retard" ? "clock" : anomaly.kind === "blocage" ? "alert" : "bulb")}</span>
      <div class="min-w-0 flex-1">
        <span class="eyebrow">Anomalie n° ${anomaly.number} · ${escapeHtml(anomaly.kind)} · le ${escapeHtml(formatIsoDay(anomaly.detectedAt.slice(0, 10)))} <span class="tag ${severity === "haute" ? "warning" : ""}">gravité ${escapeHtml(severity)}</span></span>
        <p class="anomaly-fact">${escapeHtml(anomaly.fact)}</p>
        ${anomaly.cause
          ? `<p class="anomaly-cause"><b>Cause</b> (${escapeHtml(formatAgent(anomaly.analysedBy))}) : ${escapeHtml(anomaly.cause)}${anomaly.rule ? ` · règle n° ${anomaly.rule}` : ""}</p>`
          : `<p class="anomaly-cause muted">${busy ? "Analyse en cours…" : `En attente de l'analyse de ${escapeHtml(formatAgent(anomaly.owner))}.`}</p>`}
        ${taskBlock(anomaly)}
      </div>
      <div class="anomaly-actions">
        ${anomaly.status === "a_analyser" && canAnalyse ? `<button type="button" class="secondary ${busy ? "is-loading" : ""}" data-analyse="${anomaly.number}" ${busy ? "disabled" : ""}>${icon("sparkles")}${busy ? "Analyse…" : "Analyser maintenant"}</button>` : ""}
        ${anomaly.task?.status === "ouverte" ? `<button type="button" class="secondary" data-task-move="${anomaly.number}:prise_en_charge">Prise en charge</button>` : ""}
        ${["ouverte", "prise_en_charge"].includes(anomaly.task?.status) ? `<button type="button" class="secondary" data-task-move="${anomaly.number}:resolue">${icon("check")}Marquer résolue</button>` : ""}
        ${anomaly.task?.status === "resolue" ? `
          <button type="button" class="primary" data-closure="${anomaly.number}:confirmer">${icon("check")}Confirmer la clôture</button>
          <button type="button" class="link-button" data-closure="${anomaly.number}:rouvrir">Rouvrir</button>` : ""}
        ${anomaly.source === "signalee" && !anomaly.task ? `<button type="button" class="link-button" data-lift="${anomaly.number}">Marquer réglée</button>` : ""}
      </div>
    </article>
  `;
}

// Who carries the task, until when, where it stands; and the form that gives
// it (or gives it again) to a trade and a person.
function taskBlock(anomaly) {
  const { task } = anomaly;
  const labels = improvementView.data.labels;
  const late = task && ["ouverte", "prise_en_charge"].includes(task.status) && task.dueDate < new Date().toISOString().slice(0, 10);
  const line = task ? `
    <p class="anomaly-task ${late ? "is-late" : ""}">
      <b>Tâche</b> confiée à ${escapeHtml(task.person || formatAgent(task.agent))} (${escapeHtml(formatAgent(task.agent))}) · avant le ${escapeHtml(formatIsoDay(task.dueDate))}${late ? " · en retard" : ""} · <em>${escapeHtml(labels.tasks?.[task.status] ?? task.status)}</em>
      ${task.instruction ? `<br>${escapeHtml(task.instruction)}` : ""}
      ${task.resolution ? `<br>Fait : ${escapeHtml(task.resolution)}` : ""}
    </p>` : '<p class="anomaly-task muted">Sans responsable : confiez-la à un métier.</p>';
  if (task && !["ouverte", "prise_en_charge"].includes(task.status)) {
    return line;
  }
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  return `${line}
    <details class="task-assign">
      <summary>${task ? "Confier à quelqu'un d'autre" : "Assigner la tâche"}</summary>
      <form data-assign-form="${anomaly.number}">
        <label>Métier<select name="agent">${(labels.owners ?? []).map((id) => option(id, formatAgent(id), id === (task?.agent ?? anomaly.owner))).join("")}</select></label>
        <label>Personne<input name="person" placeholder="celle reliée au métier" value="${escapeHtml(task?.person ?? "")}"></label>
        <label>WhatsApp<input name="phone" inputmode="tel" placeholder="06 12 34 56 78" value="${escapeHtml(task?.phone ?? "")}"></label>
        <label>Échéance<input name="dueDate" type="date" required value="${escapeHtml(task?.dueDate ?? "")}"></label>
        <label>Gravité<select name="severity">${Object.entries(labels.severities ?? {}).map(([id, label]) => option(id, label, id === (anomaly.severity ?? "moyenne"))).join("")}</select></label>
        <label class="wide">Consigne<input name="instruction" placeholder="ce qu'il faut faire (facultatif)" value="${escapeHtml(task?.instruction ?? "")}"></label>
        <button type="submit" class="primary">${icon("check")}Confier</button>
      </form>
    </details>`;
}

// --- Team view ------------------------------------------------------------------
// Each agent with the person it answers to, the missions it carries, the rules
// it applies and what it did lately; beside it, the whole team's feed.
const ACTIVITY_LABELS = Object.freeze({ mission: "Mission", caisse: "Caisse", atelier: "Atelier", document: "Document", amelioration: "Amélioration", equipe: "Équipe", compte_rendu: "Compte rendu" });
const teamFeed = document.querySelector("#team-feed");
const teamView = { data: null, responded: new Set() };
document.querySelector("#refresh-team").addEventListener("click", () => refreshTeam());
agentRoster.addEventListener("submit", async (event) => {
  const formNode = event.target.closest?.("[data-member-form]");
  if (!formNode) {
    return;
  }
  event.preventDefault();
  const read = (name) => formNode.querySelector(`[name='${name}']`)?.value ?? "";
  await saveMember(formNode.dataset.memberForm, { name: read("name"), role: read("role"), phone: read("phone") });
});
agentRoster.addEventListener("click", async (event) => {
  const unlink = event.target.closest?.("[data-member-unlink]");
  if (unlink && globalThis.confirm?.("Défaire le lien entre cet agent et cette personne ?")) {
    await saveMember(unlink.dataset.memberUnlink, { name: "", role: "", phone: "" });
  }
  const send = event.target.closest?.("[data-send-missions]");
  const agent = send ? teamView.data?.agents?.find((entry) => entry.id === send.dataset.sendMissions) : null;
  if (agent?.member?.phone) {
    const message = missionMessage(agent);
    if (whatsAppView.configured) {
      send.disabled = true;
      await sendWhatsApp({ to: agent.member.phone, message, recipient: agent.member.name, kind: "tache_equipe" });
      send.disabled = false;
    } else {
      globalThis.open?.(`https://wa.me/${agent.member.phone}?text=${encodeURIComponent(message)}`, "_blank", "noopener");
    }
  }
});

function missionMessage(agent) {
  const missionsText = agent.missions.map((mission) => `• ${mission.task}${mission.dueDate ? ` (avant le ${formatIsoDay(mission.dueDate)})` : ""}`).join("\n");
  return `Bonjour ${agent.member.name},\n\nVoici vos tâches H-KIDS (${agent.label}) :\n${missionsText}\n\nMerci de me dire où vous en êtes.\nL'équipe H-KIDS`;
}

async function refreshTeam() {
  try {
    const response = await fetch("/api/team", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger l'équipe.");
    }
    teamView.data = await response.json();
    renderTeam();
  } catch (error) {
    teamFeed.innerHTML = `<li class="muted">${escapeHtml(error.message)}</li>`;
  }
}

async function saveMember(agentId, member) {
  try {
    const response = await fetch(`/api/team/${encodeURIComponent(agentId)}/member`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(member)
    });
    if (!response.ok) {
      throw new Error((await response.json()).error ?? "Le lien n'a pas été enregistré.");
    }
    showToast(member.name ? `${formatAgent(agentId)} est relié à ${member.name}.` : "Lien défait.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshTeam();
}

// The agents who answered the last request are marked; the cards come from the
// server once loaded, from the roster before that.
function renderAgentRoster(activeAgents) {
  teamView.responded = new Set(activeAgents);
  renderTeam();
}

function renderTeam() {
  const agents = teamView.data?.agents ?? AGENT_ROSTER.filter((agent) => agent.id !== "director").map((agent) => ({ id: agent.id, label: formatAgent(agent.id), mission: agent.role, member: null, missions: [], rules: [], activity: [] }));
  agentRoster.innerHTML = agents.map((agent) => teamCard(agent)).join("");
  const feed = teamView.data?.activity ?? [];
  teamFeed.innerHTML = feed.length > 0
    ? feed.map((entry) => feedLine(entry)).join("")
    : '<li class="muted text-[13px]">Rien encore. Chaque mission, mouvement de caisse ou étape d\'atelier s\'inscrira ici.</li>';
}

function teamCard(agent) {
  const roster = AGENT_ROSTER.find((entry) => entry.id === agent.id);
  const member = agent.member;
  const canSend = Boolean(member?.phone) && agent.missions.length > 0;
  return `
    <article class="team-card ${teamView.responded.has(agent.id) ? "has-responded" : ""}">
      <header>
        ${avatar(agent.id, "lg")}
        <div class="min-w-0 flex-1">
          <h3>${escapeHtml(agent.label)}</h3>
          <p>${escapeHtml(agent.mission)}</p>
          ${roster?.parent ? `<small class="muted">↳ sous ${escapeHtml(roster.parent)}</small>` : ""}
        </div>
        ${teamView.responded.has(agent.id) ? '<span class="tag ok">a répondu</span>' : ""}
      </header>
      <div class="team-member ${member ? "" : "is-empty"}">
        ${icon("user-check")}
        <div class="min-w-0 flex-1">
          ${member
            ? `<strong>${escapeHtml(member.name)}</strong><small>${escapeHtml([member.role, member.phone ? `+${member.phone}` : "numéro à renseigner"].filter(Boolean).join(" · "))}</small>`
            : "<strong>Aucun responsable relié</strong><small>Dites au Director : « Youssef, le chef d'atelier, s'occupe de la production »</small>"}
        </div>
        <details class="team-edit">
          <summary>${member ? "Modifier" : "Relier"}</summary>
          <form data-member-form="${escapeHtml(agent.id)}" class="team-edit-form">
            <label>Nom<input name="name" value="${escapeHtml(member?.name ?? "")}" required></label>
            <label>Fonction<input name="role" value="${escapeHtml(member?.role ?? "")}" placeholder="chef d'atelier"></label>
            <label>WhatsApp<input name="phone" value="${escapeHtml(member?.phone ? `+${member.phone}` : "")}" placeholder="06 12 34 56 78" inputmode="tel"></label>
            <div class="flex flex-wrap gap-2">
              <button type="submit" class="primary">${icon("check")}Enregistrer</button>
              ${member ? `<button type="button" class="link-button" data-member-unlink="${escapeHtml(agent.id)}">Défaire le lien</button>` : ""}
            </div>
          </form>
        </details>
      </div>
      ${agent.missions.length > 0 ? `
        <div class="team-block">
          <h4>Missions en cours <span class="tag info">${agent.missions.length}</span></h4>
          <ul>${agent.missions.map((mission) => `<li><span>${escapeHtml(mission.task)}</span><small>Plan n° ${mission.plan}${mission.dueDate ? ` · avant le <span class="${mission.overdue ? "late" : ""}">${escapeHtml(formatIsoDay(mission.dueDate))}</span>` : ""}</small></li>`).join("")}</ul>
          ${canSend ? `<button type="button" class="whatsapp-button" data-send-missions="${escapeHtml(agent.id)}">${icon("send")}Envoyer ses tâches à ${escapeHtml(member.name)}</button>` : ""}
        </div>` : ""}
      ${agent.rules.length > 0 ? `
        <div class="team-block">
          <h4>Règles appliquées <span class="tag ok">${agent.rules.length}</span></h4>
          <ul>${agent.rules.map((rule) => `<li><span>${escapeHtml(rule.title)}</span><small>${escapeHtml(rule.action)}</small></li>`).join("")}</ul>
        </div>` : ""}
      ${agent.activity.length > 0 ? `
        <div class="team-block">
          <h4>Dernière activité</h4>
          <ul>${agent.activity.slice(0, 3).map((entry) => `<li><span>${escapeHtml(entry.text)}</span><small>${escapeHtml(formatStamp(entry.at))} · ${escapeHtml(ACTIVITY_LABELS[entry.kind] ?? entry.kind)}</small></li>`).join("")}</ul>
        </div>` : ""}
    </article>
  `;
}

function feedLine(entry) {
  return `
    <li class="feed-line" data-kind="${escapeHtml(entry.kind)}">
      ${avatar(entry.agent)}
      <div class="min-w-0 flex-1">
        <small>${escapeHtml(formatAgent(entry.agent))} · ${escapeHtml(ACTIVITY_LABELS[entry.kind] ?? entry.kind)} · ${escapeHtml(formatStamp(entry.at))}</small>
        <p>${escapeHtml(entry.text)}</p>
        ${entry.detail ? `<details><summary>Réponse</summary><div class="answer-text">${formatAgentText(entry.detail)}</div></details>` : ""}
      </div>
    </li>
  `;
}

function formatStamp(iso) {
  const date = new Date(iso);
  const sameDay = localIsoDay(date) === localIsoDay();
  return sameDay
    ? `aujourd'hui ${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date)}`
    : new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

// --- WhatsApp Business view ---------------------------------------------------
// The company's number: what came in, what left, and a reply box per person.
// Without the WHATSAPP_* keys the view says what is missing, and messages keep
// leaving by opening WhatsApp on the phone.
const WHATSAPP_SENDERS = Object.freeze({ direction: "Direction", equipe: "Équipe", contact: "Client ou contact" });
const WHATSAPP_TYPES = Object.freeze({ image: "photo", audio: "message vocal", video: "vidéo", document: "document", sticker: "autocollant", location: "position" });
const whatsAppStatus = document.querySelector("#whatsapp-status");
const whatsAppThreads = document.querySelector("#whatsapp-threads");
const whatsAppCount = document.querySelector("#whatsapp-count");
const whatsAppView = { configured: false, data: null };
document.querySelector("#refresh-whatsapp").addEventListener("click", () => refreshWhatsApp());
whatsAppThreads.addEventListener("submit", async (event) => {
  const formNode = event.target.closest?.("[data-wa-reply]");
  if (!formNode) {
    return;
  }
  event.preventDefault();
  const field = formNode.querySelector("textarea");
  const button = formNode.querySelector("button");
  button.disabled = true;
  const sent = await sendWhatsApp({ to: formNode.dataset.waReply, message: field.value, recipient: formNode.dataset.waName ?? "", kind: "reponse" });
  button.disabled = false;
  if (sent.ok) {
    field.value = "";
    await refreshWhatsApp();
  }
});

async function refreshWhatsApp() {
  try {
    const response = await fetch("/api/whatsapp", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger les messages WhatsApp.");
    }
    whatsAppView.data = await response.json();
    whatsAppView.configured = whatsAppView.data.configured === true;
    renderWhatsApp();
  } catch (error) {
    whatsAppThreads.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

// Sends from the company's number; the toast says what happened.
async function sendWhatsApp({ to, message, recipient = "", kind = "autre" }) {
  try {
    const response = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ to, message, recipient, kind })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(body.error ?? "Le message n'est pas parti.", "warn");
      return { ok: false, code: body.details?.code ?? null };
    }
    showToast(`Message envoyé${recipient ? ` à ${recipient}` : ""} depuis le numéro H-KIDS.`);
    return { ok: true };
  } catch (error) {
    showToast(error.message, "warn");
    return { ok: false, code: null };
  }
}

function renderWhatsApp() {
  const data = whatsAppView.data;
  const callbackUrl = `${globalThis.location?.origin ?? ""}${data.callbackPath}`;
  whatsAppStatus.innerHTML = data.configured
    ? `<div class="wa-banner is-on">${icon("check-circle")}<div><strong>Numéro H-KIDS connecté</strong><small>${data.owners > 0 ? `${data.owners} numéro(s) de la direction parlent au Director par WhatsApp.` : "Aucun numéro de la direction : ajoutez WHATSAPP_OWNER_NUMBERS dans .env pour parler au Director par WhatsApp."} URL de rappel à donner à Meta : <code>${escapeHtml(callbackUrl)}</code></small></div></div>`
    : `<div class="wa-banner">${icon("alert")}<div><strong>WhatsApp Business n'est pas encore branché</strong><small>Les messages partent pour l'instant en ouvrant WhatsApp sur votre téléphone. Pour envoyer et recevoir depuis le numéro H-KIDS, complétez .env : ${data.missing.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}. La marche à suivre est dans le README.</small></div></div>`;

  // Newest first from the server: the first message of each number is its latest.
  const threads = new Map();
  for (const message of data.messages) {
    threads.set(message.number, [...(threads.get(message.number) ?? []), message]);
  }
  const awaiting = [...threads.values()].filter((messages) => messages[0].direction === "in" && messages[0].sender === "contact").length;
  whatsAppCount.textContent = String(awaiting);
  whatsAppCount.hidden = awaiting === 0;
  whatsAppThreads.innerHTML = threads.size > 0
    ? [...threads.entries()].map(([number, messages]) => whatsAppThread(number, messages)).join("")
    : `<p class="empty-state">Aucun message pour l'instant.${data.configured ? " Les messages écrits au numéro H-KIDS apparaîtront ici." : ""}</p>`;
}

function whatsAppThread(number, messages) {
  const received = messages.find((message) => message.direction === "in");
  const sender = received?.sender ?? "contact";
  const name = messages.find((message) => message.name)?.name ?? "";
  const awaiting = messages[0].direction === "in" && sender === "contact";
  return `
    <article class="wa-thread" data-sender="${escapeHtml(sender)}">
      <header>
        <span class="wa-initial" aria-hidden="true">${escapeHtml((name || "+").slice(0, 1).toUpperCase())}</span>
        <div class="min-w-0 flex-1">
          <strong>${escapeHtml(name || `+${number}`)}</strong>
          <small>+${escapeHtml(number)} · ${escapeHtml(WHATSAPP_SENDERS[sender] ?? sender)}${received?.agent ? ` · ${escapeHtml(formatAgent(received.agent))}` : ""}</small>
        </div>
        ${awaiting ? '<span class="tag warning">à répondre</span>' : ""}
      </header>
      <ol class="wa-messages">
        ${messages.slice(0, 8).reverse().map((message) => `
          <li class="wa-msg ${message.direction === "in" ? "is-in" : "is-out"} ${message.status === "failed" ? "is-failed" : ""}">
            <p>${message.text ? escapeHtml(message.text) : `<em>(${escapeHtml(WHATSAPP_TYPES[message.type] ?? "message")} sans texte)</em>`}</p>
            <small>${escapeHtml(formatStamp(message.at))}${message.transcribed ? " · vocal transcrit" : ""}${message.direction === "out" ? ` · ${escapeHtml(message.by === "director" ? "Director" : message.by ?? "")}` : ""}${message.status === "failed" ? ` · non parti : ${escapeHtml(message.error ?? "")}` : ""}</small>
          </li>`).join("")}
      </ol>
      ${whatsAppView.configured ? `
        <form class="wa-reply" data-wa-reply="${escapeHtml(number)}" data-wa-name="${escapeHtml(name)}">
          <textarea rows="2" placeholder="Votre réponse…" required aria-label="Réponse à ${escapeHtml(name || `+${number}`)}"></textarea>
          <button type="submit" class="primary">${icon("send")}Répondre</button>
        </form>` : ""}
    </article>
  `;
}

// --- Workshop book view -------------------------------------------------------
const WORKSHOP_STATUS_OPTIONS = Object.freeze({ a_faire: "À faire", en_cours: "En cours", bloquee: "Bloquée", terminee: "Terminée" });
// The plan's step styles, reused: same colours for the same meaning.
const WORKSHOP_STEP_CLASSES = Object.freeze({ a_faire: "todo", en_cours: "in_progress", bloquee: "blocked", terminee: "done" });
const ORDER_STATUS_TONES = Object.freeze({ "livrée et installée": "ok", "bloquée": "danger", "en retard": "danger", "en cours": "info" });
// Who answers for an order, as the design office panel asks for them.
const ORDER_ROLE_FIELDS = Object.freeze([
  ["lead", "Chef de charge", "contrôle la commande de bout en bout"],
  ["leadPhone", "WhatsApp du chef de charge", "il y reçoit les alertes"],
  ["architect", "Architecte du client", "nom, cabinet"],
  ["architectPhone", "Téléphone de l'architecte", "06 12 34 56 78"],
  ["liaison", "En lien avec l'architecte", "qui, dans l'équipe"],
  ["drafter", "Dessinateur", "fait le G-code"],
  ["drafterPhone", "WhatsApp du dessinateur", "il y envoie ses fichiers"]
]);
const CNC_STATUS_TAGS = Object.freeze({ a_valider: ["warning", "à valider"], valide: ["ok", "validé"], refuse: ["danger", "refusé"] });
const CNC_ACCEPT = ".nc,.gcode,.ngc,.tap,.cnc,.gc,.iso,.dxf";
// The filters above the book: each says how many orders it holds.
const ORDER_FILTERS = Object.freeze([
  { id: "all", label: "Toutes", hint: "au carnet", test: () => true },
  { id: "watch", label: "À surveiller", hint: "bloquées, en retard ou à facturer", test: (order) => order.alerts.length > 0 },
  { id: "active", label: "En atelier", hint: "pas encore installées", test: (order) => !order.finished },
  { id: "todo", label: "À lancer", hint: "aucune étape commencée", test: (order) => order.status === "à lancer" },
  { id: "done", label: "Installées", hint: "livrées et installées", test: (order) => order.finished }
]);
const ordersList = document.querySelector("#orders-list");
const ordersCount = document.querySelector("#orders-count");
const ordersFilters = document.querySelector("#orders-filters");
// What the book shows: the orders last read, the filter chosen, and the
// sections of each card left open, kept across refreshes.
const workshopView = { orders: [], filter: "all", open: new Set() };
document.querySelector("#refresh-orders").addEventListener("click", () => refreshOrders());
ordersFilters.addEventListener("click", (event) => {
  const tile = event.target.closest?.("[data-filter]");
  if (tile) {
    workshopView.filter = tile.dataset.filter;
    renderOrders(workshopView.orders);
  }
});

async function refreshOrders() {
  try {
    const response = await fetch("/api/workshop", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger le carnet d'atelier.");
    }
    renderOrders((await response.json()).orders ?? []);
  } catch (error) {
    ordersList.innerHTML = card("Carnet indisponible", escapeHtml(error.message), "warning");
  }
}

function renderOrders(orders) {
  workshopView.orders = orders;
  const flagged = orders.filter((order) => order.alerts.length > 0).length;
  ordersCount.textContent = String(flagged);
  ordersCount.hidden = flagged === 0;
  updateOverview({ orders });
  if (orders.length === 0) {
    ordersFilters.innerHTML = "";
    ordersList.innerHTML = `
      <div class="all-clear">
        <span class="badge">${icon("wrench")}</span>
        <h3>Aucune commande au carnet</h3>
        <p>Un bon de commande entre au carnet dès que vous le validez. Demandez au Director « Le client a accepté le devis 170 » : le Commercial prépare le bon de commande.</p>
      </div>
    `;
    return;
  }
  const filter = ORDER_FILTERS.find((entry) => entry.id === workshopView.filter) ?? ORDER_FILTERS[0];
  ordersFilters.innerHTML = ORDER_FILTERS.map((entry) => {
    const count = orders.filter(entry.test).length;
    return `
      <button type="button" class="stat-tile ${entry.id === "watch" && count > 0 ? "is-alert" : ""}" data-filter="${entry.id}" aria-pressed="${entry.id === filter.id}">
        <strong>${count}</strong><span>${escapeHtml(entry.label)}</span><small>${escapeHtml(entry.hint)}</small>
      </button>
    `;
  }).join("");
  const shown = orders.filter(filter.test);
  ordersList.innerHTML = shown.length > 0
    ? shown.map((order) => orderCard(order)).join("")
    : `<p class="empty-filter">Aucune commande dans « ${escapeHtml(filter.label)} ».</p>`;

  ordersList.querySelectorAll("[data-order]").forEach((article) => {
    article.querySelectorAll("details[data-panel]").forEach((panel) => {
      panel.addEventListener("toggle", () => {
        const key = `${article.dataset.order}:${panel.dataset.panel}`;
        if (panel.open) {
          workshopView.open.add(key);
        } else {
          workshopView.open.delete(key);
        }
      });
    });
    article.querySelectorAll("select[data-step]").forEach((select) => {
      select.addEventListener("change", async () => {
        // A blocked step says what blocks it, as the Director would ask.
        const note = select.value === "bloquee" ? globalThis.prompt?.("Qu'est-ce qui bloque cette étape ?") ?? "" : "";
        if (select.value === "bloquee" && note.trim() === "") {
          await refreshOrders();
          return;
        }
        await sendOrderChange(article.dataset.order, select.dataset.step, { status: select.value, note });
      });
    });
    const number = article.dataset.order;
    article.querySelector("[data-portal-open]")?.addEventListener("click", async () => {
      const link = await sendPortalChange(number, "ouvrir");
      if (link) {
        await copyLink(link.url);
      }
    });
    article.querySelector("[data-portal-copy]")?.addEventListener("click", (event) => copyLink(new URL(event.currentTarget.dataset.portalCopy, location.origin).href));
    article.querySelector("[data-portal-close]")?.addEventListener("click", async () => {
      if (globalThis.confirm?.("Couper ce lien ? Le client ne pourra plus l'ouvrir ; un nouveau lien pourra être créé.")) {
        await sendPortalChange(number, "fermer");
      }
    });
    article.querySelector("[data-team-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const roles = Object.fromEntries(ORDER_ROLE_FIELDS.map(([id]) => [id, event.currentTarget.elements[id]?.value ?? ""]));
      await sendOrderTeam(number, roles);
    });
    const cncField = article.querySelector("[data-cnc-input]");
    cncField?.addEventListener("change", async () => {
      const file = cncField.files?.[0];
      if (file) {
        await depositCncFile(number, file);
      }
    });
    article.querySelectorAll("[data-cnc-download]").forEach((button) => {
      button.addEventListener("click", () => downloadCncFile(number, button.dataset.cncDownload, button.dataset.cncName));
    });
    article.querySelectorAll("[data-cnc-decide]").forEach((button) => {
      button.addEventListener("click", async () => {
        const approve = button.dataset.cncDecide === "valider";
        const reason = approve ? "" : globalThis.prompt?.("Pourquoi ce fichier est-il refusé ? Le dessinateur le lira pour le corriger.") ?? "";
        if (approve ? !globalThis.confirm?.("Valider ce fichier pour la machine CNC ? La découpe pourra commencer avec lui.") : reason.trim() === "") {
          return;
        }
        await decideCncFile(number, button.dataset.cncId, approve ? "valider" : "refuser", reason);
      });
    });
    const photoField = article.querySelector("[data-photo-input]");
    photoField?.addEventListener("change", async () => {
      const file = photoField.files?.[0];
      if (file) {
        await publishOrderPhoto(number, file);
      }
    });
    article.querySelectorAll("[data-photo-remove]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (globalThis.confirm?.("Retirer cette photo du suivi client ?")) {
          await removeOrderPhoto(number, button.dataset.photoRemove);
        }
      });
    });
  });
}

// One order of the book: who and what, the route of its steps, what
// needs attention, then three sections that open on demand.
function orderCard(order) {
  const current = order.steps.findIndex((step) => step.status !== "terminee");
  const { done, total, percent } = order.progress;
  const where = order.finished
    ? "livrée et installée"
    : `${current >= 0 && order.steps[current].status === "a_faire" ? "étape suivante" : "étape en cours"} : <b>${escapeHtml(order.currentStep)}</b>`;
  return `
    <article class="order-card ${order.finished ? "is-done" : ""} ${order.alerts.length > 0 ? "is-flagged" : ""}" data-order="${escapeHtml(order.number)}">
      <header class="order-head">
        <div class="min-w-0">
          <span class="eyebrow">BC n° ${escapeHtml(order.number)} · du ${escapeHtml(order.date)}${order.quoteNumber ? ` · devis n° ${escapeHtml(order.quoteNumber)}` : ""}</span>
          <h3>${escapeHtml(order.client)}</h3>
          ${order.object ? `<p class="order-object">${escapeHtml(order.object)}</p>` : ""}
        </div>
        <div class="order-figures">
          <span class="tag ${ORDER_STATUS_TONES[order.status] ?? ""}">${escapeHtml(order.status)}</span>
          <strong>${escapeHtml(formatDh(order.totalTtc))} <small>TTC</small></strong>
          ${orderDocuments(order) ? `<small>${escapeHtml(orderDocuments(order))}</small>` : ""}
        </div>
      </header>
      <ol class="order-route" aria-label="${done} étape${done > 1 ? "s" : ""} terminée${done > 1 ? "s" : ""} sur ${total}">
        ${order.steps.map((step, index) => routeStep(step, index, index === current)).join("")}
      </ol>
      <p class="order-progress">${done}/${total} étapes terminées · ${percent} % · ${where}${order.finished ? "" : ` · ${order.team.lead ? `chef de charge : <b>${escapeHtml(order.team.lead)}</b>` : `<span class="late">chef de charge à désigner</span>`}`}</p>
      ${order.alerts.length > 0 ? `
        <ul class="order-alerts">
          ${order.alerts.map((alert) => `<li class="${alert.startsWith("Installée") ? "warn" : ""}">${icon("alert")}<span>${escapeHtml(alert)}</span></li>`).join("")}
        </ul>` : ""}
      <div class="order-panels">
        ${orderPanel(order, "steps", `${icon("wrench")}<span>Étapes de fabrication</span><small>mettre à jour</small>`, `
          <ul class="track-steps">
            ${order.steps.map((step, index) => `
              <li class="${WORKSHOP_STEP_CLASSES[step.status] ?? ""}">
                <span class="step-index">${index + 1}</span>
                <div>
                  <strong>${escapeHtml(step.label)}</strong>
                  <small>${escapeHtml(step.detail)}${step.responsible ? ` · ${escapeHtml(step.responsible)}` : ""}${step.plannedDate ? ` · prévue le <span class="${step.late ? "late" : ""}">${escapeHtml(formatIsoDay(step.plannedDate))}</span>` : ""}${step.doneDate ? ` · terminée le ${escapeHtml(formatIsoDay(step.doneDate))}` : ""}</small>
                  ${step.note ? `<small class="block">${escapeHtml(step.note)}</small>` : ""}
                </div>
                <select data-step="${escapeHtml(step.id)}" aria-label="Statut : ${escapeHtml(step.label)}">
                  ${Object.entries(WORKSHOP_STATUS_OPTIONS).map(([value, label]) => `<option value="${value}" ${value === step.status ? "selected" : ""}>${label}</option>`).join("")}
                </select>
              </li>
            `).join("")}
          </ul>
        `)}
        ${designOffice(order)}
        ${clientAccess(order)}
        ${order.journal.length > 0 ? orderPanel(order, "journal", `${icon("history")}<span>Journal</span><small>${order.journal.length} entrée${order.journal.length > 1 ? "s" : ""}</small>`, `
          <ul class="order-journal">${[...order.journal].reverse().map((entry) => `<li><small>${escapeHtml(formatIsoDay(entry.at.slice(0, 10)))} ${escapeHtml(entry.at.slice(11, 16))}</small> ${escapeHtml(entry.text)}</li>`).join("")}</ul>
        `) : ""}
      </div>
    </article>
  `;
}

// A step of the route: a dot that says its state, and its name under it.
function routeStep(step, index, isCurrent) {
  const state = step.status === "terminee" ? "done"
    : step.status === "bloquee" ? "blocked"
      : step.late ? "late"
        : step.status === "en_cours" ? "active"
          : "todo";
  const when = step.doneDate ? ` le ${formatIsoDay(step.doneDate)}` : step.plannedDate ? `, prévue le ${formatIsoDay(step.plannedDate)}` : "";
  const status = `${WORKSHOP_STATUS_OPTIONS[step.status] ?? step.status}${when}`;
  return `
    <li class="route-step ${state} ${isCurrent ? "is-current" : ""}" title="${escapeHtml(`${step.label} : ${status.toLowerCase()}`)}">
      <span class="route-dot" aria-hidden="true">${state === "done" ? icon("check") : state === "blocked" ? "!" : index + 1}</span>
      <span class="route-label">${escapeHtml(step.label)}</span>
      <span class="visually-hidden">${escapeHtml(`${step.label} : ${status.toLowerCase()}`)}</span>
    </li>
  `;
}

// A section of an order card that opens on demand and stays open across
// refreshes.
function orderPanel(order, id, summary, content) {
  const open = workshopView.open.has(`${order.number}:${id}`);
  return `
    <details class="order-panel" data-panel="${id}" ${open ? "open" : ""}>
      <summary>${summary}</summary>
      <div class="order-panel-body">${content}</div>
    </details>
  `;
}

// The design office of an order: who answers for it, and the machine files
// of the draughtsman, which reach the CNC only once the direction validated
// them. Never shown to the client.
function designOffice(order) {
  const waiting = order.cnc.filter((file) => file.status === "a_valider").length;
  const studyDone = order.steps.find((step) => step.id === "etude_technique")?.status === "terminee";
  const summary = order.team.lead ? `chef de charge : ${escapeHtml(order.team.lead)}` : "chef de charge à désigner";
  return orderPanel(order, "bureau", `${icon("users")}<span>Bureau d'études</span>${waiting > 0 ? `<span class="tag warning">${waiting} fichier${waiting > 1 ? "s" : ""} CNC à valider</span>` : ""}<small>${summary}</small>`, `
    <div class="design-office">
      <form class="order-team" data-team-form>
        ${ORDER_ROLE_FIELDS.map(([id, label, hint]) => `
          <label><span>${escapeHtml(label)}</span><input name="${id}" value="${escapeHtml(order.team[id] ?? "")}" placeholder="${escapeHtml(hint)}" autocomplete="off"></label>`).join("")}
        <button type="submit" class="secondary">${icon("user-check")}Enregistrer</button>
      </form>
      <div class="cnc-files">
        <p>${studyDone
          ? "Le dessinateur dépose ici le G-code (ou le DXF) fait d'après la fiche technique, ou l'envoie au numéro WhatsApp de l'entreprise avec « BC ${escapeHtml(order.number)} » en légende. La découpe CNC ne commence qu'une fois le fichier validé par la direction."
          : "Après la fiche technique (étude technique terminée), le dessinateur dépose ici le G-code ou le DXF. La découpe CNC attend sa validation."}</p>
        <ul>
          ${order.cnc.map((file) => {
            const [tone, label] = CNC_STATUS_TAGS[file.status] ?? ["", file.status];
            return `
            <li>
              <span class="cnc-icon">${icon("file")}</span>
              <div>
                <strong>${escapeHtml(file.name)}</strong> <span class="tag ${tone}">${escapeHtml(label)}</span>
                <small>${file.format === "gcode" ? "G-code" : "DXF"} · ${escapeHtml(formatBytes(file.size))} · déposé le ${escapeHtml(formatIsoDay(file.depositedAt.slice(0, 10)))}${file.decidedBy ? ` · ${escapeHtml(label)} par ${escapeHtml(file.decidedBy)}` : ""}</small>
                ${file.note ? `<small>${escapeHtml(file.note)}</small>` : ""}
                ${file.reason ? `<small class="block">Refusé : ${escapeHtml(file.reason)}</small>` : ""}
              </div>
              <div class="cnc-actions">
                <button type="button" class="link-button" data-cnc-download="${escapeHtml(file.id)}" data-cnc-name="${escapeHtml(file.name)}">Télécharger</button>
                ${file.status === "a_valider" ? `
                  <button type="button" class="secondary" data-cnc-decide="valider" data-cnc-id="${escapeHtml(file.id)}">${icon("check")}Valider</button>
                  <button type="button" class="link-button" data-cnc-decide="refuser" data-cnc-id="${escapeHtml(file.id)}">Refuser</button>` : ""}
              </div>
            </li>`;
          }).join("")}
          <li class="cnc-add">
            <label>${icon("plus")} Déposer le G-code ou le DXF<input type="file" accept="${CNC_ACCEPT}" data-cnc-input class="visually-hidden" ${studyDone ? "" : "disabled"}></label>
          </li>
        </ul>
      </div>
    </div>
  `);
}

function formatBytes(size) {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(size / 1024))} Ko`;
}

async function sendOrderTeam(number, roles) {
  try {
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/team`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(roles)
    });
    if (!response.ok) {
      throw new Error((await response.json()).error ?? "L'équipe de la commande n'a pas pu être enregistrée.");
    }
    showToast(`Équipe du BC n° ${number} enregistrée.`);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

async function depositCncFile(number, file) {
  const note = globalThis.prompt?.("Une précision pour la direction (facultative), par exemple « panneaux du lit, MDF 18 mm » :", "");
  if (note === null) {
    await refreshOrders();
    return;
  }
  try {
    await postJson(`/api/workshop/${encodeURIComponent(number)}/cnc`, { name: file.name, content: await readAsDataUrl(file), note: note ?? "" });
    showToast("Fichier CNC déposé : il attend la validation de la direction.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

async function decideCncFile(number, id, decision, reason) {
  try {
    await postJson(`/api/workshop/${encodeURIComponent(number)}/cnc/${encodeURIComponent(id)}/decision`, { decision, reason });
    showToast(decision === "valider" ? "Fichier validé : la découpe CNC peut commencer." : "Fichier refusé : le dessinateur verra pourquoi.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

// A document of the register: one row, with its PDF to open.
function registerRow(entry) {
  return `
    <li class="register-row">
      <span class="register-date">${escapeHtml(entry.date || entry.frenchDate || "")}</span>
      <span class="register-what"><b>${escapeHtml(entry.typeLabel)} n° ${escapeHtml(entry.number)}</b> · ${escapeHtml(entry.client || "client non précisé")}${entry.object ? `<small>${escapeHtml(entry.object)}</small>` : ""}</span>
      <span class="register-amount">${entry.totalTtc === null || entry.totalTtc === undefined ? "" : escapeHtml(formatDh(entry.totalTtc))}</span>
      <span class="tag ${entry.status === "commandé" ? "ok" : ""}">${escapeHtml(entry.status)}</span>
      <button type="button" class="secondary" data-open-pdf="${escapeHtml(entry.stem)}">${icon("file")}Ouvrir le PDF</button>
    </li>
  `;
}

// What the Director found in the register, under its answer.
function foundCard(found) {
  return `
    <article class="doc-card register-card">
      <header>
        <span class="doc-icon">${icon("file")}</span>
        <div><strong>${found.length === 1 ? "Document trouvé" : `${found.length} documents trouvés`}</strong><span>Registre des documents</span></div>
      </header>
      <ul class="register-list">${found.map((entry) => registerRow(entry)).join("")}</ul>
    </article>
  `;
}

// An Excel file the Director made: it came with the answer, saved on a click.
function exportCard(file, index) {
  return `
    <article class="doc-card register-card">
      <header>
        <span class="doc-icon">${icon("file")}</span>
        <div><strong>${escapeHtml(file.title)}</strong><span>Fichier Excel · ${escapeHtml(String(file.rows))} ligne${file.rows > 1 ? "s" : ""}${file.file ? ` · aussi rangé dans ${escapeHtml(file.file)}` : ""}</span></div>
        <button type="button" class="primary" data-export="${index}">${icon("arrow")}Télécharger</button>
      </header>
    </article>
  `;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function saveExport(file) {
  if (!file) {
    return;
  }
  const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
  saveBlob(new Blob([bytes], { type: file.mimeType }), file.name);
}

// The register as searched, in Excel.
async function exportRegister(button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/documents/register.xlsx?${registerQuery()}`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("L'export Excel a échoué.");
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "registre-des-documents.xlsx";
    saveBlob(await response.blob(), name);
  } catch (error) {
    showToast(error.message, "warn");
  } finally {
    button.disabled = false;
  }
}

// The PDF needs the session token: fetched, then shown in a new tab. The tab
// is opened at the click, before the fetch, so it is not blocked as a popup.
async function openRegisterPdf(stem) {
  const tab = window.open("", "_blank");
  try {
    const response = await fetch(`/api/documents/register/${encodeURIComponent(stem)}/pdf`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error((await response.json().catch(() => ({}))).error ?? "PDF introuvable.");
    }
    const url = URL.createObjectURL(await response.blob());
    if (tab) {
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (error) {
    tab?.close();
    showToast(error.message, "warn");
  }
}

// What the register form asks: by client, number, type or dates. Read field
// by field: a page without FormData (the tests' stand-in) still loads.
function registerQuery() {
  const form = document.querySelector("#register-form");
  const field = (name) => String(form?.querySelector?.(`[name="${name}"]`)?.value ?? "").trim();
  const query = new URLSearchParams();
  const words = field("q");
  if (/^\d+$/.test(words)) {
    query.set("number", words);
  } else if (words) {
    query.set("client", words);
  }
  for (const key of ["type", "from", "to"]) {
    if (field(key)) {
      query.set(key, field(key));
    }
  }
  return query;
}

// The register in the Documents view: searched by client, number or date.
async function refreshRegister() {
  const form = document.querySelector("#register-form");
  const list = document.querySelector("#register-list");
  if (!form || !list) {
    return;
  }
  const query = registerQuery();
  try {
    const response = await fetch(`/api/documents/register?${query}`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de lire le registre.");
    }
    const register = await response.json();
    document.querySelector("#register-dir").textContent = register.dir ? `Dossiers clients : ${register.dir}` : "Classement sur le PC non activé.";
    list.innerHTML = register.documents.length > 0
      ? register.documents.map((entry) => registerRow({ ...entry, date: entry.frenchDate })).join("")
      : `<li class="muted">Aucun document ne correspond.</li>`;
    list.querySelectorAll("[data-open-pdf]").forEach((button) => {
      button.addEventListener("click", () => openRegisterPdf(button.dataset.openPdf));
    });
  } catch (error) {
    list.innerHTML = `<li class="muted">${escapeHtml(error.message)}</li>`;
  }
}

// Files every document now, and says what was copied, already there or missing.
async function syncRegister(button) {
  button.disabled = true;
  try {
    const response = await fetch("/api/documents/register/sync", { method: "POST", headers: { ...(await authHeaders()), "content-type": "application/json" }, body: "{}" });
    if (!response.ok) {
      throw new Error("Le classement a échoué.");
    }
    const report = await response.json();
    const missing = report.missing.length > 0 ? ` · PDF manquant : ${report.missing.map((entry) => `${entry.type} ${entry.number}`).join(", ")}` : "";
    showToast(report.disabled ? "Classement sur le PC non activé." : `${report.copied.length} classé(s), ${report.already} déjà en place${missing}.`, report.missing.length > 0 ? "warn" : "ok");
    await refreshRegister();
  } catch (error) {
    showToast(error.message, "warn");
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#register-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  refreshRegister();
});
document.querySelector("#register-form")?.addEventListener("change", () => refreshRegister());
document.querySelector("#register-sync")?.addEventListener("click", (event) => syncRegister(event.currentTarget));
document.querySelector("#register-export")?.addEventListener("click", (event) => exportRegister(event.currentTarget));

// The file needs the session token, so it is fetched, then saved from memory.
async function downloadCncFile(number, id, name) {
  try {
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/cnc/${encodeURIComponent(id)}`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Fichier CNC introuvable.");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = name || "fichier-cnc";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    showToast(error.message, "warn");
  }
}

// What the client sees of the order, and the controls of the link: made,
// copied, switched off; photos published and removed. Thumbnails come through
// the client's own link, so they only show while it is active.
function clientAccess(order) {
  const thumbnail = (photo) => order.portal
    ? `<img src="/api/public${escapeHtml(order.portal.path)}/photos/${encodeURIComponent(photo.id)}" alt="${escapeHtml(photo.caption || "Photo publiée")}" loading="lazy">`
    : `<span class="client-photo-placeholder">${icon("image")}</span>`;
  const photos = order.photos.length > 0 ? ` · ${order.photos.length} photo${order.photos.length > 1 ? "s" : ""}` : "";
  return orderPanel(order, "client", `${icon("link")}<span>Suivi client</span>${order.portal ? `<span class="tag ok">lien actif</span>` : ""}<small>${order.portal ? "" : "aucun lien"}${escapeHtml(photos)}</small>`, `
    <div class="client-access">
      <div class="client-access-head">
        <p>${order.portal
          ? `Lien actif depuis le ${escapeHtml(formatIsoDay(order.portal.createdAt.slice(0, 10)))} : le client voit l'avancement, la livraison prévue, l'échéancier, les photos et ses documents, jamais les notes.`
          : "Créez le lien, puis envoyez-le au client : il verra l'avancement, la livraison prévue, l'échéancier, les photos et ses documents, jamais les notes."}</p>
        <div class="client-access-actions">
          ${order.portal
            ? `<button type="button" class="secondary" data-portal-copy="${escapeHtml(order.portal.path)}">${icon("link")}Copier le lien</button>
               <button type="button" class="link-button" data-portal-close>Couper le lien</button>`
            : `<button type="button" class="secondary" data-portal-open>${icon("link")}Créer et copier le lien</button>`}
        </div>
      </div>
      <ul class="client-photos">
        ${order.photos.map((photo) => `
          <li>
            ${thumbnail(photo)}
            <span>${escapeHtml(photo.caption || "Sans légende")}<small>${escapeHtml(formatIsoDay(photo.publishedAt.slice(0, 10)))}</small></span>
            <button type="button" class="icon-button" data-photo-remove="${escapeHtml(photo.id)}" aria-label="Retirer la photo ${escapeHtml(photo.caption)}" title="Retirer">${icon("x")}</button>
          </li>`).join("")}
        <li class="client-photo-add">
          <label>${icon("image")} Publier une photo<input type="file" accept="image/jpeg,image/png" data-photo-input class="visually-hidden"></label>
        </li>
      </ul>
    </div>
  `);
}

async function sendPortalChange(number, action) {
  try {
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/portal`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ action })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error ?? "La mise à jour du lien a échoué.");
    }
    if (action === "fermer") {
      showToast(`Lien du BC n° ${number} coupé.`);
    }
    return body.link ?? null;
  } catch (error) {
    showToast(error.message, "warn");
    return null;
  } finally {
    await refreshOrders();
  }
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    showToast("Lien de suivi copié : collez-le dans le message au client.");
  } catch {
    globalThis.prompt?.("Lien de suivi du client :", url);
  }
}

async function publishOrderPhoto(number, file) {
  const caption = globalThis.prompt?.("Légende pour le client (facultative), par exemple « Assemblage terminé » :", "");
  if (caption === null) {
    return;
  }
  try {
    const photo = await downscaleImage(file, 1600, 0.85);
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/photos`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ photo, caption: caption ?? "" })
    });
    if (!response.ok) {
      throw new Error((await response.json()).error ?? "La photo n'a pas pu être publiée.");
    }
    showToast("Photo publiée sur le suivi client.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

async function removeOrderPhoto(number, id) {
  try {
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/photos/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: await authHeaders()
    });
    if (!response.ok && response.status !== 404) {
      throw new Error((await response.json()).error ?? "La photo n'a pas pu être retirée.");
    }
    showToast("Photo retirée du suivi client.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

// The paperwork of the sale, the amount aside: delivery notes, invoices, and
// what is left to invoice.
function orderDocuments(order) {
  const parts = [];
  if (order.deliveryNotes.length > 0) {
    parts.push(`BL n° ${order.deliveryNotes.join(", ")}`);
  }
  if (order.invoices.length > 0) {
    parts.push(`facture${order.invoices.length > 1 ? "s" : ""} n° ${order.invoices.join(", ")}`);
  }
  if (order.quoteNumber && order.remaining !== null) {
    // Non-breaking spaces, so an amount never splits across two lines.
    parts.push(order.remaining > 0 ? `reste à facturer ${formatDh(order.remaining).replace(/ /g, " ")}` : "facturée en totalité");
  }
  return parts.join(" · ");
}

async function sendOrderChange(number, step, body) {
  try {
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/steps/${encodeURIComponent(step)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error((await response.json()).error ?? "La mise à jour a échoué.");
    }
    showToast(`BC n° ${number} mis à jour.`);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

// What the cross-checks between the trades found. Computed from the data,
// never written by the model.
function alertsCard(alerts) {
  if (alerts.length === 0) {
    return `<article class="alerts-card ok"><header>${icon("check-circle")}<strong>Aucune incohérence entre les métiers</strong></header></article>`;
  }
  return `
    <article class="alerts-card">
      <header>${icon("alert")}<strong>${escapeHtml(String(alerts.length))} incohérence(s) détectée(s) entre les métiers</strong></header>
      <ul>
        ${alerts.map((alert) => `
          <li class="${alert.severity === "high" ? "high" : ""}">
            <p>${escapeHtml(alert.fact)}</p>
            <div class="alert-meta">
              ${alert.agents.map((agent) => avatar(agent)).join("")}
              <span>${escapeHtml(alert.action)}</span>
            </div>
          </li>
        `).join("")}
      </ul>
    </article>
  `;
}

const MESSAGE_KIND_LABELS = Object.freeze({
  relance_devis: "Relance devis",
  relance_paiement: "Relance paiement",
  retard: "Retard",
  commande_fournisseur: "Commande fournisseur",
  sav: "SAV",
  tache_equipe: "Tâche pour l'équipe",
  autre: "Message"
});

// A message an agent drafted. Nothing leaves without a click: with the
// company's WhatsApp Business number connected, the message goes from it as
// written in the card; otherwise the button opens WhatsApp with the number and
// the text filled in, and Hiba presses Send there. Both stay editable.
function messageCard(draft) {
  const viaApi = whatsAppView.configured;
  return `
    <article class="msg-card" data-recipient="${escapeHtml(draft.recipient)}" data-kind="${escapeHtml(draft.kind)}">
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
        ${viaApi
          ? `<button type="button" class="whatsapp-button" data-whatsapp-api>${icon("send")}Envoyer depuis le numéro H-KIDS</button>
             <button type="button" class="link-button" data-whatsapp>Ouvrir dans WhatsApp</button>
             <span class="muted">Part tout de suite, tel que vous l'avez relu.</span>`
          : `<button type="button" class="whatsapp-button" data-whatsapp>${icon("send")}Envoyer via WhatsApp</button>
             <span class="muted">S'ouvre dans WhatsApp : vous relisez, puis vous appuyez sur Envoyer.</span>`}
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

async function sendDraftFromNumber(button) {
  const card = button.closest(".msg-card");
  const number = whatsAppNumber(card.querySelector(".msg-phone").value);
  const status = card.querySelector(".msg-status");
  if (!number) {
    status.className = "tag warning msg-status";
    status.textContent = "Numéro à compléter";
    card.querySelector(".msg-phone").focus();
    return;
  }
  button.disabled = true;
  const sent = await sendWhatsApp({ to: number, message: card.querySelector(".msg-text").value, recipient: card.dataset.recipient ?? "", kind: card.dataset.kind ?? "autre" });
  if (sent.ok) {
    status.className = "tag ok msg-status";
    status.textContent = "Envoyé";
    return;
  }
  button.disabled = false;
  status.className = "tag warning msg-status";
  status.textContent = sent.code === "WHATSAPP_WINDOW_CLOSED" ? "Hors délai de 24 h : ouvrez WhatsApp" : "Non envoyé";
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
          <div class="team-answer answer-text">${formatAgentText(run.answer)}</div>
        </details>
      `).join("")}
    </div>
  `;
}

// The model writes Markdown: **bold**, titles, lists and tables (Hiba asks
// for « un tableau des devis du mois »). Everything is escaped first, then only
// these few forms become HTML; anything else stays text.
function formatAgentText(reply) {
  const inline = (text) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line ?? "");
  const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line ?? "");
  // A figure (« 3 200,00 DH », « 60 % », « -12 ») is right-aligned, to compare.
  const numeric = (cell) => /^[-+]?[\d\s.,]+(\s?(DH|MAD|%|€))?$/i.test(cell.replace(/\*\*/g, "")) && /\d/.test(cell);
  const lines = String(reply ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let text = [];
  const flush = () => {
    if (text.length > 0) {
      blocks.push(`<p>${text.map(inline).join("<br>")}</p>`);
      text = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isRow(line) && isRule(lines[index + 1])) {
      flush();
      const head = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && isRow(lines[index])) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      index -= 1;
      const cell = (tag, value) => `<${tag}${numeric(value) ? ` class="num"` : ""}>${inline(value)}</${tag}>`;
      blocks.push(`<div class="answer-table"><table><thead><tr>${head.map((value) => cell("th", value)).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${head.map((_, column) => cell("td", row[column] ?? "")).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const title = /^\s*#{1,4}\s+(.+)$/.exec(line);
    if (title) {
      flush();
      blocks.push(`<h4>${inline(title[1].replace(/\*\*/g, ""))}</h4>`);
      continue;
    }
    const item = /^\s*(?:[-*•]|(\d+)[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush();
      const ordered = Boolean(item[1]);
      const entries = [];
      while (index < lines.length) {
        const next = /^\s*(?:[-*•]|(\d+)[.)])\s+(.+)$/.exec(lines[index]);
        if (!next || Boolean(next[1]) !== ordered) {
          break;
        }
        entries.push(`<li>${inline(next[2])}</li>`);
        index += 1;
      }
      index -= 1;
      blocks.push(ordered ? `<ol>${entries.join("")}</ol>` : `<ul>${entries.join("")}</ul>`);
      continue;
    }
    if (line.trim() === "" || /^\s*-{3,}\s*$/.test(line)) {
      flush();
      continue;
    }
    text.push(line);
  }
  flush();
  return blocks.join("");
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
          <span>${escapeHtml(preview.client.name)} · ${escapeHtml(preview.client.address)} · ${escapeHtml(preview.date)}${entry.preparedBy ? ` · préparé par ${escapeHtml(formatAgent(entry.preparedBy))}` : ""}</span>
        </div>
        <span class="tag warning doc-status">À valider</span>
      </header>
      ${entry.replaces ? `<p class="doc-replaces">${icon("refresh")}<span>Correction du n° ${escapeHtml(preview.documentNumber)} : l'ancienne version sera archivée quand vous validerez.</span></p>` : ""}
      ${(entry.preview.notices ?? []).map((notice) => `<p class="doc-replaces">${icon("route")}<span>${escapeHtml(notice)}</span></p>`).join("")}
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
      userConfirmation: true,
      replaceExisting: entry.replaces === true
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
  // The report section stays out of the way until there is a report to show.
  briefingReport.hidden = false;
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

function renderApprovals() {
  const localApprovals = state.current?.decisionsRequired?.filter((decision) => decision.type === "approval") ?? [];
  const approvals = mergeApprovals(localApprovals, state.approvals);
  const pending = approvals.filter((approval) => approval.status === "pending").length;
  approvalCount.textContent = String(pending);
  approvalCount.hidden = pending === 0;
  updateOverview({ approvals: pending });
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
    legal: "Juridique",
    administration: "Administratif"
  };
  return names[agentId] ?? agentId ?? "Agent";
}

function formatStatus(status) {
  const labels = {
    completed: "Connecté",
    partial: "Réponse partielle",
    requires_approval: "Validation requise",
    failed: "Erreur"
  };
  return labels[status] ?? status ?? "Connecté";
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

// An amount that never breaks across two lines.
function formatDhNbsp(value) {
  return formatDh(value).replace(/ /g, "\u00a0");
}

// For a tile read at a glance: whole dirhams.
function formatShortDh(value) {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Number(value)).replace(/[\u202f ]/g, "\u00a0")}\u00a0DH`;
}

// The cockpit is one page with several views. The view is kept in the URL hash
// so a reload, or a link sent to a colleague, lands on the same screen.
const COCKPIT_VIEWS = Object.freeze({
  director: "Briefing du jour",
  approvals: "Validations",
  plans: "Plans d'action",
  cash: "Caisse",
  whatsapp: "WhatsApp Business",
  orders: "Carnet d'atelier",
  improvement: "Amélioration continue",
  documents: "Documents H-KIDS",
  quotes: "Préparation de devis",
  file: "Dossier commercial",
  team: "Équipe IA"
});

// On a phone the tab bar keeps the four views of every day; the others open
// from « Plus », which stays lit while one of them is shown. The cash of the
// day is on the briefing's first card.
const SHEET_VIEWS = Object.freeze(["cash", "whatsapp", "improvement", "team", "documents", "quotes", "file"]);
const moreButton = document.querySelector("#more-button");
const moreSheet = document.querySelector("#more-sheet");

function toggleMoreSheet(open) {
  moreSheet.hidden = !open;
  moreButton.setAttribute?.("aria-expanded", String(open));
}

moreButton.addEventListener("click", (event) => {
  event.stopPropagation?.();
  toggleMoreSheet(moreSheet.hidden);
});
globalThis.addEventListener?.("click", (event) => {
  if (!moreSheet.hidden && !event.target.closest?.("#more-sheet")) {
    toggleMoreSheet(false);
  }
});

function showView(name) {
  const view = Object.hasOwn(COCKPIT_VIEWS, name ?? "") ? name : "director";
  moreButton.dataset.active = String(SHEET_VIEWS.includes(view));
  toggleMoreSheet(false);
  if (view === "plans") {
    refreshPlans();
  }
  if (view === "orders") {
    refreshOrders();
  }
  if (view === "cash") {
    refreshCash();
  }
  if (view === "improvement") {
    refreshImprovement();
  }
  if (view === "whatsapp") {
    refreshWhatsApp();
  }
  if (view === "team") {
    refreshTeam();
  }
  if (view === "documents") {
    refreshRegister();
  }
  document.querySelector("#director-title").textContent = COCKPIT_VIEWS[view];
  // A view opens at its top, not where the previous one was left scrolled.
  if (document.querySelector(`[data-view-panel="${view}"]`)?.hidden === true) {
    globalThis.scrollTo?.({ top: 0, behavior: "instant" });
  }
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
  if (event.key === "Escape" && !moreSheet.hidden) {
    toggleMoreSheet(false);
    moreButton.focus?.();
  }
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
  document.querySelector("#greeting").textContent = `${greeting}, que souhaitez-vous faire ?`;
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
// A cockpit left open overnight still greets with the right day.
setInterval(() => renderGreeting(), 60_000)?.unref?.();
renderAgentRoster([]);
updateOverview({});
async function loadPanels() {
  await checkAgentStatus();
  refreshPlans();
  refreshOrders();
  refreshCash();
  refreshImprovement();
  refreshWhatsApp();
  refreshRegister();
  renderHistory();
  await refreshApprovals();
}
// Without a session the page finishes loading behind the sign-in, and the
// panels load once the person has signed in.
if (await ensureSession()) {
  await loadPanels();
} else {
  askLogin().then(async (session) => {
    showSession(session);
    await loadPanels();
  });
}
