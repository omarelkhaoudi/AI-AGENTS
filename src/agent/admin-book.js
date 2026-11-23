import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { frenchDay } from "./hr-book.js";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { isoDay } from "./sales-book.js";

// The Administratif's register (CDC: « contrats, documents, fournisseurs,
// échéances, classement et tâches transversales », « préparation de
// courriers »). The documents H KIDS issues are classed by the document
// register (document-register.js); this book keeps the rest:
//
// - the suppliers, with what they sell and how to reach them;
// - the company's own contracts (lease, insurance, leasing, maintenance…),
//   with their end and the notice to give before a tacit renewal;
// - the deadlines (a tax return, the CNSS, an insurance premium), once or
//   every month, quarter or year;
// - the mail register: each letter received or sent gets its chrono number
//   (2026-001), a letter received may wait for an answer, a letter to send is
//   prepared as a draft the direction validates.
//
// Its alerts go to Amélioration, to the Administratif.

export const DEFAULT_ADMIN_PATH = join(DATA_DIR, "administratif.json");
export const COMPANY_CONTRACT_KINDS = Object.freeze({ bail: "Bail", assurance: "Assurance", leasing: "Leasing ou crédit", maintenance: "Maintenance", abonnement: "Abonnement (téléphone, internet, logiciel)", fournisseur: "Contrat fournisseur", client: "Contrat client", prestataire: "Prestataire", autre: "Autre" });
export const RENEWALS = Object.freeze({ tacite: "reconduction tacite", expresse: "renouvellement à décider", aucune: "sans renouvellement" });
export const DEADLINE_KINDS = Object.freeze({ fiscale: "Fiscale – DGI", sociale: "Sociale – CNSS", assurance: "Assurance", bail: "Loyer", banque: "Banque", administrative: "Administrative", autre: "Autre" });
export const RECURRENCES = Object.freeze({ aucune: "une fois", mensuelle: "chaque mois", trimestrielle: "chaque trimestre", annuelle: "chaque année" });
export const MAIL_STATUSES = Object.freeze({ a_traiter: "à traiter", traite: "traité", brouillon: "brouillon à valider", envoye: "envoyé" });
const RECURRENCE_MONTHS = Object.freeze({ mensuelle: 1, trimestrielle: 3, annuelle: 12 });

export class AdminBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AdminBookError";
    this.code = code;
  }
}

const EMPTY = { suppliers: [], contracts: [], deadlines: [], mail: [] };

export function createMemoryAdminBook({ clock = () => new Date() } = {}) {
  return adminBook(createMemoryJsonBook(EMPTY), clock);
}

