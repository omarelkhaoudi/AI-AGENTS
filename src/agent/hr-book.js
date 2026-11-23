import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { isoDay } from "./sales-book.js";

// The team's book (CDC section 3, agent RH): who works at the company, their
// absences, late arrivals and overtime, and their paid leave. Only what the
// RH work needs (loi 09-08): name, job, start date and a WhatsApp number at
// most; never a salary, an ID card or a health detail beyond « maladie ».
//
// Presence is kept by exception: a working day with nothing recorded is a day
// worked. The direction or the team leader says « Samir est absent
// aujourd'hui », « Youssef a fait 3 h de plus ».
//
// Paid leave follows the Code du travail marocain: 1,5 working day per month
// of service (art. 231), plus 1,5 day per full five years of seniority,
// capped at 30 days a year (art. 232). Working days are Monday to Saturday
// (art. 233: Sundays and public holidays are not counted).

export const DEFAULT_HR_PATH = join(DATA_DIR, "rh.json");
export const ABSENCE_KINDS = Object.freeze({ absence: "Absence", retard: "Retard", heures_sup: "Heures supplémentaires" });
export const LEAVE_KINDS = Object.freeze({ annuel: "Congé payé annuel", maladie: "Congé maladie", sans_solde: "Congé sans solde", exceptionnel: "Congé exceptionnel (mariage, naissance, décès…)" });
export const LEAVE_STATUSES = Object.freeze({ demande: "demandé", approuve: "approuvé", refuse: "refusé", annule: "annulé" });

// The contracts (Code du travail, art. 13 to 17) and the trial periods of
// art. 14: for a CDI, three months for a cadre, a month and a half for an
// employee, fifteen days for a worker, renewable once; for a CDD, a day per
// week of work up to two weeks under six months, a month beyond.
export const CONTRACT_KINDS = Object.freeze({ cdi: "CDI", cdd: "CDD", anapec: "Contrat d'insertion ANAPEC", stage: "Convention de stage" });
export const CONTRACT_STATUSES = Object.freeze({ actif: "en cours", remplace: "remplacé", termine: "terminé" });
export const JOB_CATEGORIES = Object.freeze({ cadre: "cadre ou assimilé", employe: "employé", ouvrier: "ouvrier" });

// Recruitment keeps the least a choice needs (loi 09-08): a name, a WhatsApp
// number, where the application came from and a short note. Never a CIN, an
// age, a photo, a family or a health detail. Once the position is closed, the
// candidates' data is kept CANDIDATE_KEEP_MONTHS, then erased on the
// direction's word (Amélioration reminds it).
export const POSITION_STATUSES = Object.freeze({ ouvert: "ouvert", pourvu: "pourvu", annule: "annulé" });
export const CANDIDATE_STATUSES = Object.freeze({ recu: "candidature reçue", entretien: "entretien prévu", retenu: "retenu", refuse: "non retenu", embauche: "embauché" });
export const CANDIDATE_KEEP_MONTHS = 12;
export const TRAINING_STATUSES = Object.freeze({ planifiee: "planifiée", realisee: "réalisée", annulee: "annulée" });

// The public holidays at a fixed date. The religious ones move with the moon:
// the direction adds them each year (holidays in the book).
const FIXED_HOLIDAYS = ["01-01", "01-11", "01-14", "05-01", "07-30", "08-14", "08-20", "08-21", "11-06", "11-18"];

export class HrBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "HrBookError";
    this.code = code;
  }
}

const EMPTY = { employees: [], events: [], leaves: [], holidays: [], contracts: [], positions: [], candidates: [], trainings: [] };

export function createMemoryHrBook({ clock = () => new Date() } = {}) {
  return hrBook(createMemoryJsonBook(EMPTY), clock);
}

