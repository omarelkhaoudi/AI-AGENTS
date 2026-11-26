// The portal's pages: one view per address after the #, so that the token of
// an e-mail link (#/verifier?jeton=…) is never sent to the server in the URL
// nor kept in its logs.

const views = [...document.querySelectorAll("[data-view]")];
let account = null;
let minPasswordLength = 10;

function route() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  return { path: path || "connexion", params: new URLSearchParams(query) };
}

function show(name) {
  for (const view of views) {
    view.hidden = view.dataset.view !== name;
  }
  const first = document.querySelector(`[data-view="${name}"] input`);
  first?.focus();
}

async function call(path, payload) {
  const response = await fetch(path, {
    method: payload === undefined ? "GET" : "POST",
    headers: payload === undefined ? {} : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    credentials: "same-origin"
  });
  const data = await response.json().catch(() => ({ error: "Le portail ne répond pas. Réessayez dans un instant." }));
  if (!response.ok) {
    const error = new Error(data.error || "Une erreur est survenue.");
    error.code = data.details?.code;
    throw error;
  }
  return data;
}

function message(form, text, ok = false) {
  const box = form.querySelector("[data-message]");
  box.textContent = text;
  box.classList.toggle("ok", ok);
}

function values(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submit(form, work) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  message(form, "");
  try {
    await work(values(form));
  } catch (error) {
    message(form, error.message || "Le portail ne répond pas. Réessayez dans un instant.");
    return error;
  } finally {
    button.disabled = false;
  }
  return null;
}

function sent(text) {
  document.querySelector("[data-sent-text]").textContent = text;
  location.hash = "#/envoye";
}

const loginForm = document.querySelector("[data-form=login]");
const resendButton = document.querySelector("[data-resend]");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  resendButton.hidden = true;
  const error = await submit(loginForm, async (data) => {
    const result = await call("/api/auth/login", { email: data.email, password: data.password });
    account = result.account;
    loginForm.reset();
    location.hash = "#/accueil";
  });
  resendButton.hidden = error?.code !== "EMAIL_NOT_VERIFIED";
});

resendButton.addEventListener("click", async () => {
  const data = values(loginForm);
  try {
    await call("/api/auth/resend-verification", { email: data.email, password: data.password });
    message(loginForm, "Un nouveau lien de confirmation vient de vous être envoyé.", true);
    resendButton.hidden = true;
  } catch (error) {
    message(loginForm, error.message);
  }
});

const signupForm = document.querySelector("[data-form=signup]");
signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submit(signupForm, async (data) => {
    if ((data.password ?? "").length < minPasswordLength) {
      throw new Error(`Le mot de passe doit faire au moins ${minPasswordLength} caractères.`);
    }
    await call("/api/auth/signup", { name: data.name, email: data.email, password: data.password });
    signupForm.reset();
    sent(`Si l'adresse ${data.email.trim()} est correcte, un lien de confirmation vient d'y être envoyé. Ouvrez-le pour activer votre compte.`);
  });
});

const forgotForm = document.querySelector("[data-form=forgot]");
forgotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submit(forgotForm, async (data) => {
    await call("/api/auth/forgot-password", { email: data.email });
    forgotForm.reset();
    sent("Si un compte existe pour cette adresse, un lien pour choisir un nouveau mot de passe vient d'y être envoyé. Il est valable une heure.");
  });
});

const resetForm = document.querySelector("[data-form=reset]");
resetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submit(resetForm, async (data) => {
    if (data.password !== data.confirm) {
      throw new Error("Les deux mots de passe sont différents.");
    }
    await call("/api/auth/reset-password", { token: route().params.get("jeton") ?? "", password: data.password });
    resetForm.reset();
    history.replaceState(null, "", "#/connexion");
    show("connexion");
    message(loginForm, "Mot de passe enregistré. Connectez-vous avec le nouveau.", true);
  });
});

document.querySelector("[data-logout]").addEventListener("click", async () => {
  await call("/api/auth/logout", {}).catch(() => {});
  account = null;
  location.hash = "#/connexion";
});

