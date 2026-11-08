// The client's follow-up page. The token is the last part of the address
// (/suivi/<token>); the page reads what the order's link shows and nothing
// else: progress, finished steps, the planned delivery, the payment schedule,
// the published photos and the documents of the sale.

const token = decodeURIComponent(location.pathname.split("/").filter(Boolean)[1] ?? "");
const base = `/api/public/suivi/${encodeURIComponent(token)}`;

const STATE_LABELS = Object.freeze({ terminee: "Terminée", en_cours: "En cours", a_venir: "À venir" });

load();

async function load() {
  let response;
  try {
    response = token ? await fetch(base, { cache: "no-store" }) : null;
  } catch {
    return show("failed");
  }
  if (!response || response.status === 404) {
    return show("unavailable");
  }
  if (!response.ok) {
    return show("failed");
  }
  render(await response.json());
}

function show(id) {
  for (const section of ["loading", "unavailable", "failed", "tracking"]) {
    document.getElementById(section).hidden = section !== id;
  }
}

function render(view) {
  const tracking = document.getElementById("tracking");
  tracking.innerHTML = [summaryCard(view), stepsCard(view), photosCard(view), scheduleCard(view), documentsCard(view)].join("");
  const contact = document.getElementById("contact");
  contact.innerHTML = `Une question sur votre commande ? ${escapeHtml(view.company.name)}`
    + (view.company.phone ? ` · <a class="font-semibold text-brand" href="tel:${escapeHtml(view.company.phone.replace(/\s+/g, ""))}">${escapeHtml(view.company.phone)}</a>` : "")
    + (view.company.email ? ` · <a class="font-semibold text-brand" href="mailto:${escapeHtml(view.company.email)}">${escapeHtml(view.company.email)}</a>` : "");
  contact.hidden = false;
  document.title = `Commande n° ${view.order.number} - H-KIDS`;
  show("tracking");
}

function summaryCard({ order, progress, finished, plannedDelivery }) {
  const delivery = finished
    ? "Votre commande est livrée et installée."
    : plannedDelivery
      ? `Livraison prévue le <strong>${escapeHtml(day(plannedDelivery))}</strong>.`
      : "La date de livraison vous sera communiquée dès qu'elle sera planifiée.";
  return `<section class="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
    <p class="eyebrow">Bon de commande n° ${escapeHtml(order.number)}${order.date ? ` · ${escapeHtml(day(order.date))}` : ""}</p>
    <h1 class="text-[26px] break-words">${escapeHtml(order.object || "Votre commande")}</h1>
    ${order.client ? `<p class="mt-1 text-ink-2 break-words">${escapeHtml(order.client)}</p>` : ""}
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}" aria-label="Avancement"><span style="width:${progress.percent}%"></span></div>
    <p class="progress-label">${progress.done} étape${progress.done > 1 ? "s" : ""} terminée${progress.done > 1 ? "s" : ""} sur ${progress.total} · ${progress.percent} %</p>
    <p class="mt-3 text-ink-2">${delivery}</p>
  </section>`;
}

function stepsCard({ steps }) {
  const items = steps.map((step, index) => {
    const done = step.state === "terminee";
    const current = step.state === "en_cours";
    const status = done && step.doneDate ? `Terminée le ${day(step.doneDate)}` : STATE_LABELS[step.state] ?? "";
    return `<li class="${done ? "done" : ""}${current ? " border-brand/40 bg-brand-soft" : ""}">
      <span class="step-index" aria-hidden="true">${done ? "✓" : index + 1}</span>
      <div><strong>${escapeHtml(step.label)}</strong><small class="${current ? "font-semibold text-brand" : ""}">${escapeHtml(status)}</small></div>
    </li>`;
  });
  return `<section class="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
    <h2>Les étapes de fabrication</h2>
    <ol class="track-steps">${items.join("")}</ol>
  </section>`;
}

function photosCard({ photos }) {
  if (photos.length === 0) {
    return "";
  }
  const figures = photos.map((photo) => `<figure class="m-0 overflow-hidden rounded-xl border border-line bg-surface-2">
      <a href="${base}/photos/${encodeURIComponent(photo.id)}" target="_blank" rel="noopener noreferrer">
        <img class="block aspect-[4/3] w-full object-cover" src="${base}/photos/${encodeURIComponent(photo.id)}" alt="${escapeHtml(photo.caption || "Photo de l'atelier")}" loading="lazy">
      </a>
      <figcaption class="px-3 py-2 text-[12.5px] text-ink-2">${photo.caption ? `${escapeHtml(photo.caption)} · ` : ""}<span class="text-muted">${escapeHtml(day(photo.publishedAt))}</span></figcaption>
    </figure>`);
  return `<section class="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
    <h2>Photos de l'atelier</h2>
    <div class="mt-3.5 grid grid-cols-1 gap-3 sm:grid-cols-2">${figures.join("")}</div>
  </section>`;
}

function scheduleCard({ schedule }) {
  if (schedule.length === 0) {
    return "";
  }
  const rows = schedule.map((part) => `<li class="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <span class="min-w-0 break-words">${escapeHtml(`${part.percent} % ${part.due}`)}</span>
      <strong class="shrink-0 tabular-nums">${escapeHtml(formatDh(part.amount))}</strong>
    </li>`);
  return `<section class="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
    <h2>Échéancier de paiement</h2>
    <ul class="mt-2 list-none p-0">${rows.join("")}</ul>
  </section>`;
}

function documentsCard({ documents }) {
  if (documents.length === 0) {
    return "";
  }
  const links = documents.map((entry) => `<li>
      <a class="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5 font-semibold text-ink transition hover:border-brand/40 hover:bg-brand-soft" href="${base}/documents/${encodeURIComponent(entry.type)}/${encodeURIComponent(entry.number)}" target="_blank" rel="noopener noreferrer">
        <span class="min-w-0 break-words">${escapeHtml(entry.label)}</span><span class="shrink-0 text-[12.5px] text-brand">PDF</span>
      </a>
    </li>`);
  return `<section class="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
    <h2>Vos documents</h2>
    <ul class="mt-3 flex list-none flex-col gap-2 p-0">${links.join("")}</ul>
  </section>`;
}

// AAAA-MM-JJ (or a full timestamp) as JJ/MM/AAAA; a date already written the
// French way is kept.
function day(value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : String(value ?? "");
}

function formatDh(value) {
  return `${new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value)).replace(/ /g, " ")} DH`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