export function createFileHrBook({ path = DEFAULT_HR_PATH, clock = () => new Date() } = {}) {
  return hrBook(createFileJsonBook(path, EMPTY), clock);
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const normalized = (value) => text(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function hrBook(book, clock) {
  const today = () => isoDay(clock());
  const findEmployee = (state, who) => {
    const wanted = normalized(who);
    const exact = state.employees.filter((employee) => employee.active && (employee.id === text(who) || normalized(employee.name) === wanted));
    const found = exact.length > 0 ? exact : state.employees.filter((employee) => employee.active && normalized(employee.name).split(/\s+/).includes(wanted));
    if (found.length === 0) {
      throw new HrBookError(`Aucun salarié « ${text(who)} » dans l'équipe : l'ajouter d'abord (nom, poste, date d'entrée).`, "HR_EMPLOYEE_NOT_FOUND");
    }
    if (found.length > 1) {
      throw new HrBookError(`Plusieurs salariés s'appellent « ${text(who)} » : ${found.map((employee) => employee.name).join(", ")}. Donner le nom complet.`, "HR_EMPLOYEE_AMBIGUOUS");
    }
    return found[0];
  };
  const findPosition = (state, number) => {
    const position = (state.positions ?? []).find((entry) => String(entry.number) === text(number));
    if (!position) {
      throw new HrBookError(`Aucun poste n° ${text(number)} au recrutement : l'ouvrir d'abord.`, "HR_POSITION_NOT_FOUND");
    }
    return position;
  };
  const pushEmployee = (state, { name, role, startDate, phone, by }) => {
    if (state.employees.some((employee) => employee.active && normalized(employee.name) === normalized(name))) {
      throw new HrBookError(`${text(name)} est déjà dans l'équipe.`, "HR_EMPLOYEE_EXISTS");
    }
    const employee = { id: randomUUID(), name: text(name), role: text(role), phone: text(phone).replace(/[^\d+]/g, ""), startDate, active: true, addedBy: text(by), addedAt: clock().toISOString() };
    state.employees.push(employee);
    return Object.freeze({ ...employee });
  };
  const day = (value, fallback) => {
    if (!text(value)) {
      return fallback;
    }
    const iso = isoDay(text(value));
    if (!iso) {
      throw new HrBookError(`Date illisible « ${text(value)} » : écrire JJ/MM/AAAA.`, "HR_DATE_INVALID");
    }
    return iso;
  };

  return Object.freeze({
    async state() {
      return book.load();
    },

    async addEmployee({ name, role = "", startDate = "", phone = "", by = "direction" }) {
      if (!text(name)) {
        throw new HrBookError("Le nom du salarié est obligatoire.", "HR_NAME_MISSING");
      }
      const start = day(startDate, null);
      if (!start) {
        throw new HrBookError("La date d'entrée est obligatoire (JJ/MM/AAAA) : les congés en dépendent.", "HR_START_MISSING");
      }
      return book.change((state) => pushEmployee(state, { name, role, startDate: start, phone, by }));
    },

    async leaveCompany(who, { endDate = "", by = "direction" } = {}) {
      return book.change((state) => {
        const employee = findEmployee(state, who);
        employee.active = false;
        employee.endDate = day(endDate, today());
        employee.endedBy = text(by);
        // Its contract in force ends with it.
        for (const contract of (state.contracts ?? []).filter((entry) => entry.employeeId === employee.id && entry.status === "actif")) {
          contract.status = "termine";
          contract.endedOn = employee.endDate;
        }
        return Object.freeze({ ...employee });
      });
    },

    // An absence, a late arrival or overtime, for one day.
    async record({ who, kind, date = "", hours = 0, reason = "", justified = false, by = "direction" }) {
      if (!Object.hasOwn(ABSENCE_KINDS, kind)) {
        throw new HrBookError("Dire s'il s'agit d'une absence, d'un retard ou d'heures supplémentaires.", "HR_KIND_UNKNOWN");
      }
      const when = day(date, today());
      if (when > today()) {
        throw new HrBookError("Une absence ou des heures se notent le jour où elles ont lieu ; un congé à venir est une demande de congé.", "HR_DATE_FUTURE");
      }
      const amount = Number(hours) || 0;
      if (kind !== "absence" && !(amount > 0 && amount <= 16)) {
        throw new HrBookError(kind === "retard" ? "Dire la durée du retard en heures (0,5 pour 30 minutes)." : "Dire le nombre d'heures supplémentaires (de 0,5 à 16).", "HR_HOURS_INVALID");
      }
      return book.change((state) => {
        const employee = findEmployee(state, who);
        if (kind === "absence" && state.events.some((event) => !event.cancelled && event.employeeId === employee.id && event.kind === "absence" && event.day === when)) {
          throw new HrBookError(`L'absence de ${employee.name} le ${frenchDay(when)} est déjà notée.`, "HR_DUPLICATE");
        }
        const event = { id: randomUUID(), number: nextNumber(state.events), employeeId: employee.id, kind, day: when, hours: kind === "absence" ? 0 : amount, reason: text(reason), justified: justified === true, by: text(by), at: clock().toISOString() };
        state.events.push(event);
        return Object.freeze({ ...event, employee: employee.name });
      });
    },

    async cancelRecord(number, { reason = "", by = "direction" } = {}) {
      if (!text(reason)) {
        throw new HrBookError("Dire pourquoi la ligne est annulée.", "HR_CANCEL_REASON_MISSING");
      }
      return book.change((state) => {
        const event = state.events.find((other) => String(other.number) === text(number));
        if (!event || event.cancelled) {
          throw new HrBookError(`Aucune ligne n° ${text(number)} active au carnet RH.`, "HR_RECORD_NOT_FOUND");
        }
        event.cancelled = { at: clock().toISOString(), by: text(by), reason: text(reason) };
        return Object.freeze({ ...event });
      });
    },

    async requestLeave({ who, kind = "annuel", from, to, note = "", by = "direction" }) {
      if (!Object.hasOwn(LEAVE_KINDS, kind)) {
        throw new HrBookError("Type de congé inconnu.", "HR_LEAVE_KIND_UNKNOWN");
      }
      const start = day(from, null);
      const end = day(to, start);
      if (!start || end < start) {
        throw new HrBookError("Donner les dates du congé : du JJ/MM/AAAA au JJ/MM/AAAA.", "HR_LEAVE_DATES");
      }
      return book.change((state) => {
        const employee = findEmployee(state, who);
        const overlap = state.leaves.find((leave) => leave.employeeId === employee.id && ["demande", "approuve"].includes(leave.status) && leave.from <= end && leave.to >= start);
        if (overlap) {
          throw new HrBookError(`${employee.name} a déjà un congé ${LEAVE_STATUSES[overlap.status]} du ${frenchDay(overlap.from)} au ${frenchDay(overlap.to)} (n° ${overlap.number}).`, "HR_LEAVE_OVERLAP");
        }
        const leave = { id: randomUUID(), number: state.leaves.reduce((max, other) => Math.max(max, other.number ?? 0), 0) + 1, employeeId: employee.id, kind, from: start, to: end, days: workingDays(start, end, state.holidays), note: text(note), status: "demande", requestedBy: text(by), at: clock().toISOString() };
        state.leaves.push(leave);
        return Object.freeze({ ...leave, employee: employee.name, balance: leaveBalance(employee, state, today()) });
      });
    },

    // The direction's decision on a leave: approved, refused, or cancelled.
    async decideLeave(number, { decision, reason = "", by = "direction" }) {
      if (!["approuve", "refuse", "annule"].includes(decision)) {
        throw new HrBookError("Décision : approuvé, refusé ou annulé.", "HR_DECISION_UNKNOWN");
      }
      return book.change((state) => {
        const leave = state.leaves.find((other) => String(other.number) === text(number));
        if (!leave) {
          throw new HrBookError(`Aucune demande de congé n° ${text(number)}.`, "HR_LEAVE_NOT_FOUND");
        }
        if (decision !== "annule" && leave.status !== "demande") {
          throw new HrBookError(`Le congé n° ${leave.number} est déjà ${LEAVE_STATUSES[leave.status]}.`, "HR_LEAVE_DECIDED");
        }
        leave.status = decision;
        leave.decision = { by: text(by), at: clock().toISOString(), reason: text(reason) };
        const employee = state.employees.find((other) => other.id === leave.employeeId);
        return Object.freeze({ ...leave, employee: employee?.name ?? "", balance: employee ? leaveBalance(employee, state, today()) : null });
      });
    },

    // A contract for an employee: the new one replaces the one in force (a
    // renewal, a CDD turned CDI). The trial period is the one said, or the
    // one art. 14 gives for the kind and category.
    async setContract({ who, kind, start = "", end = "", category = "", trial = "", note = "", by = "direction" }) {
      if (!Object.hasOwn(CONTRACT_KINDS, kind)) {
        throw new HrBookError(`Type de contrat : ${Object.values(CONTRACT_KINDS).join(", ")}.`, "HR_CONTRACT_KIND_UNKNOWN");
      }
      if (text(category) && !Object.hasOwn(JOB_CATEGORIES, text(category))) {
        throw new HrBookError(`Catégorie : ${Object.values(JOB_CATEGORIES).join(", ")}.`, "HR_CATEGORY_UNKNOWN");
      }
      const from = day(start, null);
      if (!from) {
        throw new HrBookError("Donner la date de début du contrat (JJ/MM/AAAA).", "HR_CONTRACT_START_MISSING");
      }
      const to = day(end, null);
      if (kind === "cdi" && to) {
        throw new HrBookError("Un CDI n'a pas de date de fin : un départ se note à part.", "HR_CONTRACT_END_CDI");
      }
      if (kind !== "cdi" && !to) {
        throw new HrBookError(`Un ${CONTRACT_KINDS[kind]} a une date de fin : la donner (JJ/MM/AAAA).`, "HR_CONTRACT_END_MISSING");
      }
      if (to && to < from) {
        throw new HrBookError("La fin du contrat est avant son début.", "HR_CONTRACT_DATES");
      }
      const trialDay = day(trial, null) ?? trialEndFor(kind, text(category), from, to);
      if (trialDay && (trialDay < from || (to && trialDay > to))) {
        throw new HrBookError("La fin de la période d'essai doit tomber pendant le contrat.", "HR_TRIAL_DATES");
      }
      return book.change((state) => {
        const employee = findEmployee(state, who);
        const contracts = (state.contracts ??= []);
        const previous = contracts.filter((contract) => contract.employeeId === employee.id && contract.status === "actif");
        const contract = { id: randomUUID(), number: nextNumber(contracts), employeeId: employee.id, kind, category: text(category), start: from, end: to ?? null, trialEnd: trialDay ?? null, note: text(note), status: "actif", by: text(by), at: clock().toISOString() };
        for (const other of previous) {
          other.status = "remplace";
          other.replacedBy = contract.number;
        }
        contracts.push(contract);
        const fixedTerm = contracts.filter((other) => other.employeeId === employee.id && other.kind === "cdd").length;
        return Object.freeze({ ...contract, employee: employee.name, replaced: previous.map((other) => other.number), fixedTermCount: fixedTerm });
      });
    },

    async openPosition({ title, category = "", kind = "", need = "", by = "direction" }) {
      if (!text(title)) {
        throw new HrBookError("Dire le poste à pourvoir (« menuisier », « commercial showroom »).", "HR_POSITION_TITLE_MISSING");
      }
      if (text(category) && !Object.hasOwn(JOB_CATEGORIES, text(category))) {
        throw new HrBookError(`Catégorie : ${Object.values(JOB_CATEGORIES).join(", ")}.`, "HR_CATEGORY_UNKNOWN");
      }
      if (text(kind) && !Object.hasOwn(CONTRACT_KINDS, text(kind))) {
        throw new HrBookError(`Type de contrat : ${Object.values(CONTRACT_KINDS).join(", ")}.`, "HR_CONTRACT_KIND_UNKNOWN");
      }
      return book.change((state) => {
        const positions = (state.positions ??= []);
        if (positions.some((position) => position.status === "ouvert" && normalized(position.title) === normalized(title))) {
          throw new HrBookError(`Un poste « ${text(title)} » est déjà ouvert.`, "HR_POSITION_EXISTS");
        }
        const position = { id: randomUUID(), number: nextNumber(positions), title: text(title), category: text(category), kind: text(kind), need: text(need), status: "ouvert", openedOn: today(), by: text(by) };
        positions.push(position);
        return Object.freeze({ ...position });
      });
    },

    async closePosition(number, { status, by = "direction" }) {
      if (!["pourvu", "annule"].includes(status)) {
        throw new HrBookError("Un poste se clôt pourvu ou annulé.", "HR_POSITION_STATUS_UNKNOWN");
      }
      return book.change((state) => {
        const position = findPosition(state, number);
        if (position.status !== "ouvert") {
          throw new HrBookError(`Le poste n° ${position.number} est déjà ${POSITION_STATUSES[position.status]}.`, "HR_POSITION_CLOSED");
        }
        Object.assign(position, { status, closedOn: today(), closedBy: text(by) });
        return Object.freeze({ ...position });
      });
    },

    async addCandidate({ position, name, phone = "", source = "", note = "", by = "direction" }) {
      if (!text(name)) {
        throw new HrBookError("Le nom du candidat est obligatoire.", "HR_CANDIDATE_NAME_MISSING");
      }
      return book.change((state) => {
        const job = findPosition(state, position);
        if (job.status !== "ouvert") {
          throw new HrBookError(`Le poste n° ${job.number} (${job.title}) est ${POSITION_STATUSES[job.status]} : plus de candidature.`, "HR_POSITION_CLOSED");
        }
        const candidates = (state.candidates ??= []);
        if (candidates.some((candidate) => candidate.positionNumber === job.number && normalized(candidate.name) === normalized(name))) {
          throw new HrBookError(`${text(name)} a déjà candidaté au poste n° ${job.number}.`, "HR_CANDIDATE_EXISTS");
        }
        const candidate = { id: randomUUID(), number: nextNumber(candidates), positionNumber: job.number, name: text(name), phone: text(phone).replace(/[^\d+]/g, ""), source: text(source), note: text(note), status: "recu", interview: null, receivedOn: today(), updatedOn: today(), by: text(by) };
        candidates.push(candidate);
        return Object.freeze({ ...candidate, position: job.title });
      });
    },

    // A candidate moves on: an interview (its date), kept, not kept, or hired.
    // Hired, the candidate joins the team with the position as job, and the
    // position is filled.
    async updateCandidate(number, { status, interview = "", note = "", startDate = "", by = "direction" }) {
      if (!Object.hasOwn(CANDIDATE_STATUSES, status) || status === "recu") {
        throw new HrBookError("Suite d'une candidature : entretien, retenu, non retenu ou embauché.", "HR_CANDIDATE_STATUS_UNKNOWN");
      }
      const meeting = day(interview, null);
      if (status === "entretien" && !meeting) {
        throw new HrBookError("Donner la date de l'entretien (JJ/MM/AAAA).", "HR_INTERVIEW_DATE_MISSING");
      }
      const start = day(startDate, null);
      if (status === "embauche" && !start) {
        throw new HrBookError("Donner la date d'entrée du nouveau salarié (JJ/MM/AAAA) : les congés en dépendent.", "HR_START_MISSING");
      }
      return book.change((state) => {
        const candidate = (state.candidates ?? []).find((entry) => String(entry.number) === text(number));
        if (!candidate) {
          throw new HrBookError(`Aucune candidature n° ${text(number)}.`, "HR_CANDIDATE_NOT_FOUND");
        }
        if (candidate.status === "embauche") {
          throw new HrBookError(`${candidate.name} est déjà embauché(e).`, "HR_CANDIDATE_HIRED");
        }
        const job = findPosition(state, candidate.positionNumber);
        let employee = null;
        if (status === "embauche") {
          employee = pushEmployee(state, { name: candidate.name, role: job.title, startDate: start, phone: candidate.phone, by });
          if (job.status === "ouvert") {
            Object.assign(job, { status: "pourvu", closedOn: today(), closedBy: text(by) });
          }
        }
        Object.assign(candidate, { status, interview: status === "entretien" ? meeting : candidate.interview, note: text(note) || candidate.note, updatedOn: today() });
        return Object.freeze({ ...candidate, position: job.title, employee });
      });
    },

    // The right to erasure (loi 09-08): one candidate on request, or every
    // candidate of a position closed more than CANDIDATE_KEEP_MONTHS ago.
    async eraseCandidates(number = null) {
      return book.change((state) => {
        const candidates = state.candidates ?? [];
        const gone = number === null ? expiredCandidates(state, today()) : candidates.filter((entry) => String(entry.number) === text(number));
        if (number !== null && gone.length === 0) {
          throw new HrBookError(`Aucune candidature n° ${text(number)}.`, "HR_CANDIDATE_NOT_FOUND");
        }
        const ids = new Set(gone.map((entry) => entry.id));
        state.candidates = candidates.filter((entry) => !ids.has(entry.id));
        return Object.freeze({ erased: gone.length });
      });
    },

    async planTraining({ title, who, from, to = "", provider = "", validUntil = "", by = "direction" }) {
      if (!text(title)) {
        throw new HrBookError("Dire la formation (« sécurité machines », « vernis à l'eau »).", "HR_TRAINING_TITLE_MISSING");
      }
      const start = day(from, null);
      const end = day(to, start);
      if (!start || end < start) {
        throw new HrBookError("Donner les dates de la formation : du JJ/MM/AAAA au JJ/MM/AAAA.", "HR_TRAINING_DATES");
      }
      const valid = day(validUntil, null);
      const names = (Array.isArray(who) ? who : text(who).split(/\s*(?:,|;|\bet\b)\s*/)).map(text).filter(Boolean);
      if (names.length === 0) {
        throw new HrBookError("Dire qui suit la formation.", "HR_TRAINING_WHO_MISSING");
      }
      return book.change((state) => {
        const employees = [...new Map(names.map((name) => findEmployee(state, name)).map((employee) => [employee.id, employee])).values()];
        const trainings = (state.trainings ??= []);
        const training = { id: randomUUID(), number: nextNumber(trainings), title: text(title), employeeIds: employees.map((employee) => employee.id), from: start, to: end, provider: text(provider), validUntil: valid ?? null, status: "planifiee", by: text(by), at: clock().toISOString() };
        trainings.push(training);
        return Object.freeze({ ...training, names: employees.map((employee) => employee.name) });
      });
    },

    async updateTraining(number, { status, validUntil = "", by = "direction" }) {
      if (!Object.hasOwn(TRAINING_STATUSES, status)) {
        throw new HrBookError("Une formation est planifiée, réalisée ou annulée.", "HR_TRAINING_STATUS_UNKNOWN");
      }
      const valid = day(validUntil, null);
      return book.change((state) => {
        const training = (state.trainings ?? []).find((entry) => String(entry.number) === text(number));
        if (!training) {
          throw new HrBookError(`Aucune formation n° ${text(number)}.`, "HR_TRAINING_NOT_FOUND");
        }
        if (status === "realisee" && training.from > today()) {
          throw new HrBookError(`La formation n° ${training.number} commence le ${frenchDay(training.from)} : elle ne peut pas être déjà réalisée.`, "HR_TRAINING_FUTURE");
        }
        Object.assign(training, { status, validUntil: valid ?? training.validUntil, updatedBy: text(by) });
        const names = training.employeeIds.map((id) => state.employees.find((employee) => employee.id === id)?.name ?? "?");
        return Object.freeze({ ...training, names });
      });
    },

    async addHoliday(date, label) {
      const iso = day(date, null);
      if (!iso || !text(label)) {
        throw new HrBookError("Donner la date (JJ/MM/AAAA) et le nom du jour férié.", "HR_HOLIDAY_INVALID");
      }
      return book.change((state) => {
        state.holidays = [...state.holidays.filter((holiday) => holiday.day !== iso), { day: iso, label: text(label) }].sort((a, b) => a.day.localeCompare(b.day));
        return Object.freeze({ day: iso, label: text(label) });
      });
    },

    async overview({ confidential = true } = {}) {
      return hrOverview(await book.load(), today(), { confidential });
    },

    async facts() {
      return hrFacts(await book.load(), today());
    },

    async payroll(month) {
      return payrollVariables(await book.load(), month || today().slice(0, 7));
    }
  });
}

export function isHoliday(iso, extra = []) {
  return FIXED_HOLIDAYS.includes(iso.slice(5)) || extra.some((holiday) => holiday.day === iso);
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// The same day n months later, or the month's last day when it has none
// (31/01 + 1 month = 28/02).
function addMonths(iso, months) {
  const [year, month, dayOfMonth] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(dayOfMonth, last))).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const nextNumber = (entries) => entries.reduce((max, entry) => Math.max(max, entry.number ?? 0), 0) + 1;

// The trial period art. 14 gives: its last day, or null when the law gives
// none for this contract (a stage, an ANAPEC contract, a CDI whose category
// is not said, a CDD under a week).
export function trialEndFor(kind, category, start, end = null) {
  if (kind === "cdi") {
    if (category === "cadre") {
      return addDays(addMonths(start, 3), -1);
    }
    if (category === "employe") {
      return addDays(addMonths(start, 1), 14);
    }
    return category === "ouvrier" ? addDays(start, 14) : null;
  }
  if (kind === "cdd" && end) {
    if (end >= addMonths(start, 6)) {
      return addDays(addMonths(start, 1), -1);
    }
    const days = Math.min(14, Math.floor((daysBetween(start, end) + 1) / 7));
    return days > 0 ? addDays(start, days - 1) : null;
  }
  return null;
}

// The candidates of a position closed more than CANDIDATE_KEEP_MONTHS ago.
function expiredCandidates(state, today) {
  const limit = addMonths(today, -CANDIDATE_KEEP_MONTHS);
  const closed = new Map((state.positions ?? []).filter((position) => position.status !== "ouvert" && position.closedOn).map((position) => [position.number, position.closedOn]));
  return (state.candidates ?? []).filter((candidate) => closed.has(candidate.positionNumber) && [closed.get(candidate.positionNumber), candidate.updatedOn ?? ""].sort().at(-1) <= limit);
}

// The contract in force of each employee.
function currentContracts(state) {
  return new Map((state.contracts ?? []).filter((contract) => contract.status === "actif").map((contract) => [contract.employeeId, contract]));
}

// What the RH agent must deal with, as facts for Amélioration: a contract
// ending within 30 days (or ended with the employee still there), a trial
// period ending within 7 days, a training whose validity runs out within 30
// days with no new session, and candidates' data kept past its time.
export function hrFacts(state, today) {
  const fact = (key, kind, severity, reference, message) => ({ source: "rh", key, kind, severity, owner: "hr", client: "", orderNumber: "", step: null, reference, fact: message });
  const active = new Map(state.employees.filter((employee) => employee.active).map((employee) => [employee.id, employee]));
  const facts = [];
  for (const contract of currentContracts(state).values()) {
    const employee = active.get(contract.employeeId);
    if (!employee) {
      continue;
    }
    const label = CONTRACT_KINDS[contract.kind];
    if (contract.end && contract.end <= addDays(today, 30)) {
      const left = daysBetween(today, contract.end);
      facts.push(fact(`rh:contrat:${contract.number}:fin`, "fin_contrat", left <= 7 ? "haute" : "moyenne", employee.name, left < 0
        ? `${label} de ${employee.name} terminé le ${frenchDay(contract.end)}, et ${employee.name} est toujours dans l'équipe : établir le nouveau contrat par écrit (renouvellement ou CDI) ou noter son départ.`
        : `${label} de ${employee.name} : fin le ${frenchDay(contract.end)} (${left === 0 ? "aujourd'hui" : `dans ${left} jour${left > 1 ? "s" : ""}`}). Décider avant cette date : renouveler, passer en CDI ou préparer la fin du contrat.`));
    }
    if (contract.trialEnd && contract.trialEnd >= today && contract.trialEnd <= addDays(today, 7)) {
      facts.push(fact(`rh:contrat:${contract.number}:essai`, "fin_essai", "moyenne", employee.name,
        `Période d'essai de ${employee.name} (${label}) : fin le ${frenchDay(contract.trialEnd)}. Confirmer l'embauche${contract.kind === "cdi" ? ", renouveler l'essai une seule fois (art. 14 du Code du travail)" : ""} ou y mettre fin avant cette date.`));
    }
  }
  const trainings = (state.trainings ?? []).filter((training) => training.status !== "annulee");
  for (const training of trainings.filter((entry) => entry.status === "realisee" && entry.validUntil && entry.validUntil <= addDays(today, 30))) {
    const due = training.employeeIds.filter((id) => active.has(id) && !trainings.some((other) => other !== training && normalized(other.title) === normalized(training.title) && other.from > training.from && other.employeeIds.includes(id)));
    if (due.length > 0) {
      const names = due.map((id) => active.get(id).name);
      facts.push(fact(`rh:formation:${training.number}`, "formation_a_renouveler", "moyenne", training.title,
        `Formation « ${training.title} » de ${names.join(", ")} : ${training.validUntil < today ? "plus valable depuis" : "valable jusqu'au"} ${frenchDay(training.validUntil)}. Planifier la prochaine session.`));
    }
  }
  const expired = expiredCandidates(state, today);
  if (expired.length > 0) {
    facts.push(fact("rh:candidats:conservation", "donnees_candidats", "faible", "Recrutement",
      `${expired.length} candidature${expired.length > 1 ? "s" : ""} de postes clos depuis plus de ${CANDIDATE_KEEP_MONTHS} mois : effacer leurs données (loi 09-08, conservation limitée au besoin du recrutement).`));
  }
  return facts;
}

// Monday to Saturday, public holidays left out.
export function workingDays(from, to, holidays = []) {
  let count = 0;
  for (let current = from; current <= to; current = addDays(current, 1)) {
    if (new Date(`${current}T00:00:00Z`).getUTCDay() !== 0 && !isHoliday(current, holidays)) {
      count += 1;
    }
  }
  return count;
}

function monthsBetween(from, to) {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0));
}

