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
  { id: "dessinateur_2d3d", initials: "2D", color: "#367d91", role: "Plans 2D/3D et fiche technique du meuble.", parent: "Production" },
  { id: "dessinateur_methodes", initials: "Mé", color: "#956030", role: "Débit, calepinage et fiches par opération.", parent: "Production" },
  { id: "purchasing", initials: "Ac", color: "#7a5ba6", role: "Matières, fournisseurs, stock et besoins d'achat." },
  { id: "hr", initials: "RH", color: "#a64b6b", role: "Présences, contrats et besoins de personnel." },
  { id: "marketing", initials: "Ma", color: "#c2852b", role: "Campagnes, offres et positionnement." },
  { id: "community_manager", initials: "CM", color: "#d0688a", role: "Réseaux sociaux et contenus.", parent: "Marketing" },
  { id: "legal", initials: "Ju", color: "#4f5d75", role: "Contrats, clauses, risques et échéances juridiques." },
  { id: "administration", initials: "Ad", color: "#6b6f2a", role: "Registre des documents et dossiers clients." },
  { id: "after_sales", initials: "SA", color: "#2f8a87", role: "Réclamations, garanties et qualité après livraison." }
]);

// The microphone records in the browser; the server turns it into text with
// the transcriber of WhatsApp's voice notes. Enabled once the server says it
// can transcribe.
const VOICE_INTERFACE = Object.freeze({
  status: "server_transcription",
  maxSeconds: 180,
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
const teamPlanNode = document.querySelector("#team-plan");
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

// --- The voice: speak instead of typing --------------------------------------
// A first touch starts recording, a second stops it (or three minutes). What
// was said is sent at once, as a voice note on WhatsApp, after anything
// already typed. The recording itself is not kept anywhere.
const voice = { available: false, recorder: null, chunks: [], timer: null, started: 0 };

voicePlaceholder.addEventListener("click", () => (voice.recorder ? stopVoice() : startVoice()));

async function startVoice() {
  if (!voice.available || agentState.busy) {
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    uiState.textContent = "Le micro est refusé : autorisez-le dans le navigateur (icône du cadenas), puis réessayez.";
    return;
  }
  const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported?.(type)) ?? "";
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  voice.recorder = recorder;
  voice.chunks = [];
  voice.started = Date.now();
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size > 0) {
      voice.chunks.push(event.data);
    }
  });
  recorder.addEventListener("stop", () => {
    stream.getTracks().forEach((track) => track.stop());
    transcribeVoice(new Blob(voice.chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
  });
  recorder.start();
  voicePlaceholder.className = "icon-button is-recording";
  voicePlaceholder.setAttribute("aria-pressed", "true");
  document.querySelector("#voice-label").textContent = "Arrêter l'enregistrement";
  const tick = () => {
    const seconds = Math.floor((Date.now() - voice.started) / 1000);
    uiState.textContent = `Je vous écoute… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} — touchez le micro pour terminer.`;
    if (seconds >= VOICE_INTERFACE.maxSeconds) {
      stopVoice();
    }
  };
  tick();
  voice.timer = setInterval(tick, 500);
}

function stopVoice() {
  clearInterval(voice.timer);
  const recorder = voice.recorder;
  voice.recorder = null;
  voicePlaceholder.setAttribute("aria-pressed", "false");
  document.querySelector("#voice-label").textContent = "Parler au lieu d'écrire";
  if (recorder && recorder.state !== "inactive") {
    voicePlaceholder.className = "icon-button is-transcribing";
    uiState.textContent = "Transcription…";
    recorder.stop();
  } else {
    voicePlaceholder.className = "icon-button";
  }
}

async function transcribeVoice(blob) {
  try {
    if (blob.size < 200) {
      uiState.textContent = "Enregistrement trop court : touchez le micro, parlez, puis touchez-le encore.";
      return;
    }
    const audio = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const response = await fetch("/api/agent/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ audio, mimeType: blob.type })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      uiState.textContent = payload.error ?? "La voix n'a pas pu être transcrite.";
      return;
    }
    // Sent at once, as a voice note on WhatsApp: what was heard shows in the
    // conversation as the message, after anything already typed.
    const typed = messageInput.value.trim();
    const said = typed ? `${typed} ${payload.text}` : payload.text;
    voicePlaceholder.className = "icon-button";
    if (agentState.busy) {
      // An answer is still on its way: the words wait in the box, not lost.
      messageInput.value = said;
      uiState.textContent = "Vocal transcrit : il partira quand la réponse en cours sera arrivée (bouton Envoyer).";
      return;
    }
    await askDirector(said);
  } catch {
    uiState.textContent = "Le serveur ne répond pas. Vérifiez la connexion internet.";
  } finally {
    voicePlaceholder.className = "icon-button";
  }
}

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
const loginCodeField = document.querySelector("#login-code-field");
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
          body: JSON.stringify({
            email: loginForm.email.value,
            password: loginForm.password.value,
            ...(loginCodeField.hidden ? {} : { code: loginForm.code.value })
          })
        });
        const payload = await response.json().catch(() => ({}));
        // Two-step sign-in: the right password, then the code of the app.
        if (response.status === 401 && payload.details?.code === "TWO_FACTOR_REQUIRED") {
          loginCodeField.hidden = false;
          loginError.hidden = true;
          loginForm.code.focus();
          return;
        }
        if (!response.ok) {
          loginError.textContent = response.status === 429
            ? "Trop d'essais. Patientez une minute avant de réessayer."
            : payload.error ?? "Connexion impossible.";
          loginError.hidden = false;
          return;
        }
        keepSession(payload.token);
        const typed = loginForm.password.value;
        loginForm.password.value = "";
        loginForm.code.value = "";
        loginCodeField.hidden = true;
        // A temporary password: the person chooses their own before the
        // cockpit opens. The one just typed is not asked again.
        if (payload.mustChangePassword) {
          await askPasswordChange(typed);
        }
        loginScreen.hidden = true;
        if (payload.mustEnableTwoFactor) {
          await requireTwoFactor();
        }
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

// The first sign-in with a temporary password: the person chooses their own on
// the sign-in screen, and nothing else opens until it is saved. `current` is
// the temporary password just typed, or null when it must be asked.
const passwordForm = document.querySelector("#password-form");
const passwordError = document.querySelector("#password-error");

function askPasswordChange(current) {
  loginForm.hidden = true;
  passwordForm.hidden = false;
  passwordError.hidden = true;
  document.querySelector("#password-current-field").hidden = current !== null;
  passwordForm.current.required = current === null;
  (current === null ? passwordForm.current : passwordForm.next).focus();
  return new Promise((resolve) => {
    passwordForm.onsubmit = async (event) => {
      event.preventDefault();
      const fail = (message) => {
        passwordError.textContent = message;
        passwordError.hidden = false;
      };
      if (passwordForm.next.value !== passwordForm.confirm.value) {
        fail("Les deux nouveaux mots de passe sont différents.");
        return;
      }
      const submit = document.querySelector("#password-submit");
      submit.disabled = true;
      try {
        const { ok, payload } = await changePassword(current ?? passwordForm.current.value, passwordForm.next.value);
        if (!ok) {
          fail(payload.error ?? "Enregistrement impossible.");
          return;
        }
        passwordForm.reset();
        passwordForm.hidden = true;
        loginForm.hidden = false;
        showToast("Mot de passe enregistré.");
        resolve();
      } catch {
        fail("Le serveur ne répond pas. Vérifiez la connexion internet.");
      } finally {
        submit.disabled = false;
      }
    };
  });
}

async function changePassword(current, next) {
  const response = await nativeFetch("/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ current, next })
  });
  return { ok: response.ok, payload: await response.json().catch(() => ({})) };
}

// True when a session is open: one kept from an earlier visit that the server
// still accepts, or a demo token. False means the sign-in has to be shown.
async function ensureSession() {
  apiToken ??= readStoredToken();
  if (apiToken) {
    const me = await nativeFetch("/api/auth/me", { headers: { authorization: `Bearer ${apiToken}` } });
    if (me.ok) {
      const session = await me.json();
      if (session.mustChangePassword) {
        loginScreen.hidden = false;
        await askPasswordChange(null);
        loginScreen.hidden = true;
      }
      if (session.mustEnableTwoFactor) {
        await requireTwoFactor();
      }
      showSession(session);
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

// Two-step sign-in, set up by each person for their own account: a QR code to
// scan with an authenticator app, a code typed back, and ten recovery codes
// shown that once.
const securityDialog = document.querySelector("#security-dialog");
const securityBody = document.querySelector("#security-body");

document.querySelector("#security-button").addEventListener("click", () => {
  securityDialog.showModal();
  showSecurityState();
});
document.querySelector("#security-close").addEventListener("click", () => securityDialog.close());

// Two-step sign-in is required for the direction (DIRECTION_TWO_FACTOR): the
// dialog opens on its own, cannot be closed, and the cockpit loads once the
// recovery codes are kept.
let twoFactorGate = null;
securityDialog.addEventListener("cancel", (event) => {
  if (twoFactorGate) {
    event.preventDefault();
  }
});

function requireTwoFactor() {
  return new Promise((resolve) => {
    twoFactorGate = resolve;
    document.querySelector("#security-close").hidden = true;
    securityDialog.showModal();
    showSecurityState();
  });
}

function closeSecurity() {
  securityDialog.close();
  if (twoFactorGate) {
    const open = twoFactorGate;
    twoFactorGate = null;
    document.querySelector("#security-close").hidden = false;
    open();
  }
}

async function securityCall(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(await authHeaders()) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

async function showSecurityState() {
  securityBody.innerHTML = `<p class="text-muted">Chargement…</p>`;
  const { ok, payload } = await securityCall("GET", "/api/auth/two-factor");
  if (!ok) {
    securityBody.innerHTML = `<p class="text-muted">${escapeHtml(payload.error ?? "Indisponible pour ce compte.")}</p>`;
    return;
  }
  if (!payload.enabled) {
    securityBody.innerHTML = `
      <p>À la connexion, en plus du mot de passe, le cockpit demandera un code à 6 chiffres affiché par une application sur votre téléphone. Un mot de passe volé ne suffira plus.</p>
      <p class="mt-3 text-muted">Il vous faut une application d'authentification : Google Authenticator ou Microsoft Authenticator (gratuites).</p>
      <button type="button" class="primary mt-5 w-full justify-center" id="security-start">${icon("shield")}Activer</button>`;
    securityBody.querySelector("#security-start").addEventListener("click", startTwoFactorSetup);
    if (twoFactorGate) {
      securityBody.insertAdjacentHTML("afterbegin", `<p class="mb-4 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 font-semibold">${icon("shield")}Obligatoire pour la direction : le cockpit s'ouvre une fois la double authentification activée.</p>`);
      return;
    }
    appendPasswordSection();
    appendDataSection();
    return;
  }
  securityBody.innerHTML = `
    <p class="flex items-center gap-2 font-semibold text-brand">${icon("check-circle")}Active${payload.enabledAt ? ` depuis le ${escapeHtml(new Date(payload.enabledAt).toLocaleDateString("fr-FR"))}` : ""}</p>
    <p class="mt-2 text-muted">Codes de secours restants : ${escapeHtml(String(payload.recoveryCodesLeft))} sur 10.${payload.recoveryCodesLeft <= 3 ? " Pensez à désactiver puis réactiver pour en avoir de nouveaux." : ""}</p>
    <form id="security-disable" class="mt-5 border-t border-line pt-4">
      <p class="font-semibold">Désactiver</p>
      <div class="field mt-3"><label for="security-password">Mot de passe</label><input id="security-password" type="password" autocomplete="current-password" required></div>
      <div class="field mt-3"><label for="security-disable-code">Code de l'application</label><input id="security-disable-code" inputmode="numeric" autocomplete="one-time-code" required></div>
      <p class="mt-3 text-[14px] text-danger" id="security-error" role="alert" hidden></p>
      <button type="submit" class="mt-4 w-full justify-center">Désactiver la double authentification</button>
    </form>`;
  securityBody.querySelector("#security-disable").addEventListener("submit", async (event) => {
    event.preventDefault();
    const { ok: done, payload: answer } = await securityCall("POST", "/api/auth/two-factor/disable", {
      password: securityBody.querySelector("#security-password").value,
      code: securityBody.querySelector("#security-disable-code").value
    });
    if (!done) {
      showSecurityError(answer.error ?? "Désactivation impossible.");
      return;
    }
    showToast("Double authentification désactivée.");
    showSecurityState();
  });
  appendPasswordSection();
  appendDataSection();
}

// Each person changes their own password here, with the one they have now.
// The other devices signed in to the account are signed out.
// The company's data, for the direction: everything in one ZIP, and how a
// deletion goes. The server refuses the export to anyone else.
function appendDataSection() {
  const section = document.createElement("section");
  section.id = "security-data";
  section.className = "mt-5 border-t border-line pt-4";
  section.innerHTML = `
    <p class="font-semibold">Données de l'entreprise</p>
    <p class="mt-2 text-muted">Toutes vos données dans un fichier ZIP : registres (caisse, atelier, RH, administratif…), documents émis en PDF et Word, copies classées et journal d'audit. Ni mots de passe ni clés de service.</p>
    <p class="mt-3 text-[14px] text-danger" id="security-data-error" role="alert" hidden></p>
    <button type="button" class="secondary mt-3 w-full justify-center" id="security-export">${icon("database")}Exporter toutes les données</button>
    <p class="mt-3 text-[13px] text-muted">Suppression du compte : demandez-la à votre fournisseur. Elle n'a lieu qu'après un export complet qui vous est remis ; les pièces comptables sont à garder dix ans (loi n° 9-88).</p>`;
  securityBody.append(section);
  const button = section.querySelector("#security-export");
  button.addEventListener("click", async () => {
    const error = section.querySelector("#security-data-error");
    error.hidden = true;
    button.disabled = true;
    try {
      const response = await fetch("/api/company/export", { headers: await authHeaders() });
      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).error ?? "L'export n'a pas pu être fait.");
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "export-donnees.zip";
      saveBlob(await response.blob(), name);
      showToast(`Export prêt : ${response.headers.get("x-export-files") ?? "tous les"} fichiers.`);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

function appendPasswordSection() {
  const section = document.createElement("form");
  section.id = "security-password-change";
  section.className = "mt-5 border-t border-line pt-4";
  section.innerHTML = `
    <p class="font-semibold">Changer mon mot de passe</p>
    <div class="field mt-3"><label for="security-current">Mot de passe actuel</label><input id="security-current" type="password" autocomplete="current-password" required></div>
    <div class="field mt-3"><label for="security-next">Nouveau mot de passe (10 caractères au moins)</label><input id="security-next" type="password" autocomplete="new-password" minlength="10" required></div>
    <div class="field mt-3"><label for="security-confirm-next">Confirmez le nouveau mot de passe</label><input id="security-confirm-next" type="password" autocomplete="new-password" minlength="10" required></div>
    <p class="mt-3 text-[14px] text-danger" id="security-password-error" role="alert" hidden></p>
    <button type="submit" class="mt-4 w-full justify-center">${icon("check")}Enregistrer le nouveau mot de passe</button>`;
  securityBody.append(section);
  section.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = section.querySelector("#security-password-error");
    const fail = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    const next = section.querySelector("#security-next").value;
    if (next !== section.querySelector("#security-confirm-next").value) {
      fail("Les deux nouveaux mots de passe sont différents.");
      return;
    }
    const { ok, payload } = await changePassword(section.querySelector("#security-current").value, next);
    if (!ok) {
      fail(payload.error ?? "Enregistrement impossible.");
      return;
    }
    section.reset();
    error.hidden = true;
    showToast(payload.otherSessionsClosed > 0 ? `Mot de passe changé. ${payload.otherSessionsClosed} autre(s) appareil(s) déconnecté(s).` : "Mot de passe changé.");
  });
}

function showSecurityError(message) {
  const error = securityBody.querySelector("#security-error");
  error.textContent = message;
  error.hidden = false;
}

async function startTwoFactorSetup() {
  const { ok, payload } = await securityCall("POST", "/api/auth/two-factor/setup");
  if (!ok) {
    securityBody.innerHTML = `<p class="text-danger">${escapeHtml(payload.error ?? "Impossible de préparer le QR code.")}</p>`;
    return;
  }
  // The QR code is drawn by the server from the secret it just made.
  securityBody.innerHTML = `
    <p><strong>1.</strong> Dans l'application, touchez « + » puis « Scanner un QR code ».</p>
    <div class="security-qr mx-auto mt-3 size-48 rounded-xl border border-line bg-white p-2">${payload.qrSvg}</div>
    <p class="mt-2 text-center text-[12.5px] text-muted">Pas de caméra ? Clé à saisir : <code class="select-all font-semibold text-ink">${escapeHtml(payload.secret)}</code></p>
    <form id="security-confirm" class="mt-4">
      <div class="field"><label for="security-code"><strong>2.</strong> Tapez le code à 6 chiffres affiché</label><input id="security-code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></div>
      <p class="mt-3 text-[14px] text-danger" id="security-error" role="alert" hidden></p>
      <button type="submit" class="primary mt-4 w-full justify-center">${icon("check")}Confirmer</button>
    </form>`;
  securityBody.querySelector("#security-code").focus();
  securityBody.querySelector("#security-confirm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const { ok: done, payload: answer } = await securityCall("POST", "/api/auth/two-factor/enable", {
      code: securityBody.querySelector("#security-code").value.replace(/\s+/g, "")
    });
    if (!done) {
      showSecurityError(answer.error ?? "Activation impossible.");
      return;
    }
    showRecoveryCodes(answer.recoveryCodes);
  });
}

function showRecoveryCodes(codes) {
  const text = `Codes de secours H-KIDS Cockpit\nChaque code fonctionne une seule fois, si le téléphone est perdu.\n\n${codes.join("\n")}\n`;
  securityBody.innerHTML = `
    <p class="flex items-center gap-2 font-semibold text-brand">${icon("check-circle")}Double authentification activée</p>
    <p class="mt-3">Gardez ces <strong>codes de secours</strong> en lieu sûr (papier, coffre). Ils remplacent le code de l'application si le téléphone est perdu, une fois chacun. Ils ne seront plus affichés.</p>
    <ul class="mt-3 grid list-none grid-cols-2 gap-2 p-0 font-mono text-[14px]">${codes.map((code) => `<li class="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-center">${escapeHtml(code)}</li>`).join("")}</ul>
    <div class="mt-4 flex gap-2">
      <button type="button" class="flex-1 justify-center" id="security-download">Télécharger</button>
      <button type="button" class="flex-1 justify-center" id="security-copy">Copier</button>
    </div>
    <button type="button" class="primary mt-3 w-full justify-center" id="security-done">J'ai gardé mes codes</button>`;
  securityBody.querySelector("#security-download").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    link.download = "codes-de-secours-hkids.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  });
  securityBody.querySelector("#security-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Codes copiés.");
    } catch {
      showToast("Copie impossible : notez-les à la main.");
    }
  });
  securityBody.querySelector("#security-done").addEventListener("click", closeSecurity);
}

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
// CDC section 2: the direction may write to an agent directly, not only
// through the Director. Each recipient keeps its own conversation.
const agentPicker = document.querySelector("#director-agent");
agentPicker?.addEventListener("change", () => {
  agentState.conversationId = null;
  const label = agentPicker.selectedOptions[0]?.textContent ?? "Director";
  sendButton.querySelector(".max-sm\\:hidden").textContent = `Envoyer ${agentPicker.value ? "à" : "au"} ${label}`;
  renderConversationHead();
});

// Writing to an agent directly takes the AI model: without it, only the
// Director is offered, and the menu stays hidden.
async function loadAgentPicker() {
  const field = document.querySelector("#director-agent-field");
  if (field) {
    field.hidden = !agentState.enabled;
  }
  if (!agentState.enabled) {
    return;
  }
  try {
    const response = await fetch("/api/team", { headers: await authHeaders() });
    if (response.ok) {
      fillAgentPicker((await response.json()).agents ?? []);
    }
  } catch {
    // The Director alone stays offered.
  }
}

