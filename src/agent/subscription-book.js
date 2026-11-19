import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { isoDay } from "./sales-book.js";
import { PLANS } from "../company/plans.js";
import { roundMoney } from "../documents/document-calculations.js";

// The subscriptions of the SaaS (CDC section 13 and phase 4), kept by the
// company that sells the cockpit: H-KIDS. Each client company has its own
// isolated cockpit (scripts/tenant.sh); this book, in H-KIDS' cockpit, says
// what each one pays and whether it paid.
//
// Each month, an invoice per active company is prepared, to be issued by the
// direction: it goes through H-KIDS' own invoice chain (same series, same
// identity), citing the contract « ABO-<company> ». Nothing is issued, sent or
// suspended on its own: the book proposes, the direction decides.
//
// Prices are HT, as in the plans; TVA 20 % is added on the invoice.

export const DEFAULT_SUBSCRIPTION_PATH = join(DATA_DIR, "abonnements.json");
export const SUBSCRIPTION_TVA_RATE = 20;
export const CLIENT_STATUSES = Object.freeze({ actif: "actif", suspendu: "suspendu", resilie: "résilié" });
export const DEFAULT_SUBSCRIPTION_SETTINGS = Object.freeze({
  // Days to pay after the invoice date (contractual; within loi 69-21's 60 days).
  dueDays: 30,
  // Reminders proposed this many days after the due date.
  reminderDays: Object.freeze([7, 15]),
  // Suspension proposed this many days after the due date of an unpaid invoice.
  suspendAfterDays: 30
});

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export class SubscriptionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SubscriptionError";
    this.code = code;
  }
}

const EMPTY = { clients: [], invoices: [] };

export function createMemorySubscriptionBook({ clock = () => new Date(), settings = {} } = {}) {
  return subscriptionBook(createMemoryJsonBook(EMPTY), clock, settings);
}