export function createFileAdminBook({ path = DEFAULT_ADMIN_PATH, clock = () => new Date() } = {}) {
  return adminBook(createFileJsonBook(path, EMPTY), clock);
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const normalized = (value) => text(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const nextNumber = (entries) => entries.reduce((max, entry) => Math.max(max, entry.number ?? 0), 0) + 1;

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function addMonths(iso, months) {
  const [year, month, dayOfMonth] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(dayOfMonth, last))).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function amount(value) {
  const given = text(value).replace(/\s|dh|mad/gi, "").replace(",", ".");
  if (!given) {
    return null;
  }
  const number = Number(given);
  if (!Number.isFinite(number) || number < 0) {
    throw new AdminBookError(`Montant illisible « ${text(value)} ».`, "ADMIN_AMOUNT_INVALID");
  }
  return Math.round(number * 100) / 100;
}

function adminBook(book, clock) {
  const today = () => isoDay(clock());
  const day = (value, fallback) => {
    if (!text(value)) {
      return fallback;
    }
    const iso = isoDay(text(value));
    if (!iso) {
      throw new AdminBookError(`Date illisible « ${text(value)} » : écrire JJ/MM/AAAA.`, "ADMIN_DATE_INVALID");
    }
    return iso;
  };
  const byNumber = (entries, number, label, code) => {
    const found = entries.find((entry) => String(entry.number) === text(number) && !entry.removed);
    if (!found) {
      throw new AdminBookError(`Aucun${label.endsWith("e") ? "e" : ""} ${label} n° ${text(number)} au registre.`, code);
    }
    return found;
  };
  const findSupplier = (state, who) => {
    const wanted = normalized(who);
    const active = state.suppliers.filter((supplier) => !supplier.removed);
    const exact = active.filter((supplier) => String(supplier.number) === text(who) || normalized(supplier.name) === wanted);
    const found = exact.length > 0 ? exact : active.filter((supplier) => normalized(supplier.name).includes(wanted));
    if (!wanted || found.length === 0) {
      throw new AdminBookError(`Aucun fournisseur « ${text(who)} » au registre.`, "ADMIN_SUPPLIER_NOT_FOUND");
    }
    if (found.length > 1) {
      throw new AdminBookError(`Plusieurs fournisseurs répondent à « ${text(who)} » : ${found.map((supplier) => supplier.name).join(", ")}.`, "ADMIN_SUPPLIER_AMBIGUOUS");
    }
    return found[0];
  };
  const supplierFields = ({ trade, contact, phone, email, ice, terms, note }) => {
    const fields = {};
    const put = (key, value, clean = text) => {
      if (value !== undefined && text(value) !== "") {
        fields[key] = text(value) === "-" ? "" : clean(value);
      }
    };
    put("trade", trade);
    put("contact", contact);
    put("phone", phone, (value) => text(value).replace(/[^\d+]/g, ""));
    put("email", email, (value) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value))) {
        throw new AdminBookError(`Adresse e-mail illisible « ${text(value)} ».`, "ADMIN_EMAIL_INVALID");
      }
      return text(value).toLowerCase();
    });
    put("ice", ice, (value) => {
      const digits = text(value).replace(/\D/g, "");
      if (digits.length !== 15) {
        throw new AdminBookError("L'ICE a 15 chiffres.", "ADMIN_ICE_INVALID");
      }
      return digits;
    });
    put("terms", terms);
    put("note", note);
    return fields;
  };

  return Object.freeze({
    async state() {
      return book.load();
    },

    // --- Suppliers -------------------------------------------------------
    async addSupplier({ name, by = "direction", ...rest }) {
      if (!text(name)) {
        throw new AdminBookError("Le nom du fournisseur est obligatoire.", "ADMIN_SUPPLIER_NAME_MISSING");
      }
      const fields = supplierFields(rest);
      return book.change((state) => {
        if (state.suppliers.some((supplier) => !supplier.removed && normalized(supplier.name) === normalized(name))) {
          throw new AdminBookError(`${text(name)} est déjà au registre des fournisseurs.`, "ADMIN_SUPPLIER_EXISTS");
        }
        const supplier = { id: randomUUID(), number: nextNumber(state.suppliers), name: text(name), trade: "", contact: "", phone: "", email: "", ice: "", terms: "", note: "", ...fields, by: text(by), at: clock().toISOString() };
        state.suppliers.push(supplier);
        return Object.freeze({ ...supplier });
      });
    },

    // Given fields change, "-" clears one, empty ones stay.
    async updateSupplier(who, { by = "direction", ...rest }) {
      const fields = supplierFields(rest);
      return book.change((state) => {
        const supplier = findSupplier(state, who);
        Object.assign(supplier, fields, { updatedBy: text(by), updatedAt: clock().toISOString() });
        return Object.freeze({ ...supplier });
      });
    },

    async removeSupplier(who, { by = "direction" } = {}) {
      return book.change((state) => {
        const supplier = findSupplier(state, who);
        Object.assign(supplier, { removed: true, removedBy: text(by), removedOn: today() });
        return Object.freeze({ ...supplier });
      });
    },

    // --- Company contracts ------------------------------------------------
    async addContract({ title, kind = "autre", party = "", start = "", end = "", termMonths = null, renewal = "aucune", noticeDays = null, amount: price = "", period = "", note = "", by = "direction" }) {
      if (!text(title)) {
        throw new AdminBookError("Dire de quel contrat il s'agit (« bail de l'atelier », « assurance multirisque »).", "ADMIN_CONTRACT_TITLE_MISSING");
      }
      if (!Object.hasOwn(COMPANY_CONTRACT_KINDS, kind)) {
        throw new AdminBookError(`Type de contrat : ${Object.keys(COMPANY_CONTRACT_KINDS).join(", ")}.`, "ADMIN_CONTRACT_KIND_UNKNOWN");
      }
      if (!Object.hasOwn(RENEWALS, renewal)) {
        throw new AdminBookError("Renouvellement : tacite, expresse ou aucune.", "ADMIN_RENEWAL_UNKNOWN");
      }
      const from = day(start, null);
      let to = day(end, null);
      const months = termMonths === null || termMonths === "" || Number(termMonths) === 0 ? null : Number(termMonths);
      if (months !== null && !(Number.isInteger(months) && months > 0 && months <= 120)) {
        throw new AdminBookError("Durée du contrat : un nombre entier de mois (12 pour un an).", "ADMIN_TERM_INVALID");
      }
      if (!to && from && months) {
        to = addDays(addMonths(from, months), -1);
      }
      if (from && to && to < from) {
        throw new AdminBookError("La fin du contrat est avant son début.", "ADMIN_CONTRACT_DATES");
      }
      if (renewal === "tacite" && !to) {
        throw new AdminBookError("Un contrat à reconduction tacite a une échéance : donner sa date de fin ou sa durée.", "ADMIN_CONTRACT_END_MISSING");
      }
      const notice = noticeDays === null || noticeDays === "" ? null : Number(noticeDays);
      if (notice !== null && !(Number.isInteger(notice) && notice >= 0 && notice <= 365)) {
        throw new AdminBookError("Préavis : un nombre entier de jours (de 0 à 365).", "ADMIN_NOTICE_INVALID");
      }
      const price_ = amount(price);
      return book.change((state) => {
        const contract = { id: randomUUID(), number: nextNumber(state.contracts), title: text(title), kind, party: text(party), start: from, end: to, termMonths: months, renewal, noticeDays: notice, amount: price_, period: text(period), note: text(note), status: "actif", by: text(by), at: clock().toISOString() };
        state.contracts.push(contract);
        return Object.freeze({ ...contract, ...contractDates(contract, today()) });
      });
    },

    async endContract(number, { date = "", reason = "", by = "direction" } = {}) {
      return book.change((state) => {
        const contract = byNumber(state.contracts, number, "contrat", "ADMIN_CONTRACT_NOT_FOUND");
        if (contract.status !== "actif") {
          throw new AdminBookError(`Le contrat n° ${contract.number} est déjà résilié.`, "ADMIN_CONTRACT_ENDED");
        }
        Object.assign(contract, { status: "resilie", endedOn: day(date, today()), endReason: text(reason), endedBy: text(by) });
        return Object.freeze({ ...contract });
      });
    },

    // --- Deadlines --------------------------------------------------------
    async addDeadline({ title, kind = "autre", due, recurrence = "aucune", warnDays = 7, note = "", by = "direction" }) {
      if (!text(title)) {
        throw new AdminBookError("Dire l'échéance (« déclaration de TVA », « prime d'assurance »).", "ADMIN_DEADLINE_TITLE_MISSING");
      }
      if (!Object.hasOwn(DEADLINE_KINDS, kind)) {
        throw new AdminBookError(`Type d'échéance : ${Object.keys(DEADLINE_KINDS).join(", ")}.`, "ADMIN_DEADLINE_KIND_UNKNOWN");
      }
      if (!Object.hasOwn(RECURRENCES, recurrence)) {
        throw new AdminBookError("Récurrence : aucune, mensuelle, trimestrielle ou annuelle.", "ADMIN_RECURRENCE_UNKNOWN");
      }
      const when = day(due, null);
      if (!when) {
        throw new AdminBookError("Donner la date de l'échéance (JJ/MM/AAAA).", "ADMIN_DEADLINE_DATE_MISSING");
      }
      const warn = Number(warnDays);
      if (!(Number.isInteger(warn) && warn >= 1 && warn <= 60)) {
        throw new AdminBookError("Rappel : de 1 à 60 jours avant.", "ADMIN_WARN_INVALID");
      }
      return book.change((state) => {
        const deadline = { id: randomUUID(), number: nextNumber(state.deadlines), title: text(title), kind, due: when, recurrence, warnDays: warn, note: text(note), done: [], by: text(by), at: clock().toISOString() };
        state.deadlines.push(deadline);
        return Object.freeze({ ...deadline });
      });
    },

    // Done: a deadline once is closed; a recurring one moves to its next date.
    async completeDeadline(number, { note = "", by = "direction" } = {}) {
      return book.change((state) => {
        const deadline = byNumber(state.deadlines, number, "échéance", "ADMIN_DEADLINE_NOT_FOUND");
        if (deadline.closed) {
          throw new AdminBookError(`L'échéance n° ${deadline.number} est déjà faite.`, "ADMIN_DEADLINE_DONE");
        }
        deadline.done.push({ due: deadline.due, on: today(), by: text(by), note: text(note) });
        const months = RECURRENCE_MONTHS[deadline.recurrence];
        if (months) {
          deadline.due = addMonths(deadline.due, months);
        } else {
          deadline.closed = true;
        }
        return Object.freeze({ ...deadline });
      });
    },

    async removeDeadline(number, { by = "direction" } = {}) {
      return book.change((state) => {
        const deadline = byNumber(state.deadlines, number, "échéance", "ADMIN_DEADLINE_NOT_FOUND");
        Object.assign(deadline, { removed: true, removedBy: text(by), removedOn: today() });
        return Object.freeze({ ...deadline });
      });
    },

    // --- Mail register ----------------------------------------------------
    // A letter received: who from, about what, and the date to answer by.
    async receiveMail({ party, subject, date = "", reference = "", replyBy = "", by = "direction" }) {
      if (!text(party) || !text(subject)) {
        throw new AdminBookError("Dire de qui vient le courrier et son objet.", "ADMIN_MAIL_MISSING");
      }
      const received = day(date, today());
      const answer = day(replyBy, null);
      return book.change((state) => {
        const mail = { id: randomUUID(), number: nextNumber(state.mail), chrono: chrono(state.mail, received), way: "entrant", date: received, party: text(party), subject: text(subject), reference: text(reference), replyBy: answer, status: "a_traiter", by: text(by), at: clock().toISOString() };
        state.mail.push(mail);
        return Object.freeze({ ...mail });
      });
    },

    // A letter to send, prepared as a draft: it is sent once the direction
    // has read it. It may answer a letter received.
    async prepareMail({ party, subject, body, reference = "", answers = "", by = "direction" }) {
      if (!text(party) || !text(subject) || !text(body)) {
        throw new AdminBookError("Un courrier à préparer a un destinataire, un objet et un texte.", "ADMIN_MAIL_MISSING");
      }
      return book.change((state) => {
        const replied = text(answers) && text(answers) !== "0" ? byNumber(state.mail, answers, "courrier", "ADMIN_MAIL_NOT_FOUND") : null;
        const mail = { id: randomUUID(), number: nextNumber(state.mail), chrono: chrono(state.mail, today()), way: "sortant", date: today(), party: text(party), subject: text(subject), reference: text(reference), body: text(body), answers: replied?.number ?? null, status: "brouillon", by: text(by), at: clock().toISOString() };
        state.mail.push(mail);
        return Object.freeze({ ...mail });
      });
    },

    // Sent (a draft) or dealt with (a letter received). A letter sent that
    // answers one received deals with it.
    async closeMail(number, { by = "direction" } = {}) {
      return book.change((state) => {
        const mail = byNumber(state.mail, number, "courrier", "ADMIN_MAIL_NOT_FOUND");
        if (["traite", "envoye"].includes(mail.status)) {
          throw new AdminBookError(`Le courrier ${mail.chrono} est déjà ${MAIL_STATUSES[mail.status]}.`, "ADMIN_MAIL_CLOSED");
        }
        mail.status = mail.way === "sortant" ? "envoye" : "traite";
        mail.closedOn = today();
        mail.closedBy = text(by);
        if (mail.way === "sortant") {
          mail.date = today();
          const answered = state.mail.find((other) => other.number === mail.answers && other.status === "a_traiter");
          if (answered) {
            Object.assign(answered, { status: "traite", closedOn: today(), closedBy: text(by), answeredBy: mail.chrono });
          }
        }
        return Object.freeze({ ...mail });
      });
    },

    async overview({ confidential = true } = {}) {
      return adminOverview(await book.load(), today(), { confidential });
    },

    async facts() {
      return adminFacts(await book.load(), today());
    }
  });
}

