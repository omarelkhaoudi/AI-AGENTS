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

const EMPTY = { employees: [], events: [], leaves: [], holidays: [] };

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
      return book.change((state) => {
        if (state.employees.some((employee) => employee.active && normalized(employee.name) === normalized(name))) {
          throw new HrBookError(`${text(name)} est déjà dans l'équipe.`, "HR_EMPLOYEE_EXISTS");
        }
        const employee = { id: randomUUID(), name: text(name), role: text(role), phone: text(phone).replace(/[^\d+]/g, ""), startDate: start, active: true, addedBy: text(by), addedAt: clock().toISOString() };
        state.employees.push(employee);
        return Object.freeze({ ...employee });
      });
    },

    async leaveCompany(who, { endDate = "", by = "direction" } = {}) {
      return book.change((state) => {
        const employee = findEmployee(state, who);
        employee.active = false;
        employee.endDate = day(endDate, today());
        employee.endedBy = text(by);
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
        const event = { id: randomUUID(), number: state.events.reduce((max, other) => Math.max(max, other.number ?? 0), 0) + 1, employeeId: employee.id, kind, day: when, hours: kind === "absence" ? 0 : amount, reason: text(reason), justified: justified === true, by: text(by), at: clock().toISOString() };
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
    holidays: Object.freeze(state.holidays.filter((holiday) => holiday.day >= today).slice(0, 6))
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