export function createFileSubscriptionBook({ path = DEFAULT_SUBSCRIPTION_PATH, clock = () => new Date(), settings = {} } = {}) {
  return subscriptionBook(createFileJsonBook(path, EMPTY), clock, settings);
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

export function monthLabel(period) {
  const [year, month] = String(period).split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

export function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function frenchDay(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${day}/${month}/${year}` : "";
}

function amountsOf(priceHt) {
  const totalHt = roundMoney(priceHt);
  const tva = roundMoney((totalHt * SUBSCRIPTION_TVA_RATE) / 100);
  return { totalHt, tva, totalTtc: roundMoney(totalHt + tva) };
}

export function contractReference(slug) {
  return `ABO-${slug}`;
}

function subscriptionBook(book, clock, overrides) {
  const settings = { ...DEFAULT_SUBSCRIPTION_SETTINGS, ...overrides };
  const today = () => isoDay(clock());
  const findClient = (state, slug) => {
    const client = state.clients.find((entry) => entry.slug === text(slug));
    if (!client) {
      throw new SubscriptionError(`Aucune entreprise cliente « ${text(slug)} » dans les abonnements.`, "SUBSCRIPTION_CLIENT_NOT_FOUND");
    }
    return client;
  };
  const findInvoice = (state, slug, period) => {
    const invoice = state.invoices.find((entry) => entry.slug === text(slug) && entry.period === text(period));
    if (!invoice) {
      throw new SubscriptionError(`Aucune facture d'abonnement de ${monthLabel(period)} pour « ${text(slug)} ».`, "SUBSCRIPTION_INVOICE_NOT_FOUND");
    }
    return invoice;
  };
  const planOf = (id) => {
    const plan = PLANS[text(id).toLowerCase()];
    if (!plan) {
      throw new SubscriptionError(`Offre inconnue « ${text(id)} » : starter, business ou enterprise.`, "SUBSCRIPTION_PLAN_UNKNOWN");
    }
    return plan;
  };
  const priceOf = (value, plan) => {
    if (value === undefined || value === null || text(value) === "") {
      return plan.priceMad;
    }
    const price = Number(String(value).replace(",", "."));
    if (!(price > 0) || price > 1_000_000) {
      throw new SubscriptionError("Le prix mensuel HT doit être un montant en dirhams supérieur à zéro.", "SUBSCRIPTION_PRICE_INVALID");
    }
    return roundMoney(price);
  };

  return Object.freeze({
    settings: Object.freeze({ ...settings }),

    async state() {
      return book.load();
    },

    // A client company, under the identifier of its cockpit (tenant.sh). Its
    // name and address are those printed on its invoices: its registered ones.
    async addClient({ slug, name, address, plan, priceHt, since = "", ice = "", email = "", by = "direction" }) {
      const id = text(slug).toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(id) || id === "hkids") {
        throw new SubscriptionError("Identifiant : celui de son cockpit (2 à 30 caractères, minuscules, chiffres, tirets).", "SUBSCRIPTION_SLUG_INVALID");
      }
      if (!text(name) || !text(address)) {
        throw new SubscriptionError("Le nom légal et l'adresse du siège sont obligatoires : ils sont imprimés sur ses factures.", "SUBSCRIPTION_IDENTITY_MISSING");
      }
      const chosen = planOf(plan);
      const start = text(since) ? isoDay(text(since)) : today();
      if (!start) {
        throw new SubscriptionError(`Date de début illisible « ${text(since)} » : écrire JJ/MM/AAAA.`, "SUBSCRIPTION_DATE_INVALID");
      }
      return book.change((state) => {
        if (state.clients.some((client) => client.slug === id)) {
          throw new SubscriptionError(`« ${id} » est déjà dans les abonnements.`, "SUBSCRIPTION_CLIENT_EXISTS");
        }
        const client = {
          slug: id, name: text(name), address: text(address), ice: text(ice), email: text(email),
          plan: chosen.id, priceHt: priceOf(priceHt, chosen), since: start, status: "actif",
          history: [{ at: clock().toISOString(), by: text(by), change: `abonnement ${chosen.label} ouvert` }]
        };
        state.clients.push(client);
        return Object.freeze({ ...client });
      });
    },

    // A change of plan or price applies from the next invoice prepared.
    async changePlan(slug, { plan, priceHt, by = "direction" }) {
      const chosen = planOf(plan);
      return book.change((state) => {
        const client = findClient(state, slug);
        client.plan = chosen.id;
        client.priceHt = priceOf(priceHt, chosen);
        client.history.push({ at: clock().toISOString(), by: text(by), change: `offre ${chosen.label} à ${client.priceHt} DH HT par mois` });
        return Object.freeze({ ...client });
      });
    },

    // actif, suspendu (what tenant.sh suspend did) or résilié (no more invoices).
    async setStatus(slug, { status, reason = "", by = "direction" }) {
      if (!Object.hasOwn(CLIENT_STATUSES, status)) {
        throw new SubscriptionError("Statut : actif, suspendu ou resilie.", "SUBSCRIPTION_STATUS_UNKNOWN");
      }
      return book.change((state) => {
        const client = findClient(state, slug);
        client.status = status;
        client.history.push({ at: clock().toISOString(), by: text(by), change: `${CLIENT_STATUSES[status]}${text(reason) ? ` : ${text(reason)}` : ""}` });
        return Object.freeze({ ...client });
      });
    },

    // The month's invoices to issue: one per active company that started on or
    // before this month and has none for it yet. Prepared, never issued here.
    async prepareMonth(period = today().slice(0, 7)) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
        throw new SubscriptionError("Mois illisible : écrire AAAA-MM.", "SUBSCRIPTION_MONTH_INVALID");
      }
      return book.change((state) => {
        const prepared = [];
        for (const client of state.clients) {
          if (client.status !== "actif" || client.since.slice(0, 7) > period) {
            continue;
          }
          if (state.invoices.some((invoice) => invoice.slug === client.slug && invoice.period === period)) {
            continue;
          }
          const invoice = { slug: client.slug, period, plan: client.plan, ...amountsOf(client.priceHt), status: "a_emettre", preparedAt: clock().toISOString(), reminders: [] };
          state.invoices.push(invoice);
          prepared.push(Object.freeze({ ...invoice }));
        }
        return Object.freeze(prepared);
      });
    },

    // What H-KIDS' invoice chain is given for one prepared invoice. The number
    // is the next of H-KIDS' own series, given by the caller.
    async invoiceInput(slug, period, { number, date = today() }) {
      const state = await book.load();
      const client = findClient(state, slug);
      const invoice = findInvoice(state, slug, period);
      if (invoice.status !== "a_emettre") {
        throw new SubscriptionError(`La facture de ${monthLabel(period)} de ${client.name} est déjà émise (n° ${invoice.number}).`, "SUBSCRIPTION_INVOICE_ISSUED");
      }
      return invoiceDocument({ client, invoice, number, date, dueDays: settings.dueDays });
    },

    async markIssued(slug, period, { number, date, by = "direction" }) {
      return book.change((state) => {
        const invoice = findInvoice(state, slug, period);
        if (invoice.status !== "a_emettre") {
          throw new SubscriptionError(`Déjà émise (n° ${invoice.number}).`, "SUBSCRIPTION_INVOICE_ISSUED");
        }
        const day = isoDay(text(date)) ?? today();
        Object.assign(invoice, { status: "emise", number: text(number), date: day, dueDate: addDays(day, settings.dueDays), issuedAt: clock().toISOString(), issuedBy: text(by) });
        return Object.freeze({ ...invoice });
      });
    },

    // The money arrived (a transfer seen on the bank statement): the whole
    // invoice is paid. A part payment is not recorded here.
    async markPaid(slug, period, { paidOn = "", note = "", by = "direction" } = {}) {
      return book.change((state) => {
        const invoice = findInvoice(state, slug, period);
        if (invoice.status !== "emise") {
          throw new SubscriptionError(invoice.status === "payee" ? "Cette facture est déjà payée." : "Émettre la facture avant de la marquer payée.", invoice.status === "payee" ? "SUBSCRIPTION_ALREADY_PAID" : "SUBSCRIPTION_INVOICE_NOT_ISSUED");
        }
        const day = text(paidOn) ? isoDay(text(paidOn)) : today();
        if (!day || day > today()) {
          throw new SubscriptionError("Date de paiement illisible ou à venir : écrire JJ/MM/AAAA.", "SUBSCRIPTION_DATE_INVALID");
        }
        Object.assign(invoice, { status: "payee", paidOn: day, paidNote: text(note), paidBy: text(by), paidAt: clock().toISOString() });
        return Object.freeze({ ...invoice });
      });
    },

    // A reminder written by the direction (sent by e-mail or WhatsApp by hand).
    async noteReminder(slug, period, { step, by = "direction" }) {
      return book.change((state) => {
        const invoice = findInvoice(state, slug, period);
        if (invoice.status !== "emise") {
          throw new SubscriptionError("Seule une facture émise et impayée se relance.", "SUBSCRIPTION_NOT_UNPAID");
        }
        if (!invoice.reminders.some((entry) => entry.step === Number(step))) {
          invoice.reminders.push({ step: Number(step), at: clock().toISOString(), by: text(by) });
        }
        return Object.freeze({ ...invoice });
      });
    },

    async overview() {
      return subscriptionOverview(await book.load(), today(), settings);
    }
  });
}