// The chrono number of the year: 2026-001, received and sent together.
function chrono(mail, date) {
  const year = date.slice(0, 4);
  const count = mail.filter((entry) => entry.chrono?.startsWith(`${year}-`)).length + 1;
  return `${year}-${String(count).padStart(3, "0")}`;
}

// A contract renewed tacitly rolls on by its term: its current end, and the
// last day to give notice before it.
export function contractDates(contract, today) {
  let end = contract.end;
  if (end && contract.renewal === "tacite" && contract.termMonths) {
    while (end < today) {
      end = addDays(addMonths(addDays(end, 1), contract.termMonths), -1);
    }
  }
  const noticeBy = end && contract.renewal === "tacite" && contract.noticeDays !== null ? addDays(end, -contract.noticeDays) : null;
  return { currentEnd: end, noticeBy };
}

const active = (entries) => entries.filter((entry) => !entry.removed);

export function adminOverview(state, today, { confidential = true } = {}) {
  const contracts = active(state.contracts).filter((contract) => contract.status === "actif");
  const deadlines = active(state.deadlines).filter((deadline) => !deadline.closed).sort((a, b) => a.due.localeCompare(b.due));
  const mail = active(state.mail).sort((a, b) => b.number - a.number);
  return Object.freeze({
    today,
    suppliers: Object.freeze(active(state.suppliers).map((supplier) => Object.freeze({ number: supplier.number, name: supplier.name, trade: supplier.trade, contact: supplier.contact, phone: supplier.phone, email: supplier.email, ice: supplier.ice, terms: supplier.terms, note: supplier.note }))),
    contracts: Object.freeze(contracts.map((contract) => Object.freeze({
      number: contract.number, title: contract.title, kind: contract.kind, label: COMPANY_CONTRACT_KINDS[contract.kind], party: contract.party, start: contract.start,
      ...contractDates(contract, today), renewal: contract.renewal, renewalLabel: RENEWALS[contract.renewal], noticeDays: contract.noticeDays,
      amount: confidential ? contract.amount : null, period: confidential ? contract.period : "", note: confidential ? contract.note : ""
    }))),
    deadlines: Object.freeze(deadlines.map((deadline) => Object.freeze({
      number: deadline.number, title: deadline.title, kind: deadline.kind, label: DEADLINE_KINDS[deadline.kind], due: deadline.due, days: daysBetween(today, deadline.due),
      recurrence: deadline.recurrence, recurrenceLabel: RECURRENCES[deadline.recurrence], note: deadline.note, lastDone: deadline.done.at(-1) ?? null
    }))),
    mail: Object.freeze(mail.filter((entry) => !["traite", "envoye"].includes(entry.status) || entry.date >= addDays(today, -60)).map((entry) => Object.freeze({
      number: entry.number, chrono: entry.chrono, way: entry.way, date: entry.date, party: entry.party, subject: entry.subject, reference: entry.reference,
      replyBy: entry.replyBy ?? null, status: entry.status, label: MAIL_STATUSES[entry.status], answers: entry.answers ?? null,
      body: confidential ? entry.body ?? "" : ""
    }))),
    alerts: Object.freeze(adminFacts(state, today).map((fact) => Object.freeze({ kind: fact.kind, severity: fact.severity, text: fact.fact })))
  });
}