function fillAgentPicker(agents) {
  if (!agentPicker) {
    return;
  }
  const chosen = agentPicker.value;
  agentPicker.innerHTML = `<option value="">Director</option>${agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.label)}</option>`).join("")}`;
  agentPicker.value = agents.some((agent) => agent.id === chosen) ? chosen : "";
  renderAgentContacts(agents);
  renderConversationHead();
}

// The agents one can write to, as a row of contacts above the conversation:
// touching one writes to it, as the menu does.
const agentContacts = document.querySelector("#agent-contacts");

function renderAgentContacts(agents) {
  if (!agentContacts) {
    return;
  }
  const contacts = [{ id: "", label: "Director" }, ...agents.map((agent) => ({ id: agent.id, label: agent.label }))];
  agentContacts.innerHTML = contacts.map((contact) => `
    <button type="button" class="agent-contact" data-agent="${escapeHtml(contact.id)}" aria-pressed="${contact.id === agentPicker.value}">${avatar(contact.id || "director")}<span>${escapeHtml(contact.label)}</span></button>
  `).join("");
  agentContacts.hidden = contacts.length < 2;
  agentContacts.querySelectorAll("[data-agent]").forEach((button) => {
    button.addEventListener("click", () => {
      if (agentPicker.value === button.dataset.agent) {
        return;
      }
      agentPicker.value = button.dataset.agent;
      agentPicker.dispatchEvent(new Event("change"));
    });
  });
}

// The head of the conversation names who is written to, and what it does.
function renderConversationHead() {
  const id = agentPicker?.value || "director";
  const agent = AGENT_ROSTER.find((entry) => entry.id === id);
  const head = document.querySelector("#conversation-avatar");
  if (head) {
    head.innerHTML = avatar(id, "lg");
  }
  const name = document.querySelector("#conversation-name");
  if (name) {
    name.textContent = agentPicker?.selectedOptions?.[0]?.textContent ?? "Director";
  }
  const role = document.querySelector("#conversation-role");
  if (role) {
    role.textContent = agent?.role ?? "";
  }
  agentContacts?.querySelectorAll("[data-agent]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.agent === (agentPicker?.value ?? "")));
  });
}
const agentPanel = document.querySelector("#agent-panel");
const agentThread = document.querySelector("#agent-thread");

const DOCUMENT_LABELS = Object.freeze({
  quote: "Devis",
  purchase_order: "Bon de commande",
  invoice: "Facture",
  delivery_note: "Bon de livraison",
  credit_note: "Avoir",
  payment_receipt: "Reçu de paiement"
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
    const status = response.ok ? await response.json() : {};
    agentState.enabled = status.configured === true;
    voice.available = status.voice === true && Boolean(globalThis.navigator?.mediaDevices?.getUserMedia) && typeof globalThis.MediaRecorder === "function";
  } catch {
    agentState.enabled = false;
    voice.available = false;
  }
  voicePlaceholder.disabled = !voice.available;
  voicePlaceholder.title = voice.available ? "Parler : touchez pour commencer, touchez encore pour arrêter" : "La voix n'est pas disponible sur ce serveur ou ce navigateur.";
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
  const recipient = agentPicker?.value ? agentPicker.selectedOptions[0].textContent : "Le Director";
  uiState.textContent = `${recipient} réfléchit…`;
  try {
    const response = await postJson("/api/agent/chat", { message: text, photos, files, conversationId: agentState.conversationId, agent: agentPicker?.value || null });
    agentState.conversationId = response.conversationId;
    pending.remove?.();
    appendBubble("agent", formatAgentText(response.reply), response.documents ?? [], response.agentRuns ?? [], response.messages ?? [], { plan: response.plan, alerts: response.alerts, found: response.foundDocuments ?? [], exports: response.exports ?? [], from: response.agent?.id ?? "director" });
    uiState.textContent = "Réponse reçue.";
    if (response.plan) {
      refreshPlans();
    }
    // Finance may have recorded money, an agent analysed an anomaly or moved
    // an order: the other views follow without a reload.
    refreshCash();
    refreshImprovement();
    refreshTeam();
    refreshHr();
    refreshAdmin();
    refreshStock();
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

function appendBubble(kind, html, documents = [], runs = [], messages = [], { plan = null, alerts = null, photos = [], files = [], found = [], exports = [], from = "director" } = {}) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind}`;
  bubble.innerHTML = `
    ${kind.startsWith("agent") ? avatar(from) : ""}
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
    <button type="button" class="overview-tile" data-tone="${tile.tone}" data-goto="${tile.view}" ${tile.filter ? `data-filter="${tile.filter}"` : ""} ${tile.value === null || tile.value === undefined ? `data-loading="true" aria-busy="true"` : ""}>
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
// The campaign an ad expense pays for, asked only for that category.
const cashCampaign = document.querySelector("#cash-campaign");
const cashCampaignField = document.querySelector("#cash-campaign-field");
const cashSubmit = document.querySelector("#cash-submit");
const cashView = { data: null, kind: "entree" };

document.querySelector("#refresh-cash").addEventListener("click", () => refreshCash());
cashDay.addEventListener("change", () => refreshCash());
cashForm.addEventListener("change", (event) => {
  if (event.target?.name === "kind") {
    cashView.kind = event.target.value;
    fillCashChoices();
  }
  showCashCampaign();
});
cashForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitCashMovement(false);
});

// The month's pack for the accountant: last month by default, the month the
// accountant usually asks for.
const accountingPack = document.querySelector("#accounting-pack");
const accountingPackMonth = document.querySelector("#accounting-pack-month");
accountingPack?.addEventListener?.("submit", async (event) => {
  event.preventDefault();
  const error = accountingPack.querySelector("#accounting-pack-error");
  const button = accountingPack.querySelector("#accounting-pack-submit");
  error.hidden = true;
  button.disabled = true;
  try {
    const month = accountingPackMonth.value || previousMonth();
    const response = await fetch(`/api/accounting/pack?month=${encodeURIComponent(month)}`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error((await response.json().catch(() => ({}))).error ?? "Le pack n'a pas pu être préparé.");
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? `pack-comptable-${month}.zip`;
    saveBlob(await response.blob(), name);
    const toComplete = Number(response.headers.get("x-pack-to-complete") ?? 0);
    showToast(toComplete > 0 ? `Pack prêt : ${toComplete} point${toComplete > 1 ? "s" : ""} à compléter, listé${toComplete > 1 ? "s" : ""} dans LISEZ-MOI.txt.` : "Pack prêt pour le comptable.");
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

function previousMonth(today = new Date()) {
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return first.toISOString().slice(0, 7);
}
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
  refreshBudgets();
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
  if (accountingPackMonth) {
    accountingPackMonth.value ||= previousMonth(new Date(`${today}T12:00:00Z`));
    accountingPackMonth.max = today.slice(0, 7);
  }
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
  showCashCampaign();
}

function showCashCampaign() {
  if (cashCampaignField) {
    cashCampaignField.hidden = !(cashView.kind === "sortie" && cashCategory.value === "publicite");
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
    campaign: cashCampaignField && !cashCampaignField.hidden ? cashCampaign.value : "",
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
    for (const field of [cashAmount, cashLabel, cashParty, cashQuote, cashOrder, cashCampaign].filter(Boolean)) {
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

// --- Stock view ------------------------------------------------------------------
// The register of the materials: what is on hand, under its minimum, what came
// in and went out lately, and what each purchase order took. It is kept by
// speaking to the Director; this view reads it.
const stockStats = document.querySelector("#stock-stats");
const stockBody = document.querySelector("#stock-body");
const stockCount = document.querySelector("#stock-count");
document.querySelector("#refresh-stock").addEventListener("click", () => refreshStock());

async function refreshStock() {
  try {
    const response = await fetch("/api/stock", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger le stock.");
    }
    renderStock(await response.json());
  } catch (error) {
    stockBody.innerHTML = card("Stock indisponible", escapeHtml(error.message), "warning");
  }
}

const STOCK_KINDS = Object.freeze({ entree: "Entrée", sortie: "Sortie", inventaire: "Inventaire" });
// « 8 panneaux » from 2 on, as the register writes it (stock-book.js).
const pluralUnit = (unit) => String(unit).split(" ").map((word) => (word.length <= 2 || !/^[\p{L}-]+$/u.test(word) || /[sxz]$/i.test(word) ? word : /(eau|au|eu)$/i.test(word) ? `${word}x` : `${word}s`)).join(" ");
const stockQuantity = (quantity, unit) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 }).format(quantity)} ${escapeHtml(Math.abs(quantity) >= 2 ? pluralUnit(unit) : unit)}`;
const stockDh = (amount) => `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} DH`;

function stockMovementLine(movement) {
  const what = movement.kind === "inventaire"
    ? `${stockQuantity(movement.counted, movement.unit)} comptés (écart ${movement.quantity > 0 ? "+" : ""}${stockQuantity(movement.quantity, movement.unit)})`
    : stockQuantity(Math.abs(movement.quantity), movement.unit);
  return [
    `<small>${formatIsoDay(movement.day)}</small> n° ${movement.number} ${STOCK_KINDS[movement.kind]} · ${escapeHtml(movement.name)} : ${what}`,
    movement.orderNumber ? ` · BC n° ${escapeHtml(movement.orderNumber)}` : "",
    movement.supplier ? ` · ${escapeHtml(movement.supplier)}` : "",
    movement.unitCost !== null ? ` · ${stockDh(movement.unitCost)} HT l'unité` : "",
    movement.note ? ` (${escapeHtml(movement.note)})` : "",
    movement.cancelled ? ` — annulée : ${escapeHtml(movement.cancelled.reason)}` : ""
  ].join("");
}