export function invoiceDocument({ client, invoice, number, date, dueDays }) {
  const day = isoDay(text(date));
  const due = addDays(day, dueDays);
  const plan = PLANS[invoice.plan];
  return Object.freeze({
    documentType: "invoice",
    documentNumber: text(number),
    date: frenchDay(day),
    object: "Abonnement au cockpit Director IA",
    subscriptionReference: contractReference(client.slug),
    client: { name: client.name, address: client.address },
    items: [{
      designation: `Abonnement Director IA, offre ${plan?.label ?? invoice.plan}, ${monthLabel(invoice.period)}`,
      unit: "Mois",
      quantity: 1,
      unitPriceHt: invoice.totalHt,
      amountHt: invoice.totalHt
    }],
    totals: { totalHt: invoice.totalHt, tva: invoice.tva, totalTtc: invoice.totalTtc },
    payment: {
      method: "virement bancaire",
      terms: `Abonnement mensuel, payable à réception de la facture et au plus tard le ${frenchDay(due)}.`
    },
    ...(client.ice ? { note: `ICE du client : ${client.ice}` } : {})
  });
}

export function subscriptionOverview(state, today, settings = DEFAULT_SUBSCRIPTION_SETTINGS) {
  const clientOf = (slug) => state.clients.find((client) => client.slug === slug);
  const active = state.clients.filter((client) => client.status === "actif");
  const byPlan = Object.fromEntries(Object.keys(PLANS).map((id) => [id, active.filter((client) => client.plan === id).length]));
  const monthlyHt = roundMoney(active.reduce((sum, client) => sum + client.priceHt, 0));
  const unpaid = state.invoices
    .filter((invoice) => invoice.status === "emise")
    .map((invoice) => {
      const late = Math.max(0, daysBetween(invoice.dueDate, today));
      const client = clientOf(invoice.slug);
      const due = settings.reminderDays.filter((step) => late >= step && !invoice.reminders.some((entry) => entry.step === step));
      return Object.freeze({
        slug: invoice.slug, name: client?.name ?? invoice.slug, email: client?.email ?? "", period: invoice.period, month: monthLabel(invoice.period),
        number: invoice.number, date: invoice.date, dueDate: invoice.dueDate, totalTtc: invoice.totalTtc, daysLate: late,
        reminderDue: due.length > 0 ? Math.max(...due) : null,
        reminderText: reminderText({ client, invoice, late }),
        remindersSent: invoice.reminders.map((entry) => entry.step)
      });
    })
    .sort((a, b) => b.daysLate - a.daysLate);
  const toSuspend = active
    .filter((client) => unpaid.some((invoice) => invoice.slug === client.slug && invoice.daysLate >= settings.suspendAfterDays))
    .map((client) => Object.freeze({ slug: client.slug, name: client.name, command: `sh scripts/tenant.sh suspend ${client.slug}` }));
  return Object.freeze({
    today,
    settings: Object.freeze({ dueDays: settings.dueDays, reminderDays: [...settings.reminderDays], suspendAfterDays: settings.suspendAfterDays }),
    clients: Object.freeze(state.clients.map((client) => Object.freeze({
      slug: client.slug, name: client.name, address: client.address, ice: client.ice, email: client.email,
      plan: client.plan, planLabel: PLANS[client.plan]?.label ?? client.plan, priceHt: client.priceHt, since: client.since, status: client.status,
      unpaidTtc: roundMoney(unpaid.filter((invoice) => invoice.slug === client.slug).reduce((sum, invoice) => sum + invoice.totalTtc, 0))
    }))),
    activeCount: active.length,
    byPlan: Object.freeze(byPlan),
    monthlyHt,
    yearlyHt: roundMoney(monthlyHt * 12),
    unpaidTtc: roundMoney(unpaid.reduce((sum, invoice) => sum + invoice.totalTtc, 0)),
    lateTtc: roundMoney(unpaid.filter((invoice) => invoice.daysLate > 0).reduce((sum, invoice) => sum + invoice.totalTtc, 0)),
    toIssue: Object.freeze(state.invoices.filter((invoice) => invoice.status === "a_emettre").map((invoice) => Object.freeze({
      slug: invoice.slug, name: clientOf(invoice.slug)?.name ?? invoice.slug, period: invoice.period, month: monthLabel(invoice.period), plan: PLANS[invoice.plan]?.label ?? invoice.plan, totalHt: invoice.totalHt, totalTtc: invoice.totalTtc
    }))),
    unpaid: Object.freeze(unpaid),
    toSuspend: Object.freeze(toSuspend),
    paidRecently: Object.freeze(state.invoices.filter((invoice) => invoice.status === "payee" && invoice.paidOn > addDays(today, -60)).sort((a, b) => b.paidOn.localeCompare(a.paidOn)).slice(0, 20).map((invoice) => Object.freeze({
      slug: invoice.slug, name: clientOf(invoice.slug)?.name ?? invoice.slug, month: monthLabel(invoice.period), number: invoice.number, totalTtc: invoice.totalTtc, paidOn: invoice.paidOn
    })))
  });
}

// The words of a reminder, for the direction to send by e-mail or WhatsApp.
export function reminderText({ client, invoice, late }) {
  const amount = `${invoice.totalTtc.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ | /g, " ")} DH TTC`;
  const name = client?.name ?? invoice.slug;
  return late > 0
    ? `Bonjour, sauf erreur de notre part, la facture n° ${invoice.number} du ${frenchDay(invoice.date)} (abonnement Director IA, ${monthLabel(invoice.period)}, ${amount}) reste impayée depuis le ${frenchDay(invoice.dueDate)}. Merci de procéder au virement ou de nous indiquer s'il a déjà été fait. Cordialement, H-KIDS.`
    : `Bonjour, la facture n° ${invoice.number} de ${name} (abonnement Director IA, ${monthLabel(invoice.period)}, ${amount}) est à régler au plus tard le ${frenchDay(invoice.dueDate)}. Cordialement, H-KIDS.`;
}