// The companies of the person, written with textContent only: a company name
// is shown, never interpreted.
async function loadCompanies() {
  const list = document.querySelector("[data-companies]");
  const empty = document.querySelector("[data-companies-empty]");
  const { companies } = await call("/api/companies");
  list.replaceChildren(...companies.map((company) => {
    const item = document.createElement("li");
    item.className = "company";
    const name = document.createElement("span");
    name.className = "company-name";
    name.textContent = company.tradeName;
    const meta = document.createElement("span");
    meta.className = "company-meta";
    meta.textContent = `${company.roleLabel} · ${company.statusLabel}`;
    let action;
    if (company.cockpitUrl) {
      // A fresh ticket at each click: it lasts a minute and opens once.
      action = document.createElement("button");
      action.type = "button";
      action.className = "company-action";
      action.textContent = "Ouvrir";
      action.setAttribute("aria-label", `Ouvrir le cockpit de ${company.tradeName}`);
      action.addEventListener("click", async () => {
        action.disabled = true;
        try {
          const { url } = await call(`/api/companies/${encodeURIComponent(company.slug)}/enter`, {});
          location.assign(url);
        } catch (error) {
          meta.textContent = error.message;
          action.disabled = false;
        }
      });
    } else {
      action = document.createElement("span");
      action.className = "company-waiting";
      action.textContent = company.status === "provisioning" ? "En préparation" : "Accès fermé";
    }
    item.append(name, action, meta);
    return item;
  }));
  empty.hidden = companies.length > 0;
}

const companyForm = document.querySelector("[data-form=company]");
const newCompanyButton = document.querySelector("[data-new-company]");

function showCompanyForm(open) {
  companyForm.hidden = !open;
  newCompanyButton.hidden = open;
  if (open) {
    companyForm.querySelector("input").focus();
  } else {
    companyForm.reset();
    message(companyForm, "");
  }
}

newCompanyButton.addEventListener("click", () => showCompanyForm(true));
document.querySelector("[data-cancel-company]").addEventListener("click", () => showCompanyForm(false));

companyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submit(companyForm, async (data) => {
    await call("/api/companies", data);
    showCompanyForm(false);
    await loadCompanies();
  });
});

function fillChoices(config) {
  for (const select of document.querySelectorAll("[data-choices]")) {
    const choices = config[select.dataset.choices] ?? {};
    const kept = [...select.options].filter((option) => option.value === "");
    select.replaceChildren(...kept, ...Object.entries(choices).map(([value, label]) => new Option(label, value)));
  }
  document.querySelector("#company-country").value = "MA";
  document.querySelector("#company-language").value = "fr";
}

async function verify(token) {
  const text = document.querySelector("[data-verify-text]");
  text.textContent = "Vérification en cours…";
  // The token leaves the address bar at once: a shared screen or a copied
  // link does not carry it further.
  history.replaceState(null, "", "#/verifier");
  try {
    await call("/api/auth/verify-email", { token });
    text.textContent = "Votre adresse est confirmée. Vous pouvez vous connecter.";
  } catch (error) {
    text.textContent = error.message;
  }
}

async function render() {
  const { path, params } = route();
  if (path === "verifier") {
    show("verifier");
    if (params.get("jeton")) {
      await verify(params.get("jeton"));
    }
    return;
  }
  if (path === "accueil") {
    if (!account) {
      account = await call("/api/auth/me").then((data) => data.account, () => null);
    }
    if (!account) {
      location.hash = "#/connexion";
      return;
    }
    document.querySelector("[data-hello]").textContent = `Bonjour ${account.name}`;
    document.querySelector("[data-account-email]").textContent = account.email;
    show("accueil");
    await loadCompanies().catch(() => {
      document.querySelector("[data-companies-empty]").textContent = "Impossible de charger vos entreprises. Rechargez la page.";
      document.querySelector("[data-companies-empty]").hidden = false;
    });
    return;
  }
  show(views.some((view) => view.dataset.view === path) ? path : "connexion");
}

async function start() {
  const config = await call("/api/config").catch(() => null);
  if (config) {
    fillChoices(config);
  }
  if (config?.minPasswordLength) {
    minPasswordLength = config.minPasswordLength;
    for (const hint of document.querySelectorAll("[data-password-hint]")) {
      hint.textContent = `Au moins ${minPasswordLength} caractères.`;
    }
  }
  if (!location.hash || location.hash === "#/connexion") {
    account = await call("/api/auth/me").then((data) => data.account, () => null);
    if (account) {
      history.replaceState(null, "", "#/accueil");
    }
  }
  window.addEventListener("hashchange", render);
  await render();
}

start();