function renderStock({ overview }) {
  stockCount.textContent = String(overview.alerts.length);
  stockCount.hidden = overview.alerts.length === 0;
  if (overview.items.length === 0) {
    stockStats.innerHTML = "";
    stockBody.innerHTML = `
      <div class="all-clear">
        <span class="badge">${icon("package")}</span>
        <h3>Aucune matière suivie</h3>
        <p>Dites au Director quelles matières vous gardez en stock, avec leur unité et, si vous voulez une alerte, le minimum : « on suit le MDF 18 mm, en panneaux, minimum 10, livré en 5 jours ». Puis donnez le stock réel : « on a compté 14 panneaux ».</p>
      </div>
    `;
    return;
  }
  const tiles = [
    ["Matières suivies", overview.items.length, "au registre"],
    ["À commander", overview.alerts.length, "au niveau ou sous le minimum"],
    ["Valeur du stock", overview.value !== null ? stockDh(overview.value) : "—", overview.unpriced > 0 ? `HT, sans ${overview.unpriced} matière(s) sans prix` : "HT, au coût moyen d'achat"],
    ["Mouvements", overview.recent.length, "ces 30 derniers jours"]
  ];
  stockStats.innerHTML = tiles.map(([label, value, hint], index) => `
    <div class="stat-tile ${index === 1 && value > 0 ? "is-alert" : ""}"><strong>${value}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(hint)}</small></div>
  `).join("");
  const table = (head, rows) => `<div class="answer-table"><table><thead><tr>${head.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const sections = [];
  if (overview.alerts.length > 0) {
    sections.push(improvementSection("À commander", "Au niveau ou sous le minimum que vous avez fixé. L'agent Achats prépare la commande fournisseur.", overview.alerts.map((item) => `
      <article class="rule-card">
        <p><strong>${escapeHtml(item.name)}</strong> — ${item.status === "rupture" ? `<span class="tag warning">rupture</span> ` : ""}${stockQuantity(item.onHand, item.unit)} en stock pour un minimum de ${stockQuantity(item.minimum, item.unit)}${item.supplier ? ` · ${escapeHtml(item.supplier)}` : ""}${item.arrivesBy ? ` · commandé aujourd'hui, arrive vers le ${formatIsoDay(item.arrivesBy)}` : " · délai du fournisseur non renseigné"}</p>
      </article>
    `).join("")));
  }
  sections.push(improvementSection("Matières", "Le stock est la somme des entrées, des sorties et des écarts d'inventaire. Le coût moyen est pondéré sur les entrées qui ont un prix.", table(
    ["Matière", "En stock", "Minimum", "Fournisseur", "Délai", "Coût moyen HT"],
    overview.items.map((item) => `<tr><td>${escapeHtml(item.name)}${item.status !== "ok" ? ` <span class="tag warning">${item.status === "rupture" ? "rupture" : "à commander"}</span>` : ""}</td><td class="num">${stockQuantity(item.onHand, item.unit)}</td><td class="num">${item.minimum !== null ? stockQuantity(item.minimum, item.unit) : "—"}</td><td>${escapeHtml(item.supplier || "—")}</td><td class="num">${item.leadTimeDays !== null ? `${item.leadTimeDays} j` : "—"}</td><td class="num">${item.averageCost !== null ? stockDh(item.averageCost) : "—"}</td></tr>`)
  )));
  if (overview.consumption.length > 0) {
    sections.push(improvementSection("Consommation par bon de commande", "Les sorties notées pour chaque BC.", table(
      ["BC", "Matières sorties"],
      overview.consumption.slice(0, 20).map((order) => `<tr><td>n° ${escapeHtml(order.orderNumber)}</td><td>${order.lines.map((line) => `${stockQuantity(line.quantity, line.unit)} de ${escapeHtml(line.name)}`).join(", ")}</td></tr>`)
    )));
  }
  if (overview.recent.length > 0) {
    sections.push(`
      <details class="panel improvement-history">
        <summary><strong>30 derniers jours</strong><small>${overview.recent.length} mouvement(s)</small></summary>
        <ul>${overview.recent.map((movement) => `<li class="${movement.cancelled ? "line-through text-muted" : ""}">${stockMovementLine(movement)}</li>`).join("")}</ul>
      </details>
    `);
  }
  stockBody.innerHTML = sections.join("");
}

// --- Équipe RH view ---------------------------------------------------------------
// The team's book: who works here, who is away today, leave balances (Code du
// travail), leave requests the direction decides on, and the month's payroll
// variables for the accountant, without any amount.
const hrStats = document.querySelector("#hr-stats");
const hrBody = document.querySelector("#hr-body");
const hrCount = document.querySelector("#hr-count");
document.querySelector("#refresh-hr").addEventListener("click", () => refreshHr());
hrBody.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-leave-decision]");
  if (!button) {
    return;
  }
  button.disabled = true;
  try {
    await postJson(`/api/hr/leaves/${button.dataset.leave}/decision`, { decision: button.dataset.leaveDecision });
    showToast(button.dataset.leaveDecision === "approuve" ? "Congé approuvé." : "Congé refusé.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshHr();
});

async function refreshHr() {
  try {
    const response = await fetch("/api/hr", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger l'équipe RH.");
    }
    renderHr(await response.json());
  } catch (error) {
    hrBody.innerHTML = card("Équipe RH indisponible", escapeHtml(error.message), "warning");
  }
}

function renderHr({ overview, payroll, canDecide }) {
  hrCount.textContent = String(overview.pendingLeaves.length);
  hrCount.hidden = overview.pendingLeaves.length === 0;
  if (overview.headcount === 0 && (overview.positions ?? []).length === 0) {
    hrStats.innerHTML = "";
    hrBody.innerHTML = `
      <div class="all-clear">
        <span class="badge">${icon("user-check")}</span>
        <h3>Aucun salarié enregistré</h3>
        <p>Dites au Director qui travaille dans l'entreprise, avec le poste et la date d'entrée : « Samir, menuisier, a commencé le 03/03/2025 ». Les congés payés sont ensuite calculés seuls.</p>
      </div>
    `;
    return;
  }
  const tiles = [
    ["Effectif", overview.headcount, "salariés en poste"],
    ["Absents aujourd'hui", overview.absentToday.length, "absence ou congé"],
    ["Congés à décider", overview.pendingLeaves.length, canDecide ? "par vous, ci-dessous" : "par la direction"],
    (overview.positions ?? []).length > 0 ? ["Postes ouverts", overview.positions.length, "au recrutement"] : ["Congés à venir", overview.upcomingLeaves.length, "dans les 30 jours"]
  ];
  hrStats.innerHTML = tiles.map(([label, value, hint], index) => `
    <div class="stat-tile ${index === 2 && value > 0 ? "is-alert" : ""}"><strong>${value}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(hint)}</small></div>
  `).join("");
  const table = (head, rows) => `<div class="answer-table"><table><thead><tr>${head.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const sections = [];
  if (overview.pendingLeaves.length > 0) {
    sections.push(improvementSection("Demandes de congé", "Elles restent demandées jusqu'à votre décision.", overview.pendingLeaves.map((leave) => `
      <article class="rule-card">
        <p><strong>${escapeHtml(leave.name)}</strong> — ${escapeHtml(leave.kind)}, du ${formatIsoDay(leave.from)} au ${formatIsoDay(leave.to)} (${leave.days} jour${leave.days > 1 ? "s" : ""} ouvrable${leave.days > 1 ? "s" : ""})${leave.note ? ` · ${escapeHtml(leave.note)}` : ""}</p>
        ${canDecide ? `<div class="flex gap-2"><button type="button" data-leave="${leave.number}" data-leave-decision="approuve">${icon("check")}Approuver</button><button type="button" class="secondary" data-leave="${leave.number}" data-leave-decision="refuse">${icon("x")}Refuser</button></div>` : ""}
      </article>
    `).join("")));
  }
  if ((overview.alerts ?? []).length > 0) {
    sections.push(improvementSection("À traiter", "Fins de contrat, fins d'essai, formations à renouveler : elles sont aussi dans Amélioration.", `<ul class="flex flex-col gap-1">${overview.alerts.map((alert) => `<li>${alert.severity === "haute" ? `<span class="tag warning">urgent</span> ` : ""}${escapeHtml(alert.text)}</li>`).join("")}</ul>`));
  }
  if (overview.absentToday.length > 0 || overview.upcomingLeaves.length > 0) {
    sections.push(improvementSection("Absences", "Aujourd'hui, puis les congés approuvés des 30 prochains jours.", `<ul class="flex flex-col gap-1">${[
      ...overview.absentToday.map((entry) => `<li><strong>${escapeHtml(entry.name)}</strong> : ${escapeHtml(entry.why)}</li>`),
      ...overview.upcomingLeaves.map((leave) => `<li>${escapeHtml(leave.name)} : ${escapeHtml(leave.kind)} du ${formatIsoDay(leave.from)} au ${formatIsoDay(leave.to)}</li>`)
    ].join("")}</ul>`));
  }
  sections.push(improvementSection("Salariés et congés payés", "1,5 jour ouvrable par mois de service, plus 1,5 jour par tranche de cinq ans d'ancienneté (art. 231 et 232).", table(
    ["Salarié", "Poste", "Entrée", "Acquis", "Pris", "Reste"],
    overview.employees.map((employee) => `<tr><td>${escapeHtml(employee.name)}</td><td>${escapeHtml(employee.role || "—")}</td><td>${formatIsoDay(employee.startDate)}</td><td class="num">${employee.leave.earned}</td><td class="num">${employee.leave.taken}</td><td class="num">${employee.leave.eligible ? employee.leave.remaining : `${employee.leave.remaining} <small>(dû après 6 mois)</small>`}</td></tr>`)
  )));
  if ((overview.contracts ?? []).length > 0) {
    sections.push(improvementSection("Contrats", "Le contrat en cours de chacun, et la fin de sa période d'essai (art. 14 du Code du travail). Le contrat signé fait foi.", table(
      ["Salarié", "Contrat", "Début", "Fin", "Fin d'essai"],
      overview.contracts.map((entry) => entry.number
        ? `<tr><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(entry.label)} <small>n° ${entry.number}</small></td><td>${formatIsoDay(entry.start)}</td><td>${entry.end ? formatIsoDay(entry.end) : "—"}</td><td>${entry.trialEnd ? formatIsoDay(entry.trialEnd) : "—"}</td></tr>`
        : `<tr><td>${escapeHtml(entry.name)}</td><td colspan="4"><small>Aucun contrat noté : « ${escapeHtml(entry.name.split(" ")[0])} est en CDI depuis le … »</small></td></tr>`)
    )));
  }
  const positions = overview.positions ?? [];
  if (positions.length > 0) {
    sections.push(improvementSection("Recrutement", canDecide ? "Du candidat, seulement le nom, le numéro, la provenance et une note (loi 09-08). Ses données s'effacent 12 mois après la clôture du poste." : "Les postes ouverts. Les candidatures sont réservées à la direction.", positions.map((position) => `
      <article class="rule-card">
        <p><strong>Poste n° ${position.number} : ${escapeHtml(position.title)}</strong> <small>ouvert le ${formatIsoDay(position.openedOn)} · ${position.applications} candidature${position.applications > 1 ? "s" : ""}</small>${position.need ? `<br><small>${escapeHtml(position.need)}</small>` : ""}</p>
        ${position.candidates.length > 0 ? `<ul class="flex flex-col gap-1">${position.candidates.map((candidate) => `<li>n° ${candidate.number} <strong>${escapeHtml(candidate.name)}</strong> — ${escapeHtml(candidate.label)}${candidate.status === "entretien" && candidate.interview ? ` le ${formatIsoDay(candidate.interview)}` : ""}${candidate.source ? ` <small>via ${escapeHtml(candidate.source)}</small>` : ""}${candidate.note ? ` <small>· ${escapeHtml(candidate.note)}</small>` : ""}</li>`).join("")}</ul>` : ""}
      </article>
    `).join("")));
  }
  const trainings = overview.trainings ?? [];
  if (trainings.length > 0) {
    sections.push(improvementSection("Formations", "Planifiées, et réalisées ces deux derniers mois.", table(
      ["Formation", "Salariés", "Dates", "État", "Valable jusqu'au"],
      trainings.map((training) => `<tr><td>${escapeHtml(training.title)} <small>n° ${training.number}${training.provider ? ` · ${escapeHtml(training.provider)}` : ""}</small></td><td>${escapeHtml(training.names.join(", "))}</td><td>${training.from === training.to ? formatIsoDay(training.from) : `${formatIsoDay(training.from)} → ${formatIsoDay(training.to)}`}</td><td>${escapeHtml(training.label)}</td><td>${training.validUntil ? formatIsoDay(training.validUntil) : "—"}</td></tr>`)
    )));
  }
  if (payroll) {
    const month = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${payroll.month}-01T00:00:00Z`));
    sections.push(improvementSection(`Variables de paie — ${month}`, `${payroll.workingDays} jours ouvrables. Sans montant : la paie, la CNSS et l'IR sont calculés par le comptable.`, table(
      ["Salarié", "Jours travaillés", "Abs. justifiées", "Abs. non justifiées", "Congés (j)", "Retards (h)", "Heures sup."],
      payroll.rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td class="num">${row.daysWorked} / ${row.workingDays}</td><td class="num">${row.absencesJustified}</td><td class="num">${row.absencesUnjustified}</td><td class="num">${Object.values(row.leave).reduce((sum, days) => sum + days, 0)}</td><td class="num">${row.hoursLate}</td><td class="num">${row.overtimeHours}</td></tr>`)
    )));
  }
  if (overview.recent.length > 0) {
    sections.push(`
      <details class="panel improvement-history">
        <summary><strong>14 derniers jours</strong><small>${overview.recent.length} absence(s), retard(s) ou heures supplémentaires</small></summary>
        <ul>${overview.recent.map((entry) => `<li><small>${formatIsoDay(entry.day)}</small> n° ${entry.number} ${escapeHtml(entry.name)} : ${escapeHtml(entry.label)}${entry.hours ? ` ${entry.hours} h` : ""}${entry.kind === "absence" ? (entry.justified ? " justifiée" : " non justifiée") : ""}${entry.reason ? ` (${escapeHtml(entry.reason)})` : ""}</li>`).join("")}</ul>
      </details>
    `);
  }
  hrBody.innerHTML = sections.join("");
}

// --- Administratif view ---------------------------------------------------------------
// The register the Administratif keeps beside the documents: deadlines to
// meet, the company's contracts and their notice, the mail register with the
// letters prepared for the direction to read, and the suppliers.
const adminStats = document.querySelector("#admin-stats");
const adminBody = document.querySelector("#admin-body");
const adminCount = document.querySelector("#admin-count");
let adminLetterhead = [];
let adminMail = [];
document.querySelector("#refresh-admin").addEventListener("click", () => refreshAdmin());
adminBody.addEventListener("click", async (event) => {
  const copy = event.target.closest?.("[data-copy-letter]");
  if (copy) {
    const mail = adminMail.find((entry) => String(entry.number) === copy.dataset.copyLetter);
    try {
      await navigator.clipboard.writeText([...adminLetterhead, "", mail?.body ?? ""].join("\n"));
      showToast("Courrier copié, avec l'en-tête.");
    } catch {
      showToast("Copie impossible : sélectionnez le texte à la main.", "warn");
    }
    return;
  }
  const button = event.target.closest?.("[data-deadline-done], [data-mail-close]");
  if (!button) {
    return;
  }
  button.disabled = true;
  try {
    if (button.dataset.deadlineDone) {
      await postJson(`/api/admin/deadlines/${button.dataset.deadlineDone}/done`, {});
      showToast("Échéance faite.");
    } else {
      await postJson(`/api/admin/mail/${button.dataset.mailClose}/close`, {});
      showToast(button.dataset.way === "sortant" ? "Courrier noté envoyé." : "Courrier noté traité.");
    }
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshAdmin();
});

async function refreshAdmin() {
  try {
    const response = await fetch("/api/admin", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger le registre administratif.");
    }
    renderAdmin(await response.json());
  } catch (error) {
    adminBody.innerHTML = card("Administratif indisponible", escapeHtml(error.message), "warning");
  }
}

function renderAdmin({ overview, letterhead = [], canDecide }) {
  adminLetterhead = letterhead;
  adminMail = overview.mail;
  const late = overview.deadlines.filter((deadline) => deadline.days < 0);
  const soon = overview.deadlines.filter((deadline) => deadline.days >= 0 && deadline.days <= 30);
  const toAnswer = overview.mail.filter((mail) => mail.status === "a_traiter");
  const drafts = overview.mail.filter((mail) => mail.status === "brouillon");
  adminCount.textContent = String(overview.alerts.length);
  adminCount.hidden = overview.alerts.length === 0;
  if (overview.suppliers.length + overview.contracts.length + overview.deadlines.length + overview.mail.length === 0) {
    adminStats.innerHTML = "";
    adminBody.innerHTML = `
      <div class="all-clear">
        <span class="badge">${icon("folder")}</span>
        <h3>Registre administratif vide</h3>
        <p>Dites au Director vos fournisseurs, vos contrats (bail, assurance, leasing…) et vos échéances régulières : « la TVA chaque mois avant le 20 », « l'assurance de l'atelier se renouvelle le 01/01, préavis de 2 mois ».</p>
      </div>
    `;
    return;
  }
  const tiles = [
    ["Échéances en retard", late.length, "à régler"],
    ["Échéances", soon.length, "dans les 30 jours"],
    ["Courriers à traiter", toAnswer.length, drafts.length > 0 ? `${drafts.length} brouillon${drafts.length > 1 ? "s" : ""} à relire` : "reçus"],
    ["Contrats", overview.contracts.length, "en cours"]
  ];
  adminStats.innerHTML = tiles.map(([label, value, hint], index) => `
    <div class="stat-tile ${index === 0 && value > 0 ? "is-alert" : ""}"><strong>${value}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(hint)}</small></div>
  `).join("");
  const table = (head, rows) => `<div class="answer-table"><table><thead><tr>${head.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const sections = [];
  if (overview.alerts.length > 0) {
    sections.push(improvementSection("À traiter", "Elles sont aussi dans Amélioration, confiées à l'Administratif.", `<ul class="flex flex-col gap-1">${overview.alerts.map((alert) => `<li>${alert.severity === "haute" ? `<span class="tag warning">urgent</span> ` : ""}${escapeHtml(alert.text)}</li>`).join("")}</ul>`));
  }
  if (overview.deadlines.length > 0) {
    sections.push(improvementSection("Échéances", "Une échéance récurrente faite passe à sa date suivante. Les échéances fiscales et sociales se confirment avec le comptable.", table(
      ["Échéance", "Type", "Date", "Rythme", ""],
      overview.deadlines.map((deadline) => `<tr><td>${escapeHtml(deadline.title)} <small>n° ${deadline.number}</small>${deadline.note ? `<br><small>${escapeHtml(deadline.note)}</small>` : ""}</td><td>${escapeHtml(deadline.label)}</td><td>${formatIsoDay(deadline.due)}<br><small class="${deadline.days < 0 ? "text-danger" : ""}">${deadline.days < 0 ? `en retard de ${-deadline.days} j` : deadline.days === 0 ? "aujourd'hui" : `dans ${deadline.days} j`}</small></td><td>${escapeHtml(deadline.recurrenceLabel)}</td><td><button type="button" class="secondary" data-deadline-done="${deadline.number}">${icon("check")}Faite</button></td></tr>`)
    )));
  }
  if (overview.mail.length > 0) {
    sections.push(improvementSection("Courriers", canDecide ? "Le registre chrono des courriers reçus et envoyés. Un courrier préparé reste un brouillon : relisez-le, copiez-le avec l'en-tête, envoyez-le, puis notez-le envoyé." : "Le registre chrono des courriers. Les brouillons sont relus par la direction.", overview.mail.map((mail) => `
      <article class="rule-card">
        <p><strong>${escapeHtml(mail.chrono)}</strong> · ${mail.way === "entrant" ? "reçu de" : "pour"} <strong>${escapeHtml(mail.party)}</strong> le ${formatIsoDay(mail.date)} — ${escapeHtml(mail.subject)} <span class="tag ${mail.status === "a_traiter" || mail.status === "brouillon" ? "warning" : ""}">${escapeHtml(mail.label)}</span>${mail.reference ? ` <small>réf. ${escapeHtml(mail.reference)}</small>` : ""}${mail.replyBy && mail.status === "a_traiter" ? `<br><small>Réponse avant le ${formatIsoDay(mail.replyBy)}</small>` : ""}</p>
        ${mail.body ? `<details><summary>Lire le courrier</summary><div class="letter-preview">${letterhead.length > 0 ? `<p class="letter-head">${letterhead.map(escapeHtml).join("<br>")}</p>` : ""}<p>${escapeHtml(mail.body).replace(/\n/g, "<br>")}</p></div></details>` : ""}
        ${(mail.status === "a_traiter" || (mail.status === "brouillon" && canDecide)) ? `<div class="flex gap-2">${mail.body && canDecide ? `<button type="button" class="secondary" data-copy-letter="${mail.number}">${icon("file")}Copier</button>` : ""}<button type="button" data-mail-close="${mail.number}" data-way="${mail.way}">${icon("check")}${mail.way === "sortant" ? "Envoyé" : "Traité"}</button></div>` : ""}
      </article>
    `).join("")));
  }
  if (overview.contracts.length > 0) {
    sections.push(improvementSection("Contrats de l'entreprise", "Avec leur échéance et, pour une reconduction tacite, la dernière date pour résilier.", table(
      ["Contrat", "Partie", "Échéance", "Renouvellement", ...(canDecide ? ["Montant"] : [])],
      overview.contracts.map((contract) => `<tr><td>${escapeHtml(contract.title)} <small>n° ${contract.number} · ${escapeHtml(contract.label)}</small></td><td>${escapeHtml(contract.party || "—")}</td><td>${contract.currentEnd ? formatIsoDay(contract.currentEnd) : "—"}</td><td>${escapeHtml(contract.renewalLabel)}${contract.noticeBy ? `<br><small>résilier avant le ${formatIsoDay(contract.noticeBy)}</small>` : ""}</td>${canDecide ? `<td class="num">${contract.amount !== null ? `${formatDh(contract.amount)}${contract.period ? ` <small>${escapeHtml(contract.period)}</small>` : ""}` : "—"}</td>` : ""}</tr>`)
    )));
  }
  if (overview.suppliers.length > 0) {
    sections.push(improvementSection("Fournisseurs", "Leurs coordonnées et conditions, telles que la direction les a données.", table(
      ["Fournisseur", "Activité", "Contact", "Conditions"],
      overview.suppliers.map((supplier) => `<tr><td>${escapeHtml(supplier.name)}${supplier.ice ? `<br><small>ICE ${escapeHtml(supplier.ice)}</small>` : ""}</td><td>${escapeHtml(supplier.trade || "—")}</td><td>${[supplier.contact, supplier.phone, supplier.email].filter(Boolean).map(escapeHtml).join("<br>") || "—"}</td><td>${escapeHtml(supplier.terms || "—")}${supplier.note ? `<br><small>${escapeHtml(supplier.note)}</small>` : ""}</td></tr>`)
    )));
  }
  adminBody.innerHTML = sections.join("");
}

// --- Abonnements view (the cockpit that sells the SaaS) -----------------------------
// The client companies, the month's invoices to issue under H-KIDS' series,
// the unpaid ones with their reminder ready to copy, and the suspensions to
// decide. Each invoice is shown with its number before it is issued.
const saasStats = document.querySelector("#saas-stats");
const saasBody = document.querySelector("#saas-body");
const saasCount = document.querySelector("#saas-count");
const SAAS_PLANS = Object.freeze({ starter: "Starter", business: "Business", enterprise: "Enterprise" });
document.querySelector("#refresh-saas").addEventListener("click", () => refreshSaas());

const saasInvoiceUrl = (button) => `/api/saas/invoices/${encodeURIComponent(button.dataset.slug)}/${encodeURIComponent(button.dataset.period)}`;

saasBody.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-saas-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.saasAction;
  button.disabled = true;
  try {
    if (action === "prepare") {
      const { prepared } = await postJson("/api/saas/prepare", {});
      showToast(prepared.length > 0 ? `${prepared.length} facture(s) du mois préparée(s).` : "Toutes les factures du mois sont déjà préparées.");
    }
    if (action === "issue") {
      const preview = await postJson(`${saasInvoiceUrl(button)}/preview`, {});
      const line = preview.document.items[0];
      const confirmed = globalThis.confirm?.(`Émettre la facture n° ${preview.number} ?\n\n${preview.document.client.name}\n${line.designation}\n${formatDh(preview.document.totals.totalHt)} HT + TVA ${formatDh(preview.document.totals.tva)} = ${formatDh(preview.document.totals.totalTtc)} TTC\n${preview.document.payment.terms}\n\nUne facture émise ne s'efface pas : elle se corrige par un avoir.`);
      if (!confirmed) {
        button.disabled = false;
        return;
      }
      await postJson(`${saasInvoiceUrl(button)}/issue`, { number: preview.number });
      showToast(`Facture n° ${preview.number} émise. Elle est dans Documents, à envoyer au client.`);
    }
    if (action === "paid") {
      const day = globalThis.prompt?.("Date du virement reçu (JJ/MM/AAAA) :", new Intl.DateTimeFormat("fr-FR").format(new Date()));
      if (!day) {
        button.disabled = false;
        return;
      }
      await postJson(`${saasInvoiceUrl(button)}/paid`, { paidOn: day.trim() });
      showToast("Paiement noté.");
    }
    if (action === "copy-reminder") {
      await globalThis.navigator?.clipboard?.writeText(button.dataset.text);
      await postJson(`${saasInvoiceUrl(button)}/reminder`, { step: button.dataset.step });
      showToast("Relance copiée : collez-la dans l'e-mail ou le WhatsApp du client.");
    }
    if (action === "copy-command") {
      await globalThis.navigator?.clipboard?.writeText(button.dataset.text);
      showToast("Commande copiée : à lancer sur le serveur, depuis /opt/hkids.");
    }
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshSaas();
});

saasBody.addEventListener("submit", async (event) => {
  const formNode = event.target.closest?.("[data-saas-client-form]");
  if (!formNode) {
    return;
  }
  event.preventDefault();
  const read = (name) => formNode.querySelector(`[name='${name}']`)?.value ?? "";
  try {
    const since = read("since");
    await postJson("/api/saas/clients", {
      slug: read("slug"), name: read("name"), address: read("address"), plan: read("plan"), priceHt: read("priceHt"),
      ice: read("ice"), email: read("email"), since: since ? since.split("-").reverse().join("/") : ""
    });
    showToast("Entreprise cliente ajoutée.");
    await refreshSaas();
  } catch (error) {
    showToast(error.message, "warn");
  }
});

async function refreshSaas() {
  try {
    const response = await fetch("/api/saas", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error((await response.json().catch(() => ({}))).error ?? "Impossible de charger les abonnements.");
    }
    renderSaas((await response.json()).overview);
  } catch (error) {
    saasStats.innerHTML = "";
    saasBody.innerHTML = card("Abonnements indisponibles", escapeHtml(error.message), "warning");
  }
}

function renderSaas(overview) {
  const pending = overview.toIssue.length + overview.unpaid.filter((invoice) => invoice.reminderDue !== null).length + overview.toSuspend.length;
  saasCount.textContent = String(pending);
  saasCount.hidden = pending === 0;
  const tiles = [
    ["Revenu mensuel", formatDh(overview.monthlyHt), `HT · ${formatDh(overview.yearlyHt)} sur un an`],
    ["Entreprises actives", overview.activeCount, Object.entries(SAAS_PLANS).map(([id, label]) => `${overview.byPlan[id] ?? 0} ${label}`).join(" · ")],
    ["À encaisser", formatDh(overview.unpaidTtc), "TTC, factures émises"],
    ["En retard", formatDh(overview.lateTtc), "TTC, échéance passée"]
  ];
  saasStats.innerHTML = tiles.map(([label, value, hint], index) => `
    <div class="stat-tile ${index === 3 && overview.lateTtc > 0 ? "is-alert" : ""}"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(hint)}</small></div>
  `).join("");
  const table = (head, rows) => `<div class="answer-table"><table><thead><tr>${head.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const data = (entry) => `data-slug="${escapeHtml(entry.slug)}" data-period="${escapeHtml(entry.period)}"`;
  const sections = [];

  sections.push(improvementSection("Factures à émettre", "Préparées le 1er du mois pour chaque entreprise active. Vous voyez le numéro et le montant avant d'émettre.",
    overview.toIssue.length > 0
      ? overview.toIssue.map((entry) => `
        <article class="rule-card">
          <p><strong>${escapeHtml(entry.name)}</strong> : abonnement ${escapeHtml(entry.plan)}, ${escapeHtml(entry.month)}, ${escapeHtml(formatDh(entry.totalHt))} HT (${escapeHtml(formatDh(entry.totalTtc))} TTC)</p>
          <div class="flex gap-2"><button type="button" data-saas-action="issue" ${data(entry)}>${icon("check")}Voir le numéro et émettre</button></div>
        </article>`).join("")
      : `<p class="muted">Rien à émettre. <button type="button" class="secondary" data-saas-action="prepare">${icon("refresh")}Préparer les factures du mois</button></p>`));

  if (overview.unpaid.length > 0) {
    sections.push(improvementSection("Factures impayées", `Échéance à ${overview.settings.dueDays} jours. Une relance est proposée ${overview.settings.reminderDays.map((day) => `à J+${day}`).join(" et ")} après l'échéance : copiez-la et envoyez-la vous-même.`,
      overview.unpaid.map((invoice) => `
        <article class="rule-card ${invoice.daysLate > 0 ? "is-alert" : ""}">
          <p><strong>${escapeHtml(invoice.name)}</strong> : facture n° ${escapeHtml(invoice.number)} du ${formatIsoDay(invoice.date)}, ${escapeHtml(invoice.month)}, ${escapeHtml(formatDh(invoice.totalTtc))} TTC · ${invoice.daysLate > 0 ? `<strong>${invoice.daysLate} jour(s) de retard</strong>` : `à payer avant le ${formatIsoDay(invoice.dueDate)}`}${invoice.remindersSent.length > 0 ? ` · relancée ${invoice.remindersSent.map((day) => `J+${day}`).join(", ")}` : ""}</p>
          <div class="flex flex-wrap gap-2">
            <button type="button" data-saas-action="paid" ${data(invoice)}>${icon("check")}Virement reçu</button>
            ${invoice.reminderDue !== null ? `<button type="button" class="secondary" data-saas-action="copy-reminder" data-step="${invoice.reminderDue}" data-text="${escapeHtml(invoice.reminderText)}" ${data(invoice)}>${icon("send")}Copier la relance J+${invoice.reminderDue}</button>` : ""}
          </div>
        </article>`).join("")));
  }

  if (overview.toSuspend.length > 0) {
    sections.push(improvementSection("Suspensions à décider", `Impayé depuis plus de ${overview.settings.suspendAfterDays} jours après l'échéance. La suspension met le cockpit du client en lecture seule ; ses données restent intactes et exportables.`,
      overview.toSuspend.map((entry) => `
        <article class="rule-card is-alert">
          <p><strong>${escapeHtml(entry.name)}</strong> · sur le serveur : <code>${escapeHtml(entry.command)}</code></p>
          <div class="flex gap-2"><button type="button" class="secondary" data-saas-action="copy-command" data-text="${escapeHtml(entry.command)}">${icon("link")}Copier la commande</button></div>
        </article>`).join("")));
  }

  sections.push(improvementSection("Entreprises clientes", "Le nom légal et l'adresse du siège sont ceux imprimés sur leurs factures.",
    overview.clients.length > 0
      ? table(["Entreprise", "Identifiant", "Offre", "Prix HT / mois", "Depuis", "Statut", "Impayé TTC"], overview.clients.map((client) => `<tr><td>${escapeHtml(client.name)}</td><td>${escapeHtml(client.slug)}</td><td>${escapeHtml(client.planLabel)}</td><td class="num">${escapeHtml(formatDh(client.priceHt))}</td><td>${formatIsoDay(client.since)}</td><td>${escapeHtml(client.status)}</td><td class="num">${client.unpaidTtc > 0 ? escapeHtml(formatDh(client.unpaidTtc)) : "—"}</td></tr>`))
      : `<p class="muted">Aucune entreprise cliente pour l'instant.</p>`));

  sections.push(`
    <details class="task-assign panel">
      <summary>Ajouter une entreprise cliente</summary>
      <form data-saas-client-form>
        <label>Identifiant<input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{1,29}" placeholder="celui de son cockpit (tenant.sh)"></label>
        <label class="wide">Nom légal<input name="name" required placeholder="tel qu'au registre du commerce"></label>
        <label class="wide">Adresse du siège<input name="address" required></label>
        <label>Offre<select name="plan">${Object.entries(SAAS_PLANS).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
        <label>Prix HT / mois<input name="priceHt" inputmode="decimal" placeholder="celui de l'offre"></label>
        <label>Début<input name="since" type="date"></label>
        <label>ICE<input name="ice" inputmode="numeric"></label>
        <label>E-mail de facturation<input name="email" type="email"></label>
        <button type="submit" class="primary">${icon("plus")}Ajouter</button>
      </form>
    </details>
  `);
  saasBody.innerHTML = sections.join("");
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
const pilotTiles = document.querySelector("#pilot-tiles");
const pilotPeriodForm = document.querySelector("#pilot-period");
document.querySelector("#refresh-improvement").addEventListener("click", () => refreshImprovement());
pilotPeriodForm.addEventListener("submit", (event) => {
  event.preventDefault();
  refreshPilot();
});