// What the Administratif must deal with, as facts for Amélioration.
export function adminFacts(state, today) {
  const fact = (key, kind, severity, owner, reference, message) => ({ source: "administratif", key, kind, severity, owner, client: "", orderNumber: "", step: null, reference, fact: message });
  const when = (days) => (days === 0 ? "aujourd'hui" : days === 1 ? "demain" : `dans ${days} jours`);
  const facts = [];
  for (const deadline of active(state.deadlines).filter((entry) => !entry.closed)) {
    const days = daysBetween(today, deadline.due);
    if (days <= deadline.warnDays) {
      const owner = ["fiscale", "sociale", "banque"].includes(deadline.kind) ? "finance" : "administration";
      facts.push(fact(`admin:echeance:${deadline.number}:${deadline.due}:${days < 0 ? "depassee" : "proche"}`, days < 0 ? "echeance_depassee" : "echeance_proche", days <= 2 ? "haute" : "moyenne", owner, deadline.title,
        days < 0
          ? `Échéance dépassée : ${deadline.title} (${DEADLINE_KINDS[deadline.kind]}) était due le ${frenchDay(deadline.due)}. La régler, puis la dire faite.`
          : `Échéance ${when(days)} : ${deadline.title} (${DEADLINE_KINDS[deadline.kind]}), le ${frenchDay(deadline.due)}.`));
    }
  }
  for (const contract of active(state.contracts).filter((entry) => entry.status === "actif")) {
    const { currentEnd, noticeBy } = contractDates(contract, today);
    if (noticeBy && noticeBy >= today && daysBetween(today, noticeBy) <= 30) {
      const days = daysBetween(today, noticeBy);
      facts.push(fact(`admin:contrat:${contract.number}:preavis:${currentEnd}`, "preavis_contrat", days <= 7 ? "haute" : "moyenne", "administration", contract.title,
        `${contract.title}${contract.party ? ` (${contract.party})` : ""} : reconduit tacitement le ${frenchDay(addDays(currentEnd, 1))} sauf résiliation envoyée au plus tard le ${frenchDay(noticeBy)} (${when(days)}${contract.noticeDays > 0 ? `, préavis de ${contract.noticeDays} jours` : ", sans préavis"}). Le garder ou le résilier par courrier.`));
    } else if (currentEnd && contract.renewal !== "tacite" && currentEnd <= addDays(today, 30)) {
      const days = daysBetween(today, currentEnd);
      facts.push(fact(`admin:contrat:${contract.number}:fin:${currentEnd}`, "fin_contrat_entreprise", days <= 7 ? "haute" : "moyenne", "administration", contract.title,
        days < 0
          ? `${contract.title}${contract.party ? ` (${contract.party})` : ""} : terminé le ${frenchDay(currentEnd)}. Le renouveler par écrit ou le dire résilié.`
          : `${contract.title}${contract.party ? ` (${contract.party})` : ""} : se termine le ${frenchDay(currentEnd)} (${when(days)}). ${contract.renewal === "expresse" ? "Décider de son renouvellement." : "Prévoir la suite."}`));
    }
  }
  for (const mail of active(state.mail).filter((entry) => entry.way === "entrant" && entry.status === "a_traiter" && entry.replyBy)) {
    const days = daysBetween(today, mail.replyBy);
    if (days <= 3) {
      facts.push(fact(`admin:courrier:${mail.number}`, "courrier_a_traiter", days < 0 ? "haute" : "moyenne", "administration", `Courrier ${mail.chrono}`,
        `Courrier ${mail.chrono} de ${mail.party} (« ${mail.subject} ») : réponse attendue ${days < 0 ? `depuis le ${frenchDay(mail.replyBy)}` : `le ${frenchDay(mail.replyBy)} (${when(days)})`}.`));
    }
  }
  return facts;
}