// Paid leave earned since the start of the current year of service, and taken
// (approved annual leave in that year): art. 231 and 232.
export function leaveBalance(employee, state, today) {
  const years = Math.floor(monthsBetween(employee.startDate, today) / 12);
  const yearStart = `${Number(employee.startDate.slice(0, 4)) + years}${employee.startDate.slice(4)}`;
  const monthsThisYear = monthsBetween(yearStart, today);
  const perYear = Math.min(30, 18 + Math.floor(years / 5) * 1.5);
  const earned = Math.round(Math.min(perYear, (perYear / 12) * monthsThisYear) * 10) / 10;
  const taken = state.leaves
    .filter((leave) => leave.employeeId === employee.id && leave.kind === "annuel" && leave.status === "approuve" && leave.from >= yearStart)
    .reduce((sum, leave) => sum + leave.days, 0);
  // Under six months of service, no leave is due yet (art. 231).
  const eligible = monthsBetween(employee.startDate, today) >= 6;
  return Object.freeze({ yearOfServiceFrom: yearStart, perYear, earned, taken, remaining: Math.round((earned - taken) * 10) / 10, eligible });
}

export function hrOverview(state, today, { confidential = true } = {}) {
  const active = state.employees.filter((employee) => employee.active);
  const name = (id) => state.employees.find((employee) => employee.id === id)?.name ?? "?";
  const events = state.events.filter((event) => !event.cancelled);
  const onLeave = state.leaves.filter((leave) => leave.status === "approuve" && leave.from <= today && leave.to >= today);
  const absentToday = events.filter((event) => event.kind === "absence" && event.day === today);
  const in30 = addDays(today, 30);
  const contracts = currentContracts(state);
  return Object.freeze({
    today,
    headcount: active.length,
    employees: Object.freeze(active.map((employee) => Object.freeze({ name: employee.name, role: employee.role, startDate: employee.startDate, phone: employee.phone, leave: leaveBalance(employee, state, today) }))),
    absentToday: Object.freeze([
      ...absentToday.map((event) => ({ name: name(event.employeeId), why: event.justified ? (confidential ? event.reason || "absence justifiée" : "absence justifiée") : "absence non justifiée" })),
      ...onLeave.map((leave) => ({ name: name(leave.employeeId), why: `${LEAVE_KINDS[leave.kind]} jusqu'au ${frenchDay(leave.to)}` }))
    ]),
    pendingLeaves: Object.freeze(state.leaves.filter((leave) => leave.status === "demande").map((leave) => Object.freeze({ number: leave.number, name: name(leave.employeeId), kind: LEAVE_KINDS[leave.kind], from: leave.from, to: leave.to, days: leave.days, note: confidential ? leave.note : "" }))),
    upcomingLeaves: Object.freeze(state.leaves.filter((leave) => leave.status === "approuve" && leave.from > today && leave.from <= in30).map((leave) => Object.freeze({ number: leave.number, name: name(leave.employeeId), kind: LEAVE_KINDS[leave.kind], from: leave.from, to: leave.to, days: leave.days }))),
    recent: Object.freeze(events.filter((event) => event.day > addDays(today, -14)).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 30).map((event) => Object.freeze({
      number: event.number, name: name(event.employeeId), kind: event.kind, label: ABSENCE_KINDS[event.kind], day: event.day, hours: event.hours, justified: event.justified,
      reason: confidential ? event.reason : ""
    }))),
    holidays: Object.freeze(state.holidays.filter((holiday) => holiday.day >= today).slice(0, 6)),
    // Contracts and candidates are for the direction: the others see the
    // positions open and the trainings.
    contracts: Object.freeze(confidential ? active.map((employee) => {
      const contract = contracts.get(employee.id);
      return Object.freeze({ name: employee.name, number: contract?.number ?? null, kind: contract?.kind ?? null, label: contract ? CONTRACT_KINDS[contract.kind] : "", start: contract?.start ?? null, end: contract?.end ?? null, trialEnd: contract?.trialEnd ?? null, note: contract?.note ?? "" });
    }) : []),
    positions: Object.freeze((state.positions ?? []).filter((position) => position.status === "ouvert").map((position) => {
      const own = (state.candidates ?? []).filter((candidate) => candidate.positionNumber === position.number);
      return Object.freeze({
        number: position.number, title: position.title, category: position.category, kind: position.kind, need: position.need, openedOn: position.openedOn,
        applications: own.length,
        candidates: Object.freeze(confidential ? own.map((candidate) => Object.freeze({ number: candidate.number, name: candidate.name, phone: candidate.phone, source: candidate.source, note: candidate.note, status: candidate.status, label: CANDIDATE_STATUSES[candidate.status], interview: candidate.interview, receivedOn: candidate.receivedOn })) : [])
      });
    })),
    trainings: Object.freeze((state.trainings ?? []).filter((training) => training.status === "planifiee" || (training.status === "realisee" && training.to >= addDays(today, -60))).sort((a, b) => a.from.localeCompare(b.from)).map((training) => Object.freeze({
      number: training.number, title: training.title, names: Object.freeze(training.employeeIds.map(name)), from: training.from, to: training.to, provider: training.provider, status: training.status, label: TRAINING_STATUSES[training.status], validUntil: training.validUntil
    }))),
    alerts: Object.freeze(hrFacts(state, today).map((entry) => Object.freeze({ kind: entry.kind, severity: entry.severity, text: entry.fact })))
  });
}