// --- Budgets (Caisse view) ----------------------------------------------------
// The direction's budgets read against the cash book: the month by category,
// each purchase order, and the cash forecast against the minimum. The
// direction sets them here or by telling the Director.
const budgetLines = document.querySelector("#budget-lines");
const budgetSettings = document.querySelector("#budget-settings");
const budgetForm = document.querySelector("#budget-form");
const budgetMonthlyFields = document.querySelector("#budget-monthly-fields");

budgetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = (name) => budgetForm.querySelector(`[name='${name}']`)?.value ?? "";
  const monthly = Object.fromEntries([...budgetMonthlyFields.querySelectorAll("input[data-category]")].map((input) => [input.dataset.category, input.value]));
  const body = { monthly, cashFloor: value("cashFloor") };
  if (value("orderNumber").trim()) {
    body.orders = { [value("orderNumber").trim()]: value("orderBudget") };
  }
  try {
    const response = await fetch("/api/budgets", { method: "PUT", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Les budgets n'ont pas été enregistrés.");
    }
    budgetForm.querySelector("[name='orderNumber']").value = "";
    budgetForm.querySelector("[name='orderBudget']").value = "";
    showToast("Budgets enregistrés : les alertes sont recalculées.");
    renderBudgets(payload);
  } catch (error) {
    showToast(error.message, "warn");
  }
});

async function refreshBudgets() {
  try {
    const response = await fetch("/api/budgets", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger les budgets.");
    }
    renderBudgets(await response.json());
  } catch (error) {
    budgetLines.innerHTML = card("Budgets indisponibles", escapeHtml(error.message), "warning");
  }
}

const MONTH_NAMES = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function budgetRow(label, spent, budget, percent, over, masked = false) {
  const width = Math.min(100, Math.max(0, percent ?? (over ? 100 : 0)));
  return `
    <li class="budget-row ${over ? "is-over" : ""}">
      <div class="budget-row-head"><span>${label}</span><span class="num">${masked ? "réservé à la direction" : `${formatDh(spent)} / ${formatDh(budget)}${percent !== null ? ` · ${String(percent).replace(".", ",")} %` : ""}`}${over ? ` <span class="tag warning">dépassé</span>` : ""}</span></div>
      ${masked ? "" : `<div class="budget-bar" role="presentation"><span style="width:${width}%"></span></div>`}
    </li>`;
}

function renderBudgets({ status, categories, canDecide }) {
  const month = `${MONTH_NAMES[Number(status.month.slice(5, 7)) - 1]} ${status.month.slice(0, 4)}`;
  const parts = [];
  parts.push(status.categories.length > 0
    ? `<h3>Mois de ${escapeHtml(month)}</h3><ul>${status.categories.map((line) => budgetRow(escapeHtml(line.label), line.spent, line.budget, line.percent, line.over, line.masked)).join("")}</ul>`
    : `<p class="muted">Aucun budget mensuel fixé${canDecide ? " : ouvrez « Fixer les budgets » ou dites-le au Director (« budget transport 3 000 DH par mois »)" : ""}.</p>`);
  if (status.orders.length > 0) {
    parts.push(`<h3>Bons de commande</h3><ul>${status.orders.map((line) => budgetRow(`BC n° ${escapeHtml(line.number)}${line.client ? ` · ${escapeHtml(line.client)}` : ""}`, line.spent, line.budget, line.percent, line.over)).join("")}</ul>`);
  }
  const cash = status.cash;
  parts.push(`<h3>Trésorerie</h3><p class="budget-cash ${cash.below ? "is-over" : ""}">${cash.hasBook
    ? `Solde du jour ${formatDh(cash.balance)} · au plus bas ${formatDh(cash.lowest.balance)} le ${formatIsoDay(cash.lowest.day)} sur les ${cash.days} prochains jours · minimum ${cash.floor !== null ? formatDh(cash.floor) : "non fixé (alerte sous zéro)"}${cash.below ? ` <span class="tag warning">insuffisante</span>` : ""}`
    : "Le journal de caisse est vide : pas encore de prévision."}</p>`);
  budgetLines.innerHTML = parts.join("");
  budgetSettings.hidden = !canDecide;
  if (canDecide) {
    const set = Object.fromEntries(status.categories.map((line) => [line.category, line.budget]));
    budgetMonthlyFields.innerHTML = Object.entries(categories).map(([id, label]) => `
      <label>${escapeHtml(label)}<span class="input-unit"><input data-category="${escapeHtml(id)}" type="number" min="0" step="100" inputmode="decimal" value="${set[id] ?? ""}"><small>DH</small></span></label>
    `).join("");
    const floor = budgetForm.querySelector("[name='cashFloor']");
    if (document.activeElement !== floor) {
      floor.value = cash.floor ?? "";
    }
  }
}

// The direction's commercial rules, which the commercial alerts follow.
const commercialRulesForm = document.querySelector("#commercial-rules-form");
const commercialRulesSummary = document.querySelector("#commercial-rules-summary");
const COMMERCIAL_RULE_NAMES = Object.freeze(["validityDays", "maxDiscountPercent", "marginFloorPercent", "confirmationDays"]);
commercialRulesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(COMMERCIAL_RULE_NAMES.map((name) => [name, commercialRulesForm.querySelector(`[name='${name}']`)?.value ?? ""]));
  try {
    const response = await fetch("/api/commercial/rules", { method: "PUT", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Les règles n'ont pas été enregistrées.");
    }
    showToast("Règles commerciales enregistrées : les alertes sont recalculées.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshImprovement();
});

async function refreshCommercialRules() {
  try {
    const response = await fetch("/api/commercial/rules", { headers: await authHeaders() });
    if (!response.ok) {
      return;
    }
    const { rules } = await response.json();
    for (const name of COMMERCIAL_RULE_NAMES) {
      const field = commercialRulesForm.querySelector(`[name='${name}']`);
      if (field && document.activeElement !== field) {
        field.value = Number.isFinite(rules[name]) ? String(rules[name]) : "";
      }
    }
    const set = [
      Number.isFinite(rules.validityDays) ? `devis valable ${rules.validityDays} j` : "",
      Number.isFinite(rules.maxDiscountPercent) ? `remise ≤ ${rules.maxDiscountPercent} %` : "",
      Number.isFinite(rules.marginFloorPercent) ? `marge ≥ ${rules.marginFloorPercent} %` : "",
      Number.isFinite(rules.confirmationDays) ? `acompte sous ${rules.confirmationDays} j` : ""
    ].filter(Boolean);
    commercialRulesSummary.textContent = set.length > 0 ? set.join(" · ") : "aucune règle fixée";
  } catch {
    // The form stays as it is.
  }
}

// What each kind of anomaly is called in the cards.
const ANOMALY_SOURCE_LABELS = Object.freeze({ commercial: "Alerte commerciale", stock: "Alerte de stock", budget: "Alerte budgétaire", planning: "Alerte de planning", rh: "Alerte RH", administratif: "Alerte administrative" });
const ANOMALY_KIND_LABELS = Object.freeze({
  retard: "retard",
  blocage: "blocage",
  reserve_livraison: "réserve à la livraison",
  devis_expire: "devis expiré",
  remise_hors_plafond: "remise hors plafond",
  marge_sous_seuil: "marge sous le seuil",
  ecart_devis_commande: "écart devis / commande",
  client_en_double: "client en double",
  fin_contrat: "fin de contrat",
  fin_essai: "fin de période d'essai",
  formation_a_renouveler: "formation à renouveler",
  donnees_candidats: "données de candidats à effacer",
  echeance_proche: "échéance proche",
  echeance_depassee: "échéance dépassée",
  preavis_contrat: "préavis de contrat",
  fin_contrat_entreprise: "fin de contrat",
  courrier_a_traiter: "courrier à traiter",
  ecart_commande_facture: "écart commande / facture",
  doublon_document: "document en double",
  dossier_incomplet: "dossier incomplet",
  commande_non_confirmee: "commande non confirmée",
  date_promise_intenable: "date promise intenable",
  budget_depasse: "budget dépassé",
  tresorerie_insuffisante: "trésorerie insuffisante",
  stock_sous_minimum: "stock sous le minimum",
  rupture_stock: "rupture de stock"
});

// The pilot's indicators (CDC V2 annex): each tile says what it counts.
async function refreshPilot() {
  const read = (name) => pilotPeriodForm.querySelector(`[name='${name}']`)?.value ?? "";
  const query = new URLSearchParams(Object.entries({ from: read("from"), to: read("to") }).filter(([, value]) => value)).toString();
  try {
    const response = await fetch(`/api/improvement/pilot${query ? `?${query}` : ""}`, { headers: await authHeaders() });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Les indicateurs du pilote n'ont pas pu être calculés.");
    }
    renderPilot(payload.indicators);
  } catch (error) {
    pilotTiles.innerHTML = `<p class="muted text-[13px]">${escapeHtml(error.message)}</p>`;
  }
}

function renderPilot(indicators) {
  const { period, lateOrders, resolution, anomalies, procedures, recurrence, timeSaved, falseAlarms } = indicators;
  const fromField = pilotPeriodForm.querySelector("[name='from']");
  const toField = pilotPeriodForm.querySelector("[name='to']");
  if (fromField && !fromField.value) fromField.value = period.from;
  if (toField && !toField.value) toField.value = period.to;
  const percent = (value) => (value === null ? "—" : `${String(value).replace(".", ",")} %`);
  const plural = (count, word) => `${count} ${word}${count > 1 ? "s" : ""}`;
  const kinds = Object.entries(anomalies.byKind).map(([kind, count]) => `${kind} ${count}`).join(" · ");
  const tiles = [
    ["Commandes en retard", percent(lateOrders.percent), `${lateOrders.late} sur ${plural(lateOrders.worked, "commande")} suivie${lateOrders.worked > 1 ? "s" : ""}${lateOrders.numbers.length > 0 ? ` : BC ${lateOrders.numbers.join(", ")}` : ""}`],
    ["Délai moyen de résolution", resolution.averageDays === null ? "—" : `${String(resolution.averageDays).replace(".", ",")} j`, `${plural(resolution.resolved, "anomalie")} levée${resolution.resolved > 1 ? "s" : ""} · ${resolution.stillOpen} encore ouverte${resolution.stillOpen > 1 ? "s" : ""}`],
    ["Anomalies détectées", String(anomalies.detected), [kinds, anomalies.severe > 0 ? `${anomalies.severe} de gravité haute` : ""].filter(Boolean).join(" · ") || "aucune sur la période"],
    ["Procédures approuvées", percent(procedures.percent), `${procedures.approved} validée${procedures.approved > 1 ? "s" : ""}, ${procedures.refused} refusée${procedures.refused > 1 ? "s" : ""}${procedures.pending > 0 ? `, ${procedures.pending} à valider` : ""}`],
    ["Incidents récurrents", String(recurrence.count), recurrence.count > 0 ? `revenus malgré une règle en vigueur (${percent(recurrence.percent)} des anomalies)` : "aucun retour malgré une règle"],
    ["Temps administratif économisé", timeSaved.hours === null ? plural(timeSaved.missions, "mission") : `${String(timeSaved.hours).replace(".", ",")} h`, timeSaved.minutesPerMission === null ? "missions des agents ; durée gagnée par mission à fixer (HKIDS_PILOT_MINUTES_PER_MISSION)" : `${plural(timeSaved.missions, "mission")} × ${timeSaved.minutesPerMission} min, hypothèse de la direction`],
    ["Fausses alertes", percent(falseAlarms.percent), `${plural(falseAlarms.count, "alerte")} écartée${falseAlarms.count > 1 ? "s" : ""} par la direction`]
  ];
  pilotTiles.innerHTML = tiles.map(([label, value, hint]) => `
    <div class="pilot-tile"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></div>
  `).join("") + `<p class="pilot-foot muted">Du ${escapeHtml(formatIsoDay(period.from))} au ${escapeHtml(formatIsoDay(period.to))} (${period.days} jours).</p>`;
}
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
  const target = event.target.closest?.("[data-rule-decision], [data-analyse], [data-lift], [data-task-move], [data-closure], [data-false-alarm]");
  if (!target) {
    return;
  }
  if (target.dataset.falseAlarm) {
    const note = globalThis.prompt?.("Pourquoi est-ce une fausse alerte ? (ex. : étape finie mais pas cochée)");
    if (!note?.trim()) {
      return;
    }
    await sendImprovementChange(`/api/improvement/anomalies/${target.dataset.falseAlarm}/false-alarm`, { note }, "Fausse alerte notée : elle sort des anomalies et compte dans les indicateurs du pilote.");
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
  refreshPilot();
  refreshCommercialRules();
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
    sections.push(improvementSection(improvementView.filter === "analyse" ? "À analyser" : "Anomalies ouvertes", "Un retard ou un blocage du carnet d'atelier, une alerte commerciale, de stock, budgétaire ou de planning, ou un problème signalé au Director.", listed.map((anomaly) => anomalyCard(anomaly, data.analysis)).join("")));
  }
  if (show("rules") && inForce.length > 0) {
    sections.push(improvementSection("Règles en vigueur", "Données à leur agent, et au Director, à chaque mission.", inForce.map((rule) => ruleCard(rule, anomalyOf)).join("")));
  }
  const past = [...anomalies.filter((anomaly) => !isOpenAnomaly(anomaly)), ...rules.filter((rule) => ["refusee", "retiree"].includes(rule.status))];
  if (improvementView.filter === null && past.length > 0) {
    sections.push(`
      <details class="panel improvement-history">
        <summary><strong>Historique</strong><small>${past.length} élément${past.length > 1 ? "s" : ""} : anomalies levées, règles refusées ou retirées</small></summary>
        <ul>${past.map((entry) => `<li><small>${escapeHtml(formatIsoDay((entry.liftedAt ?? entry.decidedAt ?? "").slice(0, 10)))}</small> ${entry.fact ? `Anomalie n° ${entry.number} ${entry.falseAlarm ? `fausse alerte (${escapeHtml(entry.falseAlarm.note)})` : "levée"} : ${escapeHtml(entry.fact)}` : `Règle n° ${entry.number} « ${escapeHtml(entry.title)} » ${entry.status === "refusee" ? "refusée" : "retirée"}`}</li>`).join("")}</ul>
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
        <span class="eyebrow">${ANOMALY_SOURCE_LABELS[anomaly.source] ?? "Anomalie"} n° ${anomaly.number} · ${escapeHtml(ANOMALY_KIND_LABELS[anomaly.kind] ?? anomaly.kind)} · le ${escapeHtml(formatIsoDay(anomaly.detectedAt.slice(0, 10)))} <span class="tag ${severity === "haute" ? "warning" : ""}">gravité ${escapeHtml(severity)}</span></span>
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
        ${["signalee", "commercial", "stock", "budget", "planning", "rh", "administratif"].includes(anomaly.source) && !anomaly.task ? `<button type="button" class="link-button" data-lift="${anomaly.number}">Marquer réglée</button>` : ""}
        ${isOpenAnomaly(anomaly) && !anomaly.falseAlarm ? `<button type="button" class="link-button" data-false-alarm="${anomaly.number}">Fausse alerte</button>` : ""}
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
const ACTIVITY_LABELS = Object.freeze({ mission: "Mission", caisse: "Caisse", atelier: "Atelier", document: "Document", amelioration: "Amélioration", equipe: "Équipe", compte_rendu: "Compte rendu", alerte: "Alerte", automatisation: "Automatisation", reseaux: "Réseaux" });
const aiUsagePanel = document.querySelector("#ai-usage");
const teamFeed = document.querySelector("#team-feed");
const teamView = { data: null, config: new Map(), open: new Set(), responded: new Set() };
document.querySelector("#refresh-team").addEventListener("click", () => refreshTeam());
agentRoster.addEventListener("submit", async (event) => {
  const settingsForm = event.target.closest?.("[data-agent-settings]");
  if (settingsForm) {
    event.preventDefault();
    await saveAgentSettings(settingsForm);
    return;
  }
  const documentForm = event.target.closest?.("[data-agent-document]");
  if (documentForm) {
    event.preventDefault();
    await uploadAgentDocument(documentForm);
    return;
  }
  const testForm = event.target.closest?.("[data-agent-test]");
  if (testForm) {
    event.preventDefault();
    const read = (name) => testForm.querySelector(`[name='${name}']`)?.value ?? "";
    await agentRequest(`/api/agents/${encodeURIComponent(testForm.dataset.agentTest)}/tests`, { body: { question: read("question"), expected: read("expected"), forbidden: read("forbidden") } }, "Test ajouté.");
    return;
  }
  const formNode = event.target.closest?.("[data-member-form]");
  if (!formNode) {
    return;
  }
  event.preventDefault();
  const read = (name) => formNode.querySelector(`[name='${name}']`)?.value ?? "";
  await saveMember(formNode.dataset.memberForm, { name: read("name"), role: read("role"), phone: read("phone") });
});
// Which settings blocks are open survives a refresh of the cards.
agentRoster.addEventListener("toggle", (event) => {
  const block = event.target.closest?.("[data-settings-of]");
  if (block === event.target) {
    teamView.open[block.open ? "add" : "delete"](block.dataset.settingsOf);
  }
}, true);
agentRoster.addEventListener("click", async (event) => {
  const toggle = event.target.closest?.("[data-agent-active]");
  if (toggle) {
    const on = toggle.dataset.agentActive === "on";
    toggle.disabled = true;
    await agentRequest(`/api/agents/${encodeURIComponent(toggle.dataset.agent)}/active`, { body: { active: on } }, on ? `${formatAgent(toggle.dataset.agent)} rejoint l'équipe : le Director peut lui confier des missions.` : `${formatAgent(toggle.dataset.agent)} est retiré de l'équipe : le Director ne lui confie plus rien.`);
    return;
  }
  const status = event.target.closest?.("[data-document-status]");
  if (status) {
    await agentRequest(`/api/agents/${encodeURIComponent(status.dataset.agent)}/documents/${encodeURIComponent(status.dataset.documentStatus)}/status`, { method: "POST", body: { status: status.dataset.status } }, status.dataset.status === "perime" ? "Document marqué périmé : l'agent ne l'applique plus." : "Document remis en vigueur.");
    return;
  }
  const reading = event.target.closest?.("[data-document-text]");
  if (reading) {
    await showDocumentText(reading.dataset.agent, reading.dataset.documentText);
    return;
  }
  const runTest = event.target.closest?.("[data-test-run]");
  if (runTest) {
    runTest.disabled = true;
    runTest.textContent = "Test en cours…";
    const result = await agentRequest(`/api/agents/${encodeURIComponent(runTest.dataset.agent)}/tests/run`, { body: runTest.dataset.testRun ? { id: runTest.dataset.testRun } : {} });
    if (result?.results) {
      const passed = result.results.filter((test) => test?.lastRun?.passed).length;
      showToast(`${passed} test${passed > 1 ? "s" : ""} réussi${passed > 1 ? "s" : ""} sur ${result.results.length}.`, passed === result.results.length ? undefined : "warn");
    }
    return;
  }
  const removeTest = event.target.closest?.("[data-test-remove]");
  if (removeTest && globalThis.confirm?.("Supprimer ce test ?")) {
    await agentRequest(`/api/agents/${encodeURIComponent(removeTest.dataset.agent)}/tests/${encodeURIComponent(removeTest.dataset.testRemove)}`, { method: "DELETE" }, "Test supprimé.");
    return;
  }
  const forget = event.target.closest?.("[data-memory-forget]");
  if (forget && globalThis.confirm?.("Effacer cette note de la mémoire de l'agent ?")) {
    await agentRequest(`/api/agents/${encodeURIComponent(forget.dataset.agent)}/memory/${encodeURIComponent(forget.dataset.memoryForget)}`, { method: "DELETE" }, "Note effacée.");
    return;
  }
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

const AGENT_TONE_LABELS = Object.freeze({ "": "Par défaut", formel: "Formel", chaleureux: "Chaleureux", concis: "Concis", pedagogique: "Pédagogique" });
const HELD_LABELS = Object.freeze({ en_attente: "en attente", executee: "validée et exécutée", refusee: "refusée", echouee: "validée, en échec" });
const heldPanel = document.querySelector("#held-actions");

// The actions the agents left for the direction's validation (tools set to
// « validation requise » in their settings): what it would do, and two
// buttons. Validated, it runs now; refused, never.
async function refreshHeldActions() {
  try {
    const response = await fetch("/api/agents/held", { headers: await authHeaders() });
    if (!response.ok) {
      heldPanel.hidden = true;
      return;
    }
    renderHeldActions((await response.json()).held ?? []);
  } catch {
    heldPanel.hidden = true;
  }
}

function heldArguments(args) {
  return Object.entries(args ?? {})
    .filter(([, value]) => value !== "" && value !== 0 && value !== false && value !== null && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `<li><small>${escapeHtml(key.replace(/_/g, " "))}</small> ${escapeHtml(Array.isArray(value) ? value.join(", ") : String(value))}</li>`)
    .join("");
}

function renderHeldActions(held) {
  const pending = held.filter((entry) => entry.status === "en_attente");
  const recent = held.filter((entry) => entry.status !== "en_attente").slice(0, 5);
  if (pending.length + recent.length === 0) {
    heldPanel.hidden = true;
    return;
  }
  heldPanel.hidden = false;
  heldPanel.innerHTML = `
    <div class="panel-heading"><div><h2>${icon("shield")}Actions à valider</h2><p class="muted text-[13px]">Les outils réglés sur « validation requise » attendent votre accord avant de s'exécuter.</p></div><span class="tag ${pending.length > 0 ? "warning" : ""}">${pending.length} en attente</span></div>
    ${pending.map((entry) => `
      <article class="rule-card">
        <p><strong>n° ${entry.number} · ${escapeHtml(formatAgent(entry.agent))}</strong> veut utiliser <code>${escapeHtml(entry.tool)}</code> <small>${escapeHtml(formatStamp(entry.at))}</small></p>
        ${entry.mission ? `<p class="muted text-[13px]">Mission : ${escapeHtml(entry.mission)}</p>` : ""}
        <ul class="held-args">${heldArguments(entry.args)}</ul>
        <div class="flex gap-2"><button type="button" data-held="${entry.number}" data-held-decision="valider">${icon("check")}Valider et exécuter</button><button type="button" class="secondary" data-held="${entry.number}" data-held-decision="refuser">${icon("x")}Refuser</button></div>
      </article>`).join("")}
    ${recent.length > 0 ? `<details class="improvement-history"><summary><strong>Dernières décisions</strong></summary><ul>${recent.map((entry) => `<li>n° ${entry.number} ${escapeHtml(formatAgent(entry.agent))} · <code>${escapeHtml(entry.tool)}</code> : ${escapeHtml(HELD_LABELS[entry.status] ?? entry.status)}${entry.status === "echouee" && entry.result?.erreur ? ` — ${escapeHtml(entry.result.erreur)}` : ""}</li>`).join("")}</ul></details>` : ""}
  `;
}

heldPanel.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-held-decision]");
  if (!button) {
    return;
  }
  button.disabled = true;
  try {
    const { action } = await postJson(`/api/agents/held/${button.dataset.held}/decision`, { decision: button.dataset.heldDecision });
    showToast(action.status === "executee" ? "Action validée et exécutée." : action.status === "refusee" ? "Action refusée : elle ne s'exécutera pas." : `Action validée, mais son exécution a échoué : ${action.result?.erreur ?? "voir le fil"}.`, action.status === "echouee" ? "warn" : undefined);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshTeam();
});

async function refreshTeam() {
  try {
    const response = await fetch("/api/team", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger l'équipe.");
    }
    teamView.data = await response.json();
    fillAgentPicker(teamView.data.agents ?? []);
    await Promise.all([loadAgentSettings(), refreshHeldActions()]);
    renderTeam();
  } catch (error) {
    teamFeed.innerHTML = `<li class="muted">${escapeHtml(error.message)}</li>`;
  }
  await Promise.all([refreshAiUsage(), refreshAutomations()]);
}

// --- The direction's automations (CDC section 10.A) --------------------------
// Each rule: an event, optional filters, and one to five actions, now or some
// days later. Built here or said to the Director in words.
const automationsPanel = document.querySelector("#automations");
const automationView = { data: null, draftOpen: false };
// The spec's own example, ready to adjust.
const AUTOMATION_TEMPLATE = Object.freeze({
  name: "Devis accepté : lancer la commande",
  event: "devis_accepte",
  actions: [
    { kind: "informer_agent", agent: "production", text: "BC {numero} ({client}, {montant}) : commande acceptée, à planifier en production.", delayDays: 0 },
    { kind: "mission_agent", agent: "purchasing", text: "Le BC {numero} ({client}) vient d'être accepté : vérifie les matières à commander pour cette commande et dis ce qui manque.", delayDays: 0 },
    { kind: "tache_equipe", agent: "finance", text: "Premier rappel de paiement au client {client} pour le BC {numero} ({montant}).", delayDays: 30, dueDays: 3 }
  ]
});

automationsPanel.addEventListener("click", async (event) => {
  const openOrClose = event.target.closest?.("[data-automation-open], [data-automation-close]");
  if (openOrClose) {
    automationView.draftOpen = openOrClose.matches("[data-automation-open]");
    renderAutomations();
    automationsPanel.querySelector(automationView.draftOpen ? "[data-automation-form] [name='name']" : "[data-automation-open]")?.focus();
    return;
  }
  const toggle = event.target.closest?.("[data-automation-toggle]");
  if (toggle) {
    await automationRequest(`/api/automations/${encodeURIComponent(toggle.dataset.automationToggle)}/active`, { body: { active: toggle.dataset.active === "true" } }, toggle.dataset.active === "true" ? "Règle activée." : "Règle mise en pause ; ses actions en attente sont annulées.");
    return;
  }
  const remove = event.target.closest?.("[data-automation-remove]");
  if (remove && globalThis.confirm?.("Supprimer cette automatisation ? Ses actions en attente sont annulées.")) {
    await automationRequest(`/api/automations/${encodeURIComponent(remove.dataset.automationRemove)}`, { method: "DELETE" }, "Règle supprimée.");
    return;
  }
  const form = automationsPanel.querySelector("[data-automation-form]");
  if (event.target.closest?.("[data-automation-template]")) {
    fillAutomationForm(form, AUTOMATION_TEMPLATE);
    return;
  }
  if (event.target.closest?.("[data-automation-add]")) {
    const list = form.querySelector("[data-automation-actions]");
    if (list.children.length < 5) {
      list.insertAdjacentHTML("beforeend", automationActionRow({ kind: "informer_agent", agent: "", text: "", delayDays: 0 }, list.children.length));
    }
    syncAutomationForm(form);
    return;
  }
  const drop = event.target.closest?.("[data-automation-drop]");
  if (drop) {
    const list = form.querySelector("[data-automation-actions]");
    if (list.children.length > 1) {
      drop.closest("[data-automation-action]").remove();
    }
    syncAutomationForm(form);
  }
});
automationsPanel.addEventListener("change", (event) => {
  const form = event.target.closest?.("[data-automation-form]");
  if (form) {
    syncAutomationForm(form);
  }
});
automationsPanel.addEventListener("submit", async (event) => {
  const form = event.target.closest?.("[data-automation-form]");
  if (!form) {
    return;
  }
  event.preventDefault();
  const read = (node, name) => node.querySelector(`[name='${name}']`)?.value ?? "";
  const body = {
    name: read(form, "name"),
    event: read(form, "event"),
    filters: { minAmount: read(form, "minAmount"), step: read(form, "step"), contains: read(form, "contains") },
    actions: [...form.querySelectorAll("[data-automation-action]")].map((row) => ({
      kind: read(row, "kind"),
      agent: read(row, "agent"),
      text: read(row, "text"),
      delayDays: Number(read(row, "delayDays")) || 0,
      dueDays: Number(read(row, "dueDays")) || 3
    }))
  };
  const created = await automationRequest("/api/automations", { body }, "");
  if (created?.rule) {
    showToast(`Automatisation n° ${created.rule.number} créée : elle se déclenchera à chaque « ${automationEventLabel(created.rule.event).toLowerCase()} ».`);
    automationView.draftOpen = false;
    renderAutomations();
  }
});

async function refreshAutomations() {
  try {
    const response = await fetch("/api/automations", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Les automatisations n'ont pas pu être chargées.");
    }
    automationView.data = await response.json();
    renderAutomations();
  } catch (error) {
    automationsPanel.innerHTML = `<p class="muted text-[13px]">${escapeHtml(error.message)}</p>`;
  }
}

async function automationRequest(url, { method = "POST", body = undefined } = {}, success = "") {
  try {
    const response = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(await authHeaders()) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "La demande a été refusée.");
    }
    if (success) {
      showToast(success);
    }
    await refreshAutomations();
    return payload;
  } catch (error) {
    showToast(error.message, "warn");
    return null;
  }
}

function automationEventLabel(id) {
  return automationView.data?.events?.find((event) => event.id === id)?.label ?? id;
}

function automationAgentLabel(id) {
  return automationView.data?.agents?.find((agent) => agent.id === id)?.label ?? formatAgent(id);
}

function automationDelay(days) {
  return days > 0 ? `${days} jour${days > 1 ? "s" : ""} après` : "aussitôt";
}

function renderAutomations() {
  const data = automationView.data;
  if (!data) {
    return;
  }
  const waiting = (ruleId) => data.queue.filter((entry) => entry.ruleId === ruleId).length;
  const rules = data.rules.length === 0
    ? '<p class="muted text-[13px]">Aucune automatisation. Créez-en une ci-dessous, ou dites-la au Director : « quand un devis est accepté, préviens la production ».</p>'
    : `<ul class="automation-rules">${data.rules.map((rule) => `
      <li class="${rule.active ? "" : "is-paused"}">
        <div class="automation-rule-head">
          <span><strong>n° ${escapeHtml(String(rule.number))} — ${escapeHtml(rule.name)}</strong> <span class="tag ${rule.active ? "ok" : "warning"}">${rule.active ? "active" : "en pause"}</span></span>
          ${data.canEdit ? `<span class="flex flex-wrap gap-2">
            <button type="button" class="link-button" data-automation-toggle="${escapeHtml(rule.id)}" data-active="${rule.active ? "false" : "true"}">${rule.active ? "Mettre en pause" : "Activer"}</button>
            <button type="button" class="link-button" data-automation-remove="${escapeHtml(rule.id)}">Supprimer</button>
          </span>` : ""}
        </div>
        <p><span class="muted">Quand</span> ${escapeHtml(automationEventLabel(rule.event).toLowerCase())}${automationFilters(rule.filters)}</p>
        <ol>${rule.actions.map((action) => `<li><span class="muted">${escapeHtml(automationDelay(action.delayDays))} :</span> ${escapeHtml(data.actions.find((entry) => entry.id === action.kind)?.label ?? action.kind)}${action.agent ? ` — ${escapeHtml(automationAgentLabel(action.agent))}` : ""}<small>${escapeHtml(action.text)}${action.dueDays ? ` (à faire en ${escapeHtml(String(action.dueDays))} j)` : ""}</small></li>`).join("")}</ol>
        <small class="muted">${rule.lastFiredAt ? `Dernier déclenchement ${escapeHtml(formatStamp(rule.lastFiredAt))}` : "Jamais déclenchée"}${waiting(rule.id) > 0 ? ` · ${waiting(rule.id)} action${waiting(rule.id) > 1 ? "s" : ""} en attente de son jour` : ""}</small>
      </li>`).join("")}</ul>`;
  const runs = data.runs.length === 0
    ? '<p class="muted text-[13px]">Rien n\'a encore été exécuté.</p>'
    : `<ul class="automation-runs">${data.runs.slice(0, 15).map((run) => `
      <li><span><span class="tag ${run.ok ? "ok" : "warning"}">${run.ok ? "fait" : run.action === "limite" ? "limite" : "échec"}</span> n° ${escapeHtml(String(run.rule))} — ${escapeHtml(run.text)}</span><small>${escapeHtml(formatStamp(run.at))}${run.agent ? ` · ${escapeHtml(automationAgentLabel(run.agent))}` : ""}${run.detail ? ` · ${escapeHtml(run.detail)}` : ""}</small></li>`).join("")}</ul>`;
  automationsPanel.innerHTML = `
    <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px] [&>*]:min-w-0">
      <div class="flex flex-col gap-4">
        ${rules}
        ${data.canEdit ? automationForm() : '<p class="muted text-[13px]">Seule la direction crée ou modifie une automatisation.</p>'}
      </div>
      <div class="team-block">
        <h4>Dernières exécutions</h4>
        ${runs}
        <p class="muted text-[12px] mt-2!">Une règle s'arrête d'elle-même après ${escapeHtml(String(data.dailyLimit))} déclenchements dans la journée.</p>
      </div>
    </div>`;
  const form = automationsPanel.querySelector("[data-automation-form]");
  if (form) {
    syncAutomationForm(form);
  }
}

function automationFilters(filters = {}) {
  const parts = [
    filters.minAmount ? `à partir de ${formatDh(filters.minAmount)}` : "",
    filters.step ? `étape « ${automationView.data.steps.find((step) => step.id === filters.step)?.label ?? filters.step} »` : "",
    filters.contains ? `contenant « ${filters.contains} »` : ""
  ].filter(Boolean);
  return parts.length > 0 ? ` <span class="muted">(${escapeHtml(parts.join(", "))})</span>` : "";
}

function automationForm() {
  const data = automationView.data;
  if (!automationView.draftOpen) {
    return `<div class="flex flex-wrap gap-2"><button type="button" class="primary" data-automation-open>${icon("plus")}Nouvelle automatisation</button></div>`;
  }
  return `
    <div class="team-block agent-settings automation-draft">
      <div class="automation-rule-head mb-3!"><h4 class="mb-0!">Nouvelle automatisation <small class="muted font-normal">quand … alors …</small></h4><button type="button" class="link-button" data-automation-close>Fermer</button></div>
      <form data-automation-form class="team-edit-form">
        <div class="flex flex-wrap gap-2"><button type="button" class="secondary" data-automation-template>Partir de l'exemple : devis accepté → production, achats, rappel de paiement</button></div>
        <label>Nom<input name="name" maxlength="120" placeholder="Ex. : Devis accepté : lancer la commande"></label>
        <label>Quand<select name="event">${data.events.map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.label)}</option>`).join("")}</select></label>
        <div class="automation-filters">
          <label>Montant minimum (DH)<input name="minAmount" type="number" min="0" step="1" placeholder="tous"></label>
          <label data-automation-step>Étape<select name="step"><option value="">toutes</option>${data.steps.map((step) => `<option value="${escapeHtml(step.id)}">${escapeHtml(step.label)}</option>`).join("")}</select></label>
          <label>Contient le mot<input name="contains" maxlength="80" placeholder="client, objet…"></label>
        </div>
        <p class="muted text-[12px]" data-automation-fields></p>
        <ol class="automation-actions" data-automation-actions>${automationActionRow({ kind: "informer_agent", agent: "", text: "", delayDays: 0 }, 0)}</ol>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="secondary" data-automation-add>${icon("plus")}Ajouter une action</button>
          <button type="submit" class="primary">${icon("check")}Créer l'automatisation</button>
        </div>
      </form>
    </div>`;
}

function automationActionRow(action, index) {
  const data = automationView.data;
  return `
    <li data-automation-action>
      <div class="automation-filters">
        <label>Action ${index + 1}<select name="kind">${data.actions.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === action.kind ? "selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}</select></label>
        <label data-automation-agent>Agent<select name="agent"><option value="">—</option>${data.agents.map((agent) => `<option value="${escapeHtml(agent.id)}" ${agent.id === action.agent ? "selected" : ""}>${escapeHtml(agent.label)}</option>`).join("")}</select></label>
        <label>Délai (jours)<input name="delayDays" type="number" min="0" max="365" step="1" value="${escapeHtml(String(action.delayDays ?? 0))}"></label>
        <label data-automation-due>Échéance (jours)<input name="dueDays" type="number" min="1" max="60" step="1" value="${escapeHtml(String(action.dueDays ?? 3))}"></label>
      </div>
      <label>Texte<textarea name="text" rows="2" maxlength="1000" required placeholder="Ex. : BC {numero} ({client}, {montant}) : commande à planifier.">${escapeHtml(action.text ?? "")}</textarea></label>
      <button type="button" class="link-button" data-automation-drop>Retirer cette action</button>
    </li>`;
}

// Shows what the chosen event lets the texts quote, and only the fields each
// action needs.
function syncAutomationForm(form) {
  const event = automationView.data.events.find((entry) => entry.id === form.querySelector("[name='event']").value);
  form.querySelector("[data-automation-fields]").textContent = event ? `Les textes peuvent citer : ${event.fields.map((field) => `{${field}}`).join(", ")}.` : "";
  form.querySelector("[data-automation-step]").hidden = !["etape_terminee", "etape_bloquee", "retard_atelier"].includes(event?.id);
  const rows = [...form.querySelectorAll("[data-automation-action]")];
  rows.forEach((row, index) => {
    const kind = row.querySelector("[name='kind']").value;
    row.querySelector("[data-automation-agent]").hidden = kind === "prevenir_direction";
    row.querySelector("[data-automation-due]").hidden = kind !== "tache_equipe";
    row.querySelector("[name='kind']").closest("label").firstChild.textContent = `Action ${index + 1}`;
    row.querySelector("[data-automation-drop]").hidden = rows.length === 1;
  });
  form.querySelector("[data-automation-add]").hidden = rows.length >= 5;
}

function fillAutomationForm(form, template) {
  form.querySelector("[name='name']").value = template.name;
  form.querySelector("[name='event']").value = template.event;
  form.querySelector("[data-automation-actions]").innerHTML = template.actions.map((action, index) => automationActionRow(action, index)).join("");
  syncAutomationForm(form);
}

// --- Each agent's settings (CDC section 9) -----------------------------------
// Instructions, tools, reference documents and notes, set by the direction
// without programming.
const DOCUMENT_KINDS = Object.freeze({ pdf: "PDF", word: "Word", excel: "Excel", texte: "Texte" });

async function loadAgentSettings() {
  try {
    const response = await fetch("/api/agents/config", { headers: await authHeaders() });
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    teamView.config = new Map((payload.agents ?? []).map((agent) => [agent.id, agent]));
    teamView.team = payload.team ?? null;
  } catch {
    // The cards show without their settings.
  }
}

async function agentRequest(url, { method = "POST", body = undefined } = {}, success = "") {
  try {
    const response = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(await authHeaders()) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "La demande a été refusée.");
    }
    if (success) {
      showToast(success);
    }
    await loadAgentSettings();
    renderTeam();
    return payload;
  } catch (error) {
    showToast(error.message, "warn");
    return null;
  }
}