// What the accountant needs to prepare the month's pay, without any amount:
// the working days of the month, the days absent (justified or not), the days
// on leave by kind, the hours late and the overtime.
export function payrollVariables(state, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new HrBookError("Mois illisible : écrire AAAA-MM (2026-11).", "HR_MONTH_INVALID");
  }
  const first = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const open = workingDays(first, last, state.holidays);
  const events = state.events.filter((event) => !event.cancelled && event.day >= first && event.day <= last);
  const rows = state.employees
    .filter((employee) => employee.startDate <= last && (employee.active || (employee.endDate ?? "") >= first))
    .map((employee) => {
      const from = employee.startDate > first ? employee.startDate : first;
      const to = employee.endDate && employee.endDate < last ? employee.endDate : last;
      const due = workingDays(from, to, state.holidays);
      const own = events.filter((event) => event.employeeId === employee.id);
      const leaveDays = {};
      for (const leave of state.leaves.filter((entry) => entry.employeeId === employee.id && entry.status === "approuve" && entry.from <= to && entry.to >= from)) {
        leaveDays[leave.kind] = (leaveDays[leave.kind] ?? 0) + workingDays(leave.from > from ? leave.from : from, leave.to < to ? leave.to : to, state.holidays);
      }
      const absences = own.filter((event) => event.kind === "absence");
      const onLeave = Object.values(leaveDays).reduce((sum, value) => sum + value, 0);
      return Object.freeze({
        name: employee.name,
        role: employee.role,
        workingDays: due,
        daysWorked: Math.max(0, due - absences.length - onLeave),
        absencesJustified: absences.filter((event) => event.justified).length,
        absencesUnjustified: absences.filter((event) => !event.justified).length,
        leave: Object.freeze(leaveDays),
        hoursLate: sum(own.filter((event) => event.kind === "retard")),
        overtimeHours: sum(own.filter((event) => event.kind === "heures_sup"))
      });
    });
  return Object.freeze({ month, workingDays: open, rows: Object.freeze(rows) });
}

function sum(events) {
  return Math.round(events.reduce((total, event) => total + event.hours, 0) * 10) / 10;
}

export function frenchDay(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${day}/${month}/${year}` : "";
}