async function saveAgentSettings(formNode) {
  const agentId = formNode.dataset.agentSettings;
  const rights = [...formNode.querySelectorAll("select[name='tool-right']")];
  const forbiddenTools = rights.filter((select) => select.value === "interdit").map((select) => select.dataset.tool);
  const heldTools = rights.filter((select) => select.value === "validation").map((select) => select.dataset.tool);
  const instructions = formNode.querySelector("[name='instructions']")?.value ?? "";
  const tone = formNode.querySelector("[name='tone']")?.value ?? "";
  await agentRequest(`/api/agents/${encodeURIComponent(agentId)}/config`, { method: "PUT", body: { instructions, forbiddenTools, heldTools, tone } }, `Réglages de l'agent ${formatAgent(agentId)} enregistrés : ils s'appliquent dès sa prochaine mission.`);
}

async function uploadAgentDocument(formNode) {
  const agentId = formNode.dataset.agentDocument;
  const file = formNode.querySelector("input[type='file']")?.files?.[0];
  if (!file) {
    showToast("Choisissez un fichier.", "warn");
    return;
  }
  const button = formNode.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = file.name.toLowerCase().endsWith(".pdf") ? "Lecture du PDF…" : "Import…";
  try {
    const data = await readAsDataUrl(file);
    const read = (name) => formNode.querySelector(`[name='${name}']`)?.value ?? "";
    const result = await agentRequest(`/api/agents/${encodeURIComponent(agentId)}/documents`, { body: { name: file.name, data, title: read("title"), validFrom: read("validFrom") } });
    if (result?.document) {
      const document = result.document;
      showToast(`« ${document.title} » v${document.version} ajouté${document.replaces ? " ; l'ancienne version est périmée" : ""}${document.truncated ? " (tronqué : document très long)" : ""}.`);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Importer";
  }
}

async function showDocumentText(agentId, documentId) {
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/documents/${encodeURIComponent(documentId)}/text`, { headers: await authHeaders() });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "Texte introuvable.");
    }
    const target = agentRoster.querySelector(`[data-document-reading="${CSS.escape(documentId)}"]`);
    if (target) {
      target.hidden = !target.hidden;
      target.textContent = payload.text;
    }
  } catch (error) {
    showToast(error.message, "warn");
  }
}

// The direction's response tests for an agent: a question, the words the
// answer must contain and those it must not; run on demand in test mode.
function agentTestsBlock(agentId, settings) {
  const id = escapeHtml(agentId);
  const tests = settings.tests ?? [];
  return `
      <div class="agent-tests">
        <h4>Tests de réponses</h4>
        <p class="muted text-[13px]">Une question type et les mots attendus : l'agent répond en mode test (il lit ses données, n'enregistre rien). Chaque lancement interroge l'IA.</p>
        ${tests.length === 0 ? "" : `<ul>${tests.map((test) => `
          <li>
            <span><strong>${escapeHtml(test.question)}</strong>${test.lastRun ? ` <span class="tag ${test.lastRun.passed ? "ok" : "warning"}">${test.lastRun.passed ? "réussi" : "échoué"}</span>` : ' <span class="tag">jamais lancé</span>'}</span>
            <small>${test.expected.length > 0 ? `attendu : ${escapeHtml(test.expected.join(" ; "))}` : ""}${test.forbidden.length > 0 ? `${test.expected.length > 0 ? " · " : ""}interdit : ${escapeHtml(test.forbidden.join(" ; "))}` : ""}${test.lastRun ? ` · ${escapeHtml(formatStamp(test.lastRun.at))}` : ""}</small>
            ${test.lastRun && !test.lastRun.passed ? `<small class="text-danger">${test.lastRun.missing.length > 0 ? `manque : ${escapeHtml(test.lastRun.missing.join(", "))}` : ""}${test.lastRun.found.length > 0 ? ` trouvé : ${escapeHtml(test.lastRun.found.join(", "))}` : ""}</small>` : ""}
            ${test.lastRun ? `<details><summary>Réponse obtenue</summary><p class="text-[13px]">${escapeHtml(test.lastRun.answer).replace(/\n/g, "<br>")}</p></details>` : ""}
            <span class="flex flex-wrap gap-2"><button type="button" class="link-button" data-agent="${id}" data-test-run="${escapeHtml(test.id)}">Lancer</button><button type="button" class="link-button" data-agent="${id}" data-test-remove="${escapeHtml(test.id)}">Supprimer</button></span>
          </li>`).join("")}</ul>
        <div class="flex flex-wrap gap-2"><button type="button" class="secondary" data-agent="${id}" data-test-run="">${icon("check")}Lancer tous les tests</button></div>`}
        <form data-agent-test="${id}" class="team-edit-form">
          <label>Question<input name="question" maxlength="600" placeholder="Ex. : Un client demande une remise de 15 %, que réponds-tu ?" required></label>
          <label>Mots attendus (séparés par ;)<input name="expected" placeholder="Ex. : direction ; validation"></label>
          <label>Mots interdits (séparés par ;)<input name="forbidden" placeholder="Ex. : accordée"></label>
          <div class="flex flex-wrap gap-2"><button type="submit" class="secondary">Ajouter le test</button></div>
        </form>
      </div>`;
}

function agentSettingsBlock(agentId) {
  const settings = teamView.config.get(agentId);
  if (!settings) {
    return "";
  }
  const current = settings.documents.filter((entry) => entry.status === "en_vigueur").length;
  const forbidden = settings.tools.filter((tool) => tool.forbidden).length;
  const held = settings.tools.filter((tool) => tool.held).length;
  const summary = [`${current} document${current > 1 ? "s" : ""}`, settings.instructions ? "consignes" : "", settings.tone ? `ton ${AGENT_TONE_LABELS[settings.tone]?.toLowerCase() ?? settings.tone}` : "", forbidden > 0 ? `${forbidden} outil${forbidden > 1 ? "s" : ""} retiré${forbidden > 1 ? "s" : ""}` : "", held > 0 ? `${held} sous validation` : "", settings.memory.length > 0 ? `${settings.memory.length} note${settings.memory.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  const kpi = settings.indicators;
  const id = escapeHtml(agentId);
  return `
    <details class="team-block agent-settings" data-settings-of="${id}" ${teamView.open.has(agentId) ? "open" : ""}>
      <summary><h4>Réglages de l'agent</h4><small class="muted">${escapeHtml(summary)}</small></summary>
      ${kpi ? `<ul class="agent-kpis" aria-label="Indicateurs sur 30 jours">
        <li><strong>${kpi.missions}</strong><small>missions (30 j)</small></li>
        <li><strong>${kpi.actions}</strong><small>actions notées</small></li>
        <li><strong>${kpi.anomaliesOpen}</strong><small>anomalies ouvertes</small></li>
        <li><strong>${kpi.anomaliesLifted}</strong><small>levées (30 j)</small></li>
        <li><strong>${kpi.heldPending}</strong><small>à valider</small></li>
        <li><strong>${kpi.tests.run > 0 ? `${kpi.tests.passed}/${kpi.tests.run}` : "—"}</strong><small>tests réussis</small></li>
      </ul>` : ""}
      <form data-agent-settings="${id}" class="team-edit-form">
        <label>Consignes de la direction
          <textarea name="instructions" rows="4" maxlength="4000" placeholder="Ex. : toujours proposer la livraison et le montage ; vouvoyer le client ; jamais de remise au-delà de 5 % sans accord.">${escapeHtml(settings.instructions)}</textarea>
        </label>
        <label>Ton des réponses
          <select name="tone">${Object.entries(AGENT_TONE_LABELS).map(([value, label]) => `<option value="${value}" ${(settings.tone ?? "") === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>
        </label>
        <fieldset class="agent-tools">
          <legend>Outils : autorisé, validation requise (l'action attend votre accord) ou interdit</legend>
          ${settings.tools.length === 0 ? '<p class="muted text-[13px]">Liste indisponible pour le moment.</p>' : settings.tools.map((tool) => `
            <div class="agent-tool" title="${escapeHtml(tool.description)}">
              ${tool.locked ? '<span class="tag">toujours</span>' : `<select name="tool-right" data-tool="${escapeHtml(tool.name)}" aria-label="Droit sur ${escapeHtml(tool.name)}">
                <option value="autorise" ${!tool.forbidden && !tool.held ? "selected" : ""}>Autorisé</option>
                ${tool.holdable ? `<option value="validation" ${tool.held ? "selected" : ""}>Validation requise</option>` : ""}
                <option value="interdit" ${tool.forbidden ? "selected" : ""}>Interdit</option>
              </select>`}
              <span><code>${escapeHtml(tool.name)}</code><small>${escapeHtml(tool.description)}${tool.locked ? " (toujours actif)" : ""}</small></span>
            </div>`).join("")}
        </fieldset>
        <div class="flex flex-wrap gap-2"><button type="submit" class="primary">${icon("check")}Enregistrer les réglages</button></div>
      </form>
      ${agentTestsBlock(agentId, settings)}
      <div class="agent-documents">
        <h4>Documents de référence</h4>
        ${settings.documents.length === 0 ? '<p class="muted text-[13px]">Aucun document : l\'agent ne s\'appuie que sur ses données.</p>' : `<ul>${settings.documents.map((entry) => `
          <li class="${entry.status === "perime" ? "is-retired" : ""}">
            <span><strong>${escapeHtml(entry.title)}</strong> v${escapeHtml(String(entry.version))} <span class="tag ${entry.status === "en_vigueur" ? "ok" : "warning"}">${entry.status === "en_vigueur" ? "en vigueur" : "périmé"}</span></span>
            <small>${escapeHtml(DOCUMENT_KINDS[entry.kind] ?? entry.kind)} · ${escapeHtml(entry.fileName || "")} · ${escapeHtml(Number(entry.chars).toLocaleString("fr-FR"))} caractères${entry.validFrom ? ` · en vigueur depuis le ${escapeHtml(formatIsoDay(entry.validFrom))}` : ""} · importé ${escapeHtml(formatStamp(entry.importedAt))}</small>
            <span class="flex flex-wrap gap-2">
              <button type="button" class="link-button" data-agent="${id}" data-document-text="${escapeHtml(entry.id)}">Voir ce que l'agent lit</button>
              <button type="button" class="link-button" data-agent="${id}" data-document-status="${escapeHtml(entry.id)}" data-status="${entry.status === "en_vigueur" ? "perime" : "en_vigueur"}">${entry.status === "en_vigueur" ? "Marquer périmé" : "Remettre en vigueur"}</button>
            </span>
            <pre class="document-reading" data-document-reading="${escapeHtml(entry.id)}" hidden></pre>
          </li>`).join("")}</ul>`}
        <form data-agent-document="${id}" class="team-edit-form">
          <label>Fichier (PDF, Word, Excel, texte)<input type="file" accept=".pdf,.docx,.xlsx,.txt,.csv,.md" required></label>
          <label>Titre<input name="title" placeholder="Ex. : Grille tarifaire 2026 (même titre = nouvelle version)"></label>
          <label>En vigueur depuis<input name="validFrom" type="date"></label>
          <div class="flex flex-wrap gap-2"><button type="submit" class="secondary">Importer</button></div>
        </form>
      </div>
      <div class="agent-memory">
        <h4>Mémoire de travail</h4>
        ${settings.memory.length === 0 ? '<p class="muted text-[13px]">Aucune note. L\'agent en garde quand une information doit servir à ses prochaines missions.</p>' : `<ul>${settings.memory.map((note) => `
          <li><span>${escapeHtml(note.text)}</span><small>${escapeHtml(formatStamp(note.at))} · <button type="button" class="link-button" data-agent="${id}" data-memory-forget="${escapeHtml(note.id)}">Effacer</button></small></li>`).join("")}</ul>`}
      </div>
    </details>
  `;
}

// What the AI cost this month: the total, the budget when one is set, and
// each agent's share. An estimate; OpenAI's invoice is the reference.
async function refreshAiUsage() {
  try {
    const headers = await authHeaders();
    const [response, companyResponse] = await Promise.all([fetch("/api/ai-usage", { headers }), fetch("/api/company", { headers }).catch(() => null)]);
    if (!response.ok) {
      throw new Error("Le coût de l'IA n'a pas pu être chargé.");
    }
    renderAiUsage(await response.json());
    // The subscription of this cockpit, when it has one (not the pilot).
    const plan = companyResponse?.ok ? (await companyResponse.json()).plan : null;
    if (plan) {
      const seats = plan.maxUsers ? `${plan.usersUsed ?? "?"} / ${plan.maxUsers} utilisateurs` : "utilisateurs illimités";
      aiUsagePanel.insertAdjacentHTML("afterbegin", `<p class="progress-label mb-2!"><span class="tag ok">Offre ${escapeHtml(plan.label)}</span> ${escapeHtml(seats)}${plan.aiBudgetUsd ? ` · budget IA inclus ${escapeHtml(String(plan.aiBudgetUsd))} $ / mois` : ""}</p>`);
    }
  } catch (error) {
    aiUsagePanel.innerHTML = `<p class="muted text-[13px]">${escapeHtml(error.message)}</p>`;
  }
}

function renderAiUsage(usage) {
  const dollars = (value) => `${Number(value).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  const agentName = (id) => (id === "transcription" ? "Vocaux WhatsApp" : id === "director" ? "Director" : formatAgent(id));
  if (usage.calls === 0) {
    aiUsagePanel.innerHTML = '<p class="muted text-[13px]">Aucun appel au modèle ce mois-ci. Chaque question posée au Director sera comptée ici.</p>';
    return;
  }
  const budget = usage.budget;
  aiUsagePanel.innerHTML = `
    <p class="text-[22px] font-semibold text-ink">${escapeHtml(dollars(usage.costUsd))}${usage.costMad === null ? "" : ` <small class="muted text-[13px] font-normal">≈ ${escapeHtml(formatDh(usage.costMad))}</small>`}</p>
    <p class="progress-label">${escapeHtml(String(usage.calls))} appel${usage.calls > 1 ? "s" : ""} au modèle${usage.projectedUsd === null ? "" : ` · au rythme actuel, ${escapeHtml(dollars(usage.projectedUsd))} en fin de mois`}</p>
    ${budget ? `
      <div class="progress" role="img" aria-label="Budget consommé à ${escapeHtml(String(budget.usedPercent))} %"><span style="width:${Math.min(100, Math.max(0, budget.usedPercent))}%"></span></div>
      <p class="progress-label ${budget.reached ? "late" : ""}">${escapeHtml(String(budget.usedPercent))} % du budget de ${escapeHtml(dollars(budget.usd))}${budget.reached ? (budget.stops ? " : atteint, le Director est à l'arrêt" : " : atteint") : ` · reste ${escapeHtml(dollars(budget.remainingUsd))}`}</p>` : '<p class="progress-label">Aucun budget mensuel fixé (HKIDS_AI_BUDGET_USD).</p>'}
    ${usage.unpricedCalls > 0 ? `<p class="progress-label late">${escapeHtml(String(usage.unpricedCalls))} appel(s) sur un modèle sans tarif connu : comptés, non chiffrés (HKIDS_AI_PRICES).</p>` : ""}
    <h4 class="mt-4!">Par agent</h4>
    <ul>${usage.byAgent.map((line) => `<li><span>${escapeHtml(agentName(line.agent))} — ${escapeHtml(dollars(line.costUsd))}</span><small>${escapeHtml(String(line.calls))} appel${line.calls > 1 ? "s" : ""} · ${escapeHtml(Math.round((line.input + line.output) / 1000).toLocaleString("fr-FR"))} k jetons</small></li>`).join("")}</ul>
  `;
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
  // The company's team first, then the agents its plan can still open.
  const team = teamView.team;
  const isOn = (id) => !team || team.active.includes(id);
  agentRoster.innerHTML = [...agents.filter((agent) => isOn(agent.id)), ...agents.filter((agent) => !isOn(agent.id))].map((agent) => teamCard(agent)).join("");
  renderTeamPlan();
  const feed = teamView.data?.activity ?? [];
  teamFeed.innerHTML = feed.length > 0
    ? feed.map((entry) => feedLine(entry)).join("")
    : '<li class="muted text-[13px]">Rien encore. Chaque mission, mouvement de caisse ou étape d\'atelier s\'inscrira ici.</li>';
}

// The company's template and what its plan opens, above the cards.
function renderTeamPlan() {
  const node = teamPlanNode;
  const team = teamView.team;
  if (!node) {
    return;
  }
  node.hidden = !team;
  if (!team) {
    return;
  }
  const limit = team.max ? `${team.active.length} / ${team.max} agents de l'offre ${team.plan.label}` : `${team.active.length} agent${team.active.length > 1 ? "s" : ""} actif${team.active.length > 1 ? "s" : ""}`;
  const opens = !team.plan ? "tous les agents" : team.plan.id === "enterprise" ? "tous les agents (offre Enterprise)" : team.plan.id === "starter" ? "les agents essentiels du modèle" : "toute l'équipe du modèle";
  node.innerHTML = `<span class="tag info">Modèle : ${escapeHtml(team.templateLabel)}</span> ${escapeHtml(limit)} · votre offre ouvre ${escapeHtml(opens)}.`;
}

// Turning an agent on or off: what the plan opens, the rest greyed with why.
function teamToggle(agentId) {
  const team = teamView.team;
  if (!team) {
    return "";
  }
  const id = escapeHtml(agentId);
  if (team.active.includes(agentId)) {
    return `<button type="button" class="link-button" data-agent="${id}" data-agent-active="off">Retirer de l'équipe</button>`;
  }
  if (!team.allowed.includes(agentId)) {
    const why = team.plan?.id === "starter" ? "Compris dans l'offre Business" : "Compris dans l'offre Enterprise";
    return `<span class="tag" title="${escapeHtml(why)}">${escapeHtml(why)}</span>`;
  }
  return `<button type="button" class="secondary" data-agent="${id}" data-agent-active="on">${icon("plus")}Activer</button>`;
}

function teamCard(agent) {
  const roster = AGENT_ROSTER.find((entry) => entry.id === agent.id);
  const member = agent.member;
  const canSend = Boolean(member?.phone) && agent.missions.length > 0;
  const off = Boolean(teamView.team) && !teamView.team.active.includes(agent.id);
  if (off) {
    return `
      <article class="team-card is-off">
        <header>
          ${avatar(agent.id, "lg")}
          <div class="min-w-0 flex-1">
            <h3>${escapeHtml(agent.label)} <span class="tag">hors équipe</span></h3>
            <p>${escapeHtml(agent.mission)}</p>
            ${roster?.parent ? `<small class="muted">↳ sous ${escapeHtml(roster.parent)}</small>` : ""}
          </div>
          ${teamToggle(agent.id)}
        </header>
      </article>
    `;
  }
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
        ${teamView.team && (teamView.team.plan || teamView.team.active.length < teamView.team.allowed.length) ? teamToggle(agent.id) : ""}
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
      ${agentSettingsBlock(agent.id)}
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
    // Outside the 24-hour window the approved template went instead: the
    // message leaves as soon as the person answers it.
    if (body.message?.status === "waiting") {
      showToast(`${recipient || "La personne"} n'a pas écrit depuis plus de 24 h : un message WhatsApp l'invite à répondre, et le vôtre partira dès sa réponse.`);
      return { ok: true, waiting: true };
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
            <small>${escapeHtml(formatStamp(message.at))}${message.transcribed ? " · vocal transcrit" : ""}${message.direction === "out" ? ` · ${escapeHtml(message.by === "director" ? "Director" : message.by ?? "")}` : ""}${message.status === "failed" ? ` · non parti : ${escapeHtml(message.error ?? "")}` : ""}${message.status === "waiting" ? " · en attente : part dès sa réponse au modèle WhatsApp" : ""}</small>
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

// --- Charge de l'atelier (Commandes view) ---------------------------------------
// The schedule of the open orders from the direction's step durations, and
// whether each promised delivery holds. The direction sets the durations.
const capacityLines = document.querySelector("#capacity-lines");
const capacitySettings = document.querySelector("#capacity-settings");
const capacityForm = document.querySelector("#capacity-form");
const capacityFields = document.querySelector("#capacity-fields");

capacityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const steps = Object.fromEntries([...capacityFields.querySelectorAll("[data-step]")].map((row) => [row.dataset.step, {
    days: row.querySelector("[name='days']").value,
    parallel: row.querySelector("[name='parallel']").value
  }]));
  try {
    const response = await fetch("/api/workshop-capacity", { method: "PUT", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ steps }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Les durées n'ont pas été enregistrées.");
    }
    showToast("Durées enregistrées : les dates promises sont recalculées.");
    renderCapacity(payload);
  } catch (error) {
    showToast(error.message, "warn");
  }
});

async function refreshCapacity() {
  try {
    const response = await fetch("/api/workshop-capacity", { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Impossible de charger la charge de l'atelier.");
    }
    renderCapacity(await response.json());
  } catch (error) {
    capacityLines.innerHTML = card("Charge de l'atelier indisponible", escapeHtml(error.message), "warning");
  }
}

const CAPACITY_VERDICTS = Object.freeze({ tenable: ["tenable", ""], intenable: ["intenable", "warning"], sans_date: ["pas de date promise", ""], inconnu: ["non estimable", ""] });

function renderCapacity({ settings, schedule, steps, canDecide }) {
  if (!schedule.configured) {
    capacityLines.innerHTML = `<p class="muted">Aucune durée d'étape fixée : l'atelier ne peut pas encore être planifié.${canDecide ? " Ouvrez « Durée des étapes » ci-dessous, ou dites-le au Director (« l'assemblage prend 3 jours, deux commandes à la fois »)." : ""}</p>`;
  } else if (schedule.orders.length === 0) {
    capacityLines.innerHTML = `<p class="muted">Aucune commande en cours.</p>`;
  } else {
    capacityLines.innerHTML = `<div class="answer-table"><table><thead><tr><th>BC</th><th>Client</th><th>Promise le</th><th>Fin estimée</th><th>Date promise</th></tr></thead><tbody>${schedule.orders.map((entry) => {
      const [label, tone] = CAPACITY_VERDICTS[entry.verdict];
      return `<tr><td>n° ${escapeHtml(entry.number)}</td><td>${escapeHtml(entry.client || "—")}</td><td class="num">${entry.promised ? formatIsoDay(entry.promised) : "—"}</td><td class="num">${entry.end ? formatIsoDay(entry.end) : "—"}</td><td><span class="tag ${tone}">${escapeHtml(label)}${entry.verdict === "intenable" ? ` · ${entry.lateBy} j de trop` : ""}</span>${entry.verdict === "inconnu" ? ` <small class="muted">durée manquante : ${escapeHtml(entry.missing.join(", "))}</small>` : ""}${entry.blocked ? ` <small class="muted">étape bloquée supposée relancée aujourd'hui</small>` : ""}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }
  capacitySettings.hidden = !canDecide;
  if (canDecide && !capacitySettings.contains(document.activeElement)) {
    capacityFields.innerHTML = Object.entries(steps).map(([id, label]) => {
      const value = settings.steps?.[id];
      return `<div class="capacity-row" data-step="${escapeHtml(id)}"><span>${escapeHtml(label)}</span><label><span class="input-unit"><input name="days" type="number" min="1" max="120" step="1" inputmode="numeric" value="${value?.days ?? ""}" aria-label="Jours ouvrables pour ${escapeHtml(label)}"><small>jours</small></span></label><label><span class="input-unit"><input name="parallel" type="number" min="1" max="20" step="1" inputmode="numeric" value="${value?.parallel ?? ""}" placeholder="1" aria-label="Commandes en même temps pour ${escapeHtml(label)}"><small>en même temps</small></span></label></div>`;
    }).join("");
  }
}

async function refreshOrders() {
  refreshCapacity();
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
    article.querySelector("[data-technical-upload]")?.addEventListener("change", async (event) => {
      try {
        const file = event.currentTarget.files?.[0];
        if (!file) return;
        const result = await postJson(`/api/workshop/${encodeURIComponent(number)}/technical-sheet`, { sheet: JSON.parse(await file.text()) });
        if (!result.ok) throw new Error((result.questions ?? []).join("\n"));
        showToast("Fiche technique préparée, à valider.");
      } catch (error) { showToast(error.message, "warn"); }
      await refreshOrders();
    });
    article.querySelectorAll("[data-technical-decide]").forEach((button) => button.addEventListener("click", async () => {
      const decision = button.dataset.technicalDecide;
      const reason = decision === "refuser" ? globalThis.prompt?.("Quelle correction faut-il apporter à la fiche technique ?") ?? "" : "";
      if (decision === "refuser" && !reason.trim()) return;
      if (decision === "valider" && !globalThis.confirm?.("Valider cette version de la fiche technique pour préparer le dossier de fabrication ?")) return;
      try {
        await postJson(`/api/workshop/${encodeURIComponent(number)}/technical-sheet/${encodeURIComponent(button.dataset.sheetId)}/decision`, { decision, reason });
        showToast("Décision enregistrée sur la fiche technique.");
      } catch (error) { showToast(error.message, "warn"); }
      await refreshOrders();
    }));
    article.querySelector("[data-fabrication-prepare]")?.addEventListener("click", async () => {
      try {
        await postJson(`/api/workshop/${encodeURIComponent(number)}/fabrication`, {});
        showToast("Dossier de fabrication enregistré.");
      } catch (error) { showToast(error.message, "warn"); }
      await refreshOrders();
    });
    article.querySelectorAll("[data-fabrication-download]").forEach((button) => button.addEventListener("click", () => downloadCncFile(number, button.dataset.fabricationDownload, button.dataset.fileName, "fabrication/files")));
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
    article.querySelectorAll("[data-signed-download]").forEach((button) => {
      button.addEventListener("click", () => downloadSignedNote(number, button.dataset.signedDownload, button.dataset.signedName));
    });
    article.querySelector("[data-reserve-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const said = form.elements.text.value.trim();
      if (said.length < 3) {
        showToast("Écrivez la réserve : ce qui manque, ce qui est abîmé ou ce qui ne va pas.", "warn");
        return;
      }
      await sendReserve(number, { text: said, deliveryNote: form.elements.deliveryNote?.value ?? "" });
    });
    article.querySelectorAll("[data-reserve-lift]").forEach((button) => {
      button.addEventListener("click", async () => {
        const note = globalThis.prompt?.("Qu'est-ce qui a été fait pour lever cette réserve ? (pièce remplacée, retouche, livraison complétée…)") ?? "";
        if (note.trim()) {
          await liftReserve(number, button.dataset.reserveLift, note.trim());
        }
      });
    });
    article.querySelectorAll("[data-cnc-decide]").forEach((button) => {
      button.addEventListener("click", async () => {
        const approve = button.dataset.cncDecide === "valider";
        const reason = approve ? "" : globalThis.prompt?.("Pourquoi ce fichier est-il refusé ? Le dessinateur le lira pour le corriger.") ?? "";
        const workshopValidation = approve && button.dataset.cncFormat === "gcode" ? globalThis.prompt?.("Responsable atelier : indiquez les contrôles effectués (simulation, outils, origines, fixation) avant autorisation d'utilisation.") ?? "" : "";
        if (approve && button.dataset.cncFormat === "gcode" && !workshopValidation.trim()) return;
        if (approve ? !globalThis.confirm?.(button.dataset.cncFormat === "dxf" ? "Valider ce DXF pour permettre la préparation du G-code ?" : "Valider ce G-code simulé pour utilisation à l'atelier ?") : reason.trim() === "") {
          return;
        }
        await decideCncFile(number, button.dataset.cncId, approve ? "valider" : "refuser", reason, workshopValidation);
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
        ${manufacturingDossier(order)}
        ${clientAccess(order)}
        ${deliveryReserves(order)}
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
          ? "L'agent méthodes prépare les DXF des pièces CNC. Le directeur de production vous les présente pour validation ; le G-code est ensuite généré, simulé et soumis au responsable atelier."
          : "Validez la fiche technique globale, puis préparez le dossier de fabrication. Les DXF sont validés avant toute génération de G-code."}</p>
        <ul>
          ${order.cnc.map((file) => {
            const [tone, label] = CNC_STATUS_TAGS[file.status] ?? ["", file.status];
            return `
            <li>
              <span class="cnc-icon">${icon("file")}</span>
              <div>
                <strong>${escapeHtml(file.name)}</strong> <span class="tag ${file.obsolete ? "warning" : tone}">${file.obsolete ? "obsolète — archive" : escapeHtml(label)}</span>
                <small>${file.format === "gcode" ? "G-code" : "DXF"} · ${escapeHtml(formatBytes(file.size))} · déposé le ${escapeHtml(formatIsoDay(file.depositedAt.slice(0, 10)))}${file.decidedBy ? ` · ${escapeHtml(label)} par ${escapeHtml(file.decidedBy)}` : ""}</small>
                ${file.note ? `<small>${escapeHtml(file.note)}</small>` : ""}
                ${file.reason ? `<small class="block">Refusé : ${escapeHtml(file.reason)}</small>` : ""}
              </div>
              <div class="cnc-actions">
                <button type="button" class="link-button" data-cnc-download="${escapeHtml(file.id)}" data-cnc-name="${escapeHtml(file.name)}">Télécharger</button>
                ${file.status === "a_valider" && !file.obsolete ? `
                  <button type="button" class="secondary" data-cnc-decide="valider" data-cnc-format="${escapeHtml(file.format)}" data-cnc-id="${escapeHtml(file.id)}">${icon("check")}${file.format === "dxf" ? "Valider le DXF" : "Validation atelier"}</button>
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

function manufacturingDossier(order) {
  const sheets = order.technicalSheets ?? [];
  const current = sheets.at(-1);
  const dossiers = order.fabricationDossiers ?? [];
  const downloads = (item) => `<ul>${item.files.map((file) => `<li><button type="button" class="link-button" data-fabrication-download="${escapeHtml(file.id)}" data-file-name="${escapeHtml(file.name)}">${escapeHtml(file.name)}</button></li>`).join("")}</ul>`;
  return orderPanel(order, "fabrication", `${icon("file")}<span>Dossier de fabrication</span><small>${current ? `Fiche technique v${current.version}` : "Fiche technique à fournir"}</small>`, `
    <p>Production coordonne le dessinateur 2D/3D et le dessinateur méthodes. Chaque poste reçoit ses fiches d'opération, rattachées à cette commande et à la version de sa fiche technique.</p>
    <p>Transmettez votre fiche au Director ou importez sa version structurée : <label class="link-button">Importer une fiche technique JSON<input class="visually-hidden" type="file" accept=".json,application/json" data-technical-upload></label></p>
    ${sheets.map((sheet) => `<section><h4>Fiche technique v${sheet.version} · ${escapeHtml(sheet.data.title)} · ${escapeHtml(sheet.status)}${sheet.id !== current.id ? " · archive" : ""}</h4>${downloads(sheet)}${sheet.id === current.id && sheet.status === "a_valider" ? `<button type="button" class="secondary" data-technical-decide="valider" data-sheet-id="${escapeHtml(sheet.id)}">Valider la fiche technique</button> <button type="button" class="link-button" data-technical-decide="refuser" data-sheet-id="${escapeHtml(sheet.id)}">Demander une correction</button>` : ""}${sheet.reason ? `<p>${escapeHtml(sheet.reason)}</p>` : ""}</section>`).join("")}
    ${current?.status === "valide" ? `<button type="button" class="secondary" data-fabrication-prepare>Préparer le dossier de fabrication</button>` : ""}
    ${dossiers.map((dossier) => `<section><h4>Dossier v${dossier.version} · Fiche technique v${dossier.technicalSheetVersion}${dossier.technicalSheetId !== current?.id ? " · archive" : ""}</h4><p>${dossier.operations.length} fiche(s) d'opération</p><ul>${dossier.operations.map((op) => `<li><strong>${escapeHtml(op.id)}</strong> · ${escapeHtml(op.part)} × ${op.quantity} · ${escapeHtml(op.machine)} · ordre ${op.sequence}<p>${escapeHtml(op.instructions)}</p></li>`).join("")}</ul>${downloads(dossier)}</section>`).join("")}
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
    const order = workshopView.orders.find((entry) => entry.number === number);
    await postJson(`/api/workshop/${encodeURIComponent(number)}/cnc`, { name: file.name, content: await readAsDataUrl(file), note: note ?? "", technicalSheetId: order?.technicalSheets?.at(-1)?.id, dossierId: order?.fabricationDossiers?.at(-1)?.id });
    showToast("Fichier CNC déposé : il attend la validation de la direction.");
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

async function decideCncFile(number, id, decision, reason, workshopValidation = "") {
  try {
    await postJson(`/api/workshop/${encodeURIComponent(number)}/cnc/${encodeURIComponent(id)}/decision`, { decision, reason, workshopValidation });
    showToast(decision === "valider" ? "Validation enregistrée sur cette version du fichier." : "Fichier refusé : le dessinateur verra pourquoi.");
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
      ${emailView.configured ? `<details class="mail-send register-mail">
        <summary>${icon("send")}Envoyer par e-mail</summary>
        <form data-email-form data-document="${escapeHtml(entry.stem)}" data-recipient="${escapeHtml(entry.client || "")}" data-kind="document">
          <label>Adresse e-mail<input name="to" type="email" required placeholder="client@exemple.ma"></label>
          <label>Objet<input name="subject" required maxlength="200" value="${escapeHtml(`${entry.typeLabel} n° ${entry.number} — ${companyName()}`)}"></label>
          <label>Message<textarea name="message" rows="5" required>${escapeHtml(`Bonjour,\n\nVeuillez trouver ci-joint notre ${String(entry.typeLabel).toLowerCase()} n° ${entry.number}.\n\nCordialement,\n${companyName()}`)}</textarea></label>
          <button type="submit" class="secondary">${icon("send")}Envoyer avec le PDF</button>
        </form>
      </details>` : ""}
    </li>
  `;
}

// The company's e-mail: whether its mail server is set, and from which address.
const emailView = { configured: false, from: null, company: null };

async function refreshEmail() {
  try {
    const response = await fetch("/api/email", { headers: await authHeaders() });
    const data = response.ok ? await response.json() : {};
    emailView.configured = data.configured === true;
    emailView.from = data.from ?? null;
    emailView.company = data.company ?? null;
  } catch {
    emailView.configured = false;
  }
}

function companyName() {
  return emailView.company ?? "H-KIDS";
}

// Every e-mail form, wherever it is drawn: a message drafted by an agent (its
// text is the card's) or a document of the register (its PDF is joined).
document.body?.addEventListener?.("submit", async (event) => {
  const form = event.target.closest?.("[data-email-form]");
  if (!form) {
    return;
  }
  event.preventDefault();
  const message = form.elements.message?.value ?? form.closest(".msg-card")?.querySelector(".msg-text")?.value ?? "";
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const { message: sent } = await postJson("/api/email/send", {
      to: form.elements.to.value.trim(),
      subject: form.elements.subject.value.trim(),
      message,
      recipient: form.dataset.recipient ?? "",
      kind: form.dataset.kind ?? "autre",
      documents: form.dataset.document ? [form.dataset.document] : []
    });
    showToast(`E-mail envoyé à ${sent.to}${sent.documents.length ? ` avec ${sent.documents.join(", ")}` : ""}.`);
    form.closest("details")?.removeAttribute("open");
  } catch (error) {
    showToast(error.message, "warn");
  } finally {
    button.disabled = false;
  }
});

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
        <div><strong>${escapeHtml(file.title)}</strong><span>${file.label ? escapeHtml(file.label) : `Fichier Excel · ${escapeHtml(String(file.rows))} ligne${file.rows > 1 ? "s" : ""}`}${file.file ? ` · aussi rangé dans ${escapeHtml(file.file)}` : ""}</span></div>
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

// The delivery note the client signed on their link, with its signature page.
async function downloadSignedNote(number, id, name) {
  try {
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/signatures/${encodeURIComponent(id)}/pdf`, { headers: await authHeaders() });
    if (!response.ok) {
      throw new Error("Bon de livraison signé introuvable.");
    }
    saveBlob(await response.blob(), name || "bon-de-livraison-signe.pdf");
  } catch (error) {
    showToast(error.message, "warn");
  }
}

// The file needs the session token, so it is fetched, then saved from memory.
async function downloadCncFile(number, id, name, section = "cnc") {
  try {
    const response = await fetch(`/api/workshop/${encodeURIComponent(number)}/${section}/${encodeURIComponent(id)}`, { headers: await authHeaders() });
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

// The réserves of the delivery: the client's, written when signing the
// delivery note on their link, and the team's, for words given another way.
// An open one is the SAV's until the team lifts it, saying what was done.
function deliveryReserves(order) {
  const reserves = order.reserves ?? [];
  if (reserves.length === 0 && order.deliveryNotes.length === 0) {
    return "";
  }
  const open = reserves.filter((reserve) => reserve.status === "ouverte").length;
  const summary = `${icon("alert")}<span>Réserves de livraison</span>${open > 0 ? `<span class="tag warning">${open} ouverte${open > 1 ? "s" : ""}</span>` : ""}<small>${reserves.length === 0 ? "aucune" : `${reserves.length} au total`}</small>`;
  return orderPanel(order, "reserves", summary, `
    ${reserves.length > 0 ? `<ul class="reserve-list">
      ${reserves.map((reserve) => `<li class="reserve-${reserve.status}">
        <span class="eyebrow">Réserve n° ${reserve.number}${reserve.deliveryNote ? ` · bon de livraison n° ${escapeHtml(reserve.deliveryNote)}` : ""} · ${reserve.source === "client" ? `écrite par le client (${escapeHtml(reserve.by)}) en signant` : "notée par l'équipe"} le ${escapeHtml(formatIsoDay(reserve.at.slice(0, 10)))}</span>
        <p class="reserve-text">${escapeHtml(reserve.text)}</p>
        ${reserve.status === "levee"
          ? `<p class="muted text-[12.5px]">${icon("check-circle")} Levée le ${escapeHtml(formatIsoDay(reserve.liftedAt.slice(0, 10)))} : ${escapeHtml(reserve.liftNote)}</p>`
          : `<button type="button" class="secondary" data-reserve-lift="${reserve.number}">${icon("check")}Lever la réserve</button>`}
      </li>`).join("")}
    </ul>` : `<p class="muted text-[12.5px]">Aucune réserve. Le client peut en écrire en signant son bon de livraison sur son lien de suivi.</p>`}
    <form class="reserve-form" data-reserve-form>
      <label>Noter une réserve dite par le client (bon papier, téléphone), avec ses mots
        <textarea name="text" rows="2" maxlength="1000" required></textarea>
      </label>
      ${order.deliveryNotes.length > 1 ? `<label>Bon de livraison
        <select name="deliveryNote">${order.deliveryNotes.map((note) => `<option value="${escapeHtml(note)}">n° ${escapeHtml(note)}</option>`).join("")}</select>
      </label>` : ""}
      <button type="submit" class="secondary">${icon("plus")}Noter la réserve</button>
    </form>
  `);
}

async function sendReserve(number, body) {
  try {
    await postJson(`/api/workshop/${encodeURIComponent(number)}/reserves`, body);
    showToast(`Réserve notée sur le BC n° ${number} : elle est confiée au SAV.`);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
}

async function liftReserve(number, reserve, note) {
  try {
    await postJson(`/api/workshop/${encodeURIComponent(number)}/reserves/${encodeURIComponent(reserve)}/lift`, { note });
    showToast(`Réserve n° ${reserve} levée.`);
  } catch (error) {
    showToast(error.message, "warn");
  }
  await refreshOrders();
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
          ? `Lien actif depuis le ${escapeHtml(formatIsoDay(order.portal.createdAt.slice(0, 10)))} : le client voit l'avancement, la livraison prévue, l'échéancier, les photos et ses documents, et peut y signer son bon de livraison ; jamais les notes.`
          : "Créez le lien, puis envoyez-le au client : il verra l'avancement, la livraison prévue, l'échéancier, les photos et ses documents, et pourra y signer son bon de livraison ; jamais les notes."}</p>
        <div class="client-access-actions">
          ${order.portal
            ? `<button type="button" class="secondary" data-portal-copy="${escapeHtml(order.portal.path)}">${icon("link")}Copier le lien</button>
               <button type="button" class="link-button" data-portal-close>Couper le lien</button>`
            : `<button type="button" class="secondary" data-portal-open>${icon("link")}Créer et copier le lien</button>`}
        </div>
      </div>
      ${(order.signatures ?? []).length > 0 ? `
        <ul class="order-journal">
          ${order.signatures.map((entry) => `<li>${icon("check-circle")} Bon de livraison n° ${escapeHtml(entry.number)} signé en ligne par <b>${escapeHtml(entry.name)}</b> le ${escapeHtml(formatIsoDay(entry.signedAt.slice(0, 10)))}${entry.reserves ? ` <span class="tag warning">avec réserves</span>` : ""} · <button type="button" class="link-button" data-signed-download="${escapeHtml(entry.id)}" data-signed-name="bon-de-livraison-${escapeHtml(entry.number)}-signe.pdf">Télécharger le bon signé</button></li>`).join("")}
        </ul>` : order.deliveryNotes.length > 0 ? `<p class="muted text-[12.5px]">Bon de livraison n° ${escapeHtml(order.deliveryNotes.join(", "))} : pas encore signé en ligne. Le client peut le signer depuis son lien de suivi.</p>` : ""}
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

// An amount that never splits across two lines.
function nonBreaking(value) {
  return String(value).replace(/ /g, " ");
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
  if ((order.creditNotes ?? []).length > 0) {
    parts.push(`avoir${order.creditNotes.length > 1 ? "s" : ""} n° ${order.creditNotes.join(", ")}`);
  }
  if ((order.received ?? 0) > 0) {
    parts.push(order.remainingToPay > 0 ? `reçu ${nonBreaking(formatDh(order.received))}, reste à payer ${nonBreaking(formatDh(order.remainingToPay))}` : "payée en totalité");
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
      ${emailView.configured ? `<details class="mail-send">
        <summary>${icon("send")}Envoyer plutôt par e-mail</summary>
        <form data-email-form data-recipient="${escapeHtml(draft.recipient)}" data-kind="${escapeHtml(draft.kind)}">
          <label>Adresse e-mail<input name="to" type="email" required placeholder="client@exemple.ma"></label>
          <label>Objet<input name="subject" required maxlength="200" value="${escapeHtml(`${MESSAGE_KIND_LABELS[draft.kind] ?? "Message"} — ${companyName()}`)}"></label>
          <button type="submit" class="secondary">${icon("send")}Envoyer l'e-mail</button>
          <span class="muted">Le texte ci-dessus part tel que vous l'avez relu, depuis ${escapeHtml(emailView.from ?? "l'adresse de l'entreprise")}.</span>
        </form>
      </details>` : ""}
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
    status.className = sent.waiting ? "tag warning msg-status" : "tag ok msg-status";
    status.textContent = sent.waiting ? "En attente de sa réponse" : "Envoyé";
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
  // A receipt carries no tax; a credit note and a receipt say how the money moves.
  const receipt = preview.documentType === "payment_receipt";
  const settlement = receipt ? `Payé par : ${preview.payment?.method ?? ""}`
    : preview.documentType === "credit_note" ? `Règlement : ${preview.payment?.method ?? ""}` : "";
  const references = [preview.invoiceReference ? `facture n° ${preview.invoiceReference}` : "", preview.quoteReference ? `devis n° ${preview.quoteReference}` : ""].filter(Boolean);
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
      ${(receipt || preview.documentType === "credit_note") && references.length > 0 ? `<p class="muted">Sur ${escapeHtml(references.join(" · "))}</p>` : ""}
      ${entry.replaces ? `<p class="doc-replaces">${icon("refresh")}<span>Correction du n° ${escapeHtml(preview.documentNumber)} : l'ancienne version sera archivée quand vous validerez.</span></p>` : ""}
      ${(entry.preview.notices ?? []).map((notice) => `<p class="doc-replaces">${icon("route")}<span>${escapeHtml(notice)}</span></p>`).join("")}
      ${receipt ? `
      <table class="document-table">
        <thead><tr><th>Désignation</th><th>Montant</th></tr></thead>
        <tbody>${preview.items.map((item) => `<tr><td>${escapeHtml(item.designation)}</td><td>${escapeHtml(formatDh(item.amountHt))}</td></tr>`).join("")}</tbody>
      </table>
      <ul class="doc-totals">
        <li class="grand"><span>Montant reçu</span><strong>${escapeHtml(formatDh(preview.totals.totalTtc))}</strong></li>
      </ul>` : `
      <table class="document-table">
        <thead><tr><th>Désignation</th><th>Qté</th><th>Montant HT</th></tr></thead>
        <tbody>${preview.items.map((item) => `<tr><td>${escapeHtml(item.designation)}</td><td>${escapeHtml(String(item.quantity))}</td><td>${escapeHtml(formatDh(item.netAmountHt ?? item.amountHt))}</td></tr>`).join("")}</tbody>
      </table>
      <ul class="doc-totals">
        <li><span>Total HT</span><strong>${escapeHtml(formatDh(preview.totals.totalHt))}</strong></li>
        <li><span>TVA 20 %</span><strong>${escapeHtml(formatDh(preview.totals.tva))}</strong></li>
        <li class="grand"><span>${preview.documentType === "credit_note" ? "Total de l'avoir TTC" : "Total TTC"}</span><strong>${escapeHtml(formatDh(preview.totals.totalTtc))}</strong></li>
      </ul>`}
      ${settlement ? `<p class="muted">${escapeHtml(settlement)}</p>` : ""}
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
  rejected: "Publication refusée",
  scheduled: "Publication approuvée : elle partira à l'heure prévue",
  published: "Publication approuvée et publiée",
  failed: "Publication approuvée, mais Meta l'a refusée"
};

// What an approval asks, in words, for the ones the agents raise.
const APPROVAL_ACTION_LABELS = {
  publish_social_publication: "Publication Instagram / Facebook",
  reply_social_message: "Réponse Instagram / Facebook"
};

const SOCIAL_REPLY_LABELS = {
  envoyee: "Réponse envoyée",
  refusee: "Réponse refusée : rien n'est parti",
  echec: "Réponse non envoyée"
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
  if (response.socialReply) {
    const reply = response.socialReply.reply;
    const label = SOCIAL_REPLY_LABELS[reply?.status] ?? "Réponse : décision enregistrée";
    return reply?.status === "echec" && reply.error ? `${label} : ${reply.error}` : label;
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
      action: APPROVAL_ACTION_LABELS[approval.requestedAction] ?? approval.requestedAction,
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
    dessinateur_2d3d: "Dessinateur 2D/3D",
    dessinateur_methodes: "Dessinateur méthodes",
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
  if (details.code === "QUOTE_ALREADY_ORDERED") {
    lines.push(`Le devis n° ${details.quoteReference} a déjà son bon de commande : le BC n° ${details.orderNumber}${details.orderDate ? ` du ${details.orderDate}` : ""}. Un devis accepté ne fait qu'une commande ; pour corriger ce BC, remplacez-le sous son numéro.`);
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
  team: "Équipe IA",
  hr: "Équipe RH",
  admin: "Administratif",
  stock: "Stock des matières",
  saas: "Abonnements"
});

// On a phone the tab bar keeps the four views of every day; the others open
// from « Plus », which stays lit while one of them is shown. The cash of the
// day is on the briefing's first card.
const SHEET_VIEWS = Object.freeze(["cash", "saas", "whatsapp", "improvement", "stock", "hr", "admin", "team", "documents", "quotes", "file"]);
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
  if (view === "hr") {
    refreshHr();
  }
  if (view === "admin") {
    refreshAdmin();
  }
  if (view === "stock") {
    refreshStock();
  }
  if (view === "saas") {
    refreshSaas();
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
// A company that set its own payment plans sees them, and only them, in the
// document forms; the pilot keeps the options written in the page.
async function applyCompanyPaymentPlans() {
  try {
    const response = await fetch("/api/company", { headers: await authHeaders() });
    const company = response.ok ? await response.json() : {};
    const plans = company.paymentPlans ?? null;
    // The « Abonnements » view, on the cockpit that sells the subscriptions; a
    // suspended company is told why nothing can be changed.
    const sells = company.saas === true;
    document.querySelector("#saas-nav").hidden = !sells;
    document.querySelector("#saas-sheet").hidden = !sells;
    document.querySelector("#suspended-banner").hidden = company.suspended !== true;
    if (sells) {
      refreshSaas();
    }
    if (!Array.isArray(plans) || plans.length === 0) {
      return;
    }
    const options = plans.map((plan) => `<option value="${escapeHtml(plan.id)}"${plan.standard ? " selected" : ""}>${escapeHtml(plan.label)}${plan.standard ? " — standard" : ""}</option>`).join("");
    const documentTerms = document.querySelector("#document-payment-terms");
    if (documentTerms) {
      documentTerms.innerHTML = `<option value="" data-hide-for="purchase_order">Saisie manuelle requise</option>${options}`;
    }
    const fileRule = document.querySelector("#file-payment-rule");
    if (fileRule) {
      fileRule.innerHTML = options;
    }
  } catch {
    // The page's own options stay.
  }
}

// --- Rapports de la direction (Briefing view) -------------------------------
// The reports sent each working morning, each Monday and each first working
// day of a month, composed by the server from the books. The direction alone
// sees them, turns each on or off, and looks at one now without sending it.
const reportsPanel = document.querySelector("#reports-panel");
const reportsForm = document.querySelector("#reports-form");
const reportsPreview = document.querySelector("#reports-preview");
const reportsList = document.querySelector("#reports-list");
const REPORT_WHEN = Object.freeze({ jour: "chaque matin ouvrable, sur la veille", semaine: "le lundi, sur la semaine passée", mois: "le premier jour ouvrable, sur le mois passé" });

function reportHtml(report, { open = false, meta = "" } = {}) {
  return `<details class="report-entry"${open ? " open" : ""}><summary><strong>${escapeHtml(report.title)}</strong>${meta ? `<small class="muted">${escapeHtml(meta)}</small>` : ""}</summary>${report.sections.map((section) => `<h3>${escapeHtml(section.title)}</h3><ul>${section.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`).join("")}</details>`;
}

async function refreshReports() {
  try {
    const response = await fetch("/api/reports", { headers: await authHeaders() });
    if (response.status === 401 || response.status === 403) {
      reportsPanel.hidden = true;
      return;
    }
    if (!response.ok) {
      throw new Error("Impossible de charger les rapports.");
    }
    renderReports(await response.json());
  } catch (error) {
    reportsPanel.hidden = false;
    reportsList.innerHTML = card("Rapports indisponibles", escapeHtml(error.message), "warning");
  }
}

function renderReports({ settings, kinds, reports, whatsApp }) {
  reportsPanel.hidden = false;
  reportsForm.innerHTML = `${Object.entries(kinds).map(([kind, label]) => `<div class="report-kind"><label class="cash-confidential"><input type="checkbox" name="${escapeHtml(kind)}"${settings[kind] ? " checked" : ""}><span>${escapeHtml(label)} <small>${REPORT_WHEN[kind] ?? ""}</small></span></label><button type="button" class="secondary" data-report-preview="${escapeHtml(kind)}">Voir maintenant</button></div>`).join("")}<p class="muted text-[12.5px]">${whatsApp ? "Envoyés à la direction sur WhatsApp, à partir de 8 h, et gardés ici." : "WhatsApp n'est pas connecté : les rapports sont gardés ici, à partir de 8 h."}</p>`;
  reportsList.innerHTML = reports.length === 0
    ? `<p class="muted">Aucun rapport envoyé pour l'instant : le premier part au prochain matin ouvrable, à partir de 8 h.</p>`
    : `<h3 class="reports-heading">Envoyés</h3>${reports.map((report) => reportHtml(report, { meta: `${formatStamp(report.at)} · ${report.sentBy === "whatsapp" ? "WhatsApp et cockpit" : "cockpit"}` })).join("")}`;
}

reportsForm.addEventListener("change", async (event) => {
  const input = event.target;
  if (!input.matches("input[type='checkbox']")) {
    return;
  }
  try {
    const response = await fetch("/api/reports", { method: "PUT", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ settings: { [input.name]: input.checked } }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Le réglage n'a pas été enregistré.");
    }
    showToast(input.checked ? "Rapport activé." : "Rapport arrêté : il ne sera plus envoyé.");
    renderReports(payload);
  } catch (error) {
    input.checked = !input.checked;
    showToast(error.message, "warn");
  }
});

reportsForm.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-report-preview]");
  if (!button) {
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch("/api/reports/preview", { method: "POST", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ kind: button.dataset.reportPreview }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Le rapport n'a pas pu être composé.");
    }
    reportsPreview.innerHTML = reportHtml(payload.report, { open: true, meta: "aperçu, non envoyé" });
  } catch (error) {
    showToast(error.message, "warn");
  } finally {
    button.disabled = false;
  }
});

// --- Bilan commercial (Devis view) --------------------------------------------
// The complete report of a period from /api/commercial/report: the totals
// against the period before and the month's target, and one axis at a time.
const salesPeriodForm = document.querySelector("#sales-period");
const salesTiles = document.querySelector("#sales-tiles");
const salesObjective = document.querySelector("#sales-objective");
const salesTargetForm = document.querySelector("#sales-target-form");
const salesAxes = document.querySelector("#sales-axes");
const salesTable = document.querySelector("#sales-table");
const salesHint = document.querySelector("#sales-hint");
const salesView = { data: null, axis: "produit" };

salesPeriodForm.addEventListener("submit", (event) => {
  event.preventDefault();
  refreshSales();
});

salesAxes.addEventListener("click", (event) => {
  const button = event.target.closest("[data-axis]");
  if (button && salesView.data) {
    salesView.axis = button.dataset.axis;
    renderSales(salesView.data);
  }
});

salesTargetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(salesTargetForm);
  try {
    const response = await fetch("/api/commercial/targets", { method: "PUT", headers: { "content-type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ month: form.get("month"), amount: form.get("amount") }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "L'objectif n'a pas été enregistré.");
    }
    showToast(Number(form.get("amount")) > 0 ? "Objectif enregistré." : "Objectif retiré.");
    refreshSales();
  } catch (error) {
    showToast(error.message, "warn");
  }
});

async function refreshSales() {
  try {
    const field = (name) => salesPeriodForm.querySelector?.(`[name='${name}']`)?.value ?? "";
    const query = new URLSearchParams(Object.fromEntries([["from", field("from")], ["to", field("to")]].filter(([, value]) => value)));
    const response = await fetch(`/api/commercial/report${query.size > 0 ? `?${query}` : ""}`, { headers: await authHeaders() });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? "Impossible de charger le bilan commercial.");
    }
    salesView.data = payload;
    renderSales(payload);
  } catch (error) {
    salesTiles.innerHTML = `<p class="muted text-[13px]">${escapeHtml(error.message)}</p>`;
  }
}

function salesVariation(now, before) {
  if (before === 0) {
    return now === 0 ? "stable" : "nouveau";
  }
  const change = Math.round(((now - before) / before) * 100);
  return `${change >= 0 ? "+" : ""}${change} %`;
}

function renderSales({ report, axes, targets, canDecide }) {
  const fromField = salesPeriodForm.querySelector("[name='from']");
  const toField = salesPeriodForm.querySelector("[name='to']");
  if (fromField && !fromField.value) fromField.value = report.from;
  if (toField && !toField.value) toField.value = report.to;
  const now = report.totals;
  const before = report.previous.totals;
  const percent = (value) => (value === null ? "—" : `${value} %`);
  const tiles = [
    ["Prospects", String(now.prospects), `avant : ${before.prospects}`],
    ["Devis émis", String(now.issued.count), `${formatDh(now.issued.totalTtc)} · avant : ${before.issued.count}`],
    ["Transformation", percent(now.conversion), `avant : ${percent(before.conversion)}`],
    ["CA commandé", formatDh(now.signed.totalTtc), `${now.signed.count} BC · ${salesVariation(now.signed.totalTtc, before.signed.totalTtc)} (avant : ${formatDh(before.signed.totalTtc)})`],
    ["CA facturé", formatDh(now.invoiced.totalTtc), `avoirs déduits · ${salesVariation(now.invoiced.totalTtc, before.invoiced.totalTtc)}`],
    ["CA encaissé", formatDh(now.paid.total), `caisse : acomptes, soldes, comptant · ${salesVariation(now.paid.total, before.paid.total)}`],
    ["Publicité", formatDh(now.adSpend?.total ?? 0), now.adSpend?.total > 0
      ? [now.costPerLead === null ? "" : `${formatDh(now.costPerLead)} par prospect`, now.costPerSale === null ? "" : `${formatDh(now.costPerSale)} par commande`].filter(Boolean).join(" · ") || "rien à diviser sur la période"
      : "dépenses « Publicité et marketing » de la caisse"]
  ];
  salesTiles.innerHTML = tiles.map(([label, value, hint]) => `<div class="pilot-tile"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></div>`).join("")
    + `<p class="pilot-foot muted">Du ${escapeHtml(formatIsoDay(report.from))} au ${escapeHtml(formatIsoDay(report.to))}, comparé au ${escapeHtml(formatIsoDay(report.previous.from))} – ${escapeHtml(formatIsoDay(report.previous.to))}.</p>`;

  salesObjective.hidden = !report.objective;
  if (report.objective) {
    salesObjective.innerHTML = `<strong>Objectif du mois : ${escapeHtml(formatDh(report.objective.target))}</strong> · ${escapeHtml(formatDh(report.objective.achieved))} commandés, soit ${report.objective.percent} %<span class="sales-meter" aria-hidden="true"><span style="width:${Math.min(100, report.objective.percent)}%"></span></span>`;
  }
  salesTargetForm.hidden = !canDecide;
  if (canDecide && !salesTargetForm.contains(document.activeElement)) {
    const month = report.from.slice(0, 7);
    salesTargetForm.querySelector("[name='month']").value = month;
    salesTargetForm.querySelector("[name='amount']").value = targets[month]?.amount ?? "";
  }

  salesAxes.innerHTML = Object.entries(axes).map(([axis, label]) => `<button type="button" role="tab" class="chip" data-axis="${escapeHtml(axis)}" aria-selected="${axis === salesView.axis}">${escapeHtml(label)}</button>`).join("");
  const rows = report.axes[salesView.axis] ?? [];
  salesTable.innerHTML = rows.length === 0
    ? `<p class="muted">Rien à compter sur cette période.</p>`
    : `<div class="answer-table"><table><thead><tr><th>${escapeHtml(axes[salesView.axis])}</th><th class="num">Prospects</th><th class="num">Devis émis</th><th class="num">Transfo.</th><th class="num">CA commandé</th><th class="num">CA facturé</th><th class="num">CA encaissé</th>${salesView.axis === "campagne" ? `<th class="num">Publicité</th><th class="num">Coût / commande</th>` : ""}</tr></thead><tbody>${rows.map((row) => {
        const refs = [...row.issued.refs, ...row.signed.refs, ...row.invoiced.refs, ...row.paid.refs, ...row.lost.refs.map((ref) => `${ref} (perdu)`)];
        const label = refs.length > 0 ? `<details class="sales-refs"><summary>${escapeHtml(row.label)}</summary><small>${escapeHtml([...new Set(refs)].join(" · "))}</small></details>` : escapeHtml(row.label);
        return `<tr><td>${label}</td><td class="num">${row.prospects || "—"}</td><td class="num">${row.issued.count}</td><td class="num">${percent(row.conversion)}</td><td class="num">${escapeHtml(formatDh(row.signed.totalTtc))}</td><td class="num">${escapeHtml(formatDh(row.invoiced.totalTtc))}</td><td class="num">${escapeHtml(formatDh(row.paid.total))}</td>${salesView.axis === "campagne" ? `<td class="num">${row.adSpend?.total > 0 ? escapeHtml(formatDh(row.adSpend.total)) : "—"}</td><td class="num">${row.costPerSale === null || row.costPerSale === undefined ? "—" : escapeHtml(formatDh(row.costPerSale))}</td>` : ""}</tr>`;
      }).join("")}</tbody></table></div>`;
  const unknown = report.unattributed.quotes;
  salesHint.hidden = !["canal", "vendeur", "campagne"].includes(salesView.axis) || unknown.length === 0;
  salesHint.textContent = `Canal non renseigné pour le devis n° ${unknown.slice(0, 8).join(", ")}${unknown.length > 8 ? "…" : ""}. Dites-le au Director : « le devis ${unknown[0] ?? "170"} vient d'Instagram, campagne de la rentrée, vendu par Nadia ».`;
}

async function loadPanels() {
  await checkAgentStatus();
  loadAgentPicker();
  await refreshEmail();
  applyCompanyPaymentPlans();
  refreshPlans();
  refreshOrders();
  refreshCash();
  refreshImprovement();
  refreshWhatsApp();
  refreshRegister();
  refreshStock();
  refreshHr();
  refreshAdmin();
  refreshReports();
  refreshSales();
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
