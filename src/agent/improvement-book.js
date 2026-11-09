import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// Continuous improvement (Hiba's request of 09/11/2026): when something goes
// wrong, such as an order running late, the agent in charge understands why and
// puts a rule in place so that it does not happen again.
//
// An anomaly is a fact: a workshop step blocked or past its planned date, found
// in the workshop book, or a problem the direction reports. The agent in charge
// analyses it: its cause, and the rule that would have prevented it. A rule is
// only a proposal until the direction validates it; once validated it is given
// to its agent, and to the Director, with every mission from then on. If the
// same kind of anomaly comes back under an active rule, the rule is counted as
// not having held, so it can be strengthened.
//
// Each anomaly is also a task (CDC V1.1, section 12 and recette scenario 5):
// it has a severity, the direction assigns it to a trade and a person with a
// deadline, the person takes it and says when it is resolved, and only the
// direction confirms the closure. The task carries the anomaly's number.

export const DEFAULT_IMPROVEMENT_PATH = join(DATA_DIR, "amelioration.json");

export const ANOMALY_STATUSES = Object.freeze({ a_analyser: "à analyser", analysee: "analysée", levee: "levée" });
export const RULE_STATUSES = Object.freeze({ proposee: "à valider", active: "active", refusee: "refusée", retiree: "retirée" });
export const SEVERITIES = Object.freeze({ faible: "faible", moyenne: "moyenne", haute: "haute" });
export const TASK_STATUSES = Object.freeze({ ouverte: "ouverte", prise_en_charge: "prise en charge", resolue: "résolue, à confirmer", cloturee: "clôturée" });
// What a task may become, from where.
const TASK_MOVES = Object.freeze({
  prise_en_charge: ["ouverte"],
  resolue: ["ouverte", "prise_en_charge"],
  cloturer: ["resolue"],
  rouvrir: ["resolue", "cloturee"]
});

export class ImprovementError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ImprovementError";
    this.code = code;
  }
}

const EMPTY = Object.freeze({ anomalies: [], rules: [], notified: {} });

export function createMemoryImprovementBook({ clock = () => new Date() } = {}) {
  return createImprovementBook({ book: createMemoryJsonBook(EMPTY), clock });
}

export function createFileImprovementBook({ path = DEFAULT_IMPROVEMENT_PATH, clock = () => new Date() } = {}) {
  return createImprovementBook({ book: createFileJsonBook(path, EMPTY), clock });
}

function createImprovementBook({ book, clock }) {
  const now = () => clock().toISOString();
  const find = (list, reference, label, code) => {
    const found = list.find((entry) => entry.id === reference || String(entry.number) === String(reference));
    if (!found) {
      throw new ImprovementError(`${label} n° ${reference} introuvable.`, code);
    }
    return found;
  };
  const nextNumber = (list) => list.reduce((max, entry) => Math.max(max, entry.number ?? 0), 0) + 1;

  return Object.freeze({
    // The workshop book read afresh: a step blocked or late that has no open
    // anomaly gets one; an open anomaly whose step is back on track is lifted.
    // Returns the anomalies just found, for their agent to analyse.
    async sync(orders) {
      const facts = workshopFacts(orders);
      return book.change((state) => {
        const at = now();
        const found = [];
        for (const fact of facts) {
          const open = state.anomalies.find((entry) => entry.key === fact.key && entry.status !== "levee");
          if (!open) {
            const anomaly = { id: randomUUID(), number: nextNumber(state.anomalies), ...fact, severity: fact.kind === "blocage" ? "haute" : "moyenne", status: "a_analyser", detectedAt: at, journal: [{ at, by: "director", text: "Anomalie détectée au carnet d'atelier." }] };
            state.anomalies.push(anomaly);
            found.push(Object.freeze({ ...anomaly }));
          }
        }
        const current = new Set(facts.map((fact) => fact.key));
        for (const anomaly of state.anomalies) {
          if (anomaly.source === "atelier" && anomaly.status !== "levee" && !current.has(anomaly.key)) {
            anomaly.status = "levee";
            anomaly.liftedAt = at;
            anomaly.journal.push({ at, by: "director", text: "Le carnet ne la signale plus : anomalie levée." });
            // A task given for it is resolved by the book; the direction
            // still confirms its closure.
            if (anomaly.task && ["ouverte", "prise_en_charge"].includes(anomaly.task.status)) {
              Object.assign(anomaly.task, { status: "resolue", resolvedAt: at, resolvedBy: "carnet d'atelier", resolution: "Le carnet d'atelier ne la signale plus." });
              anomaly.journal.push({ at, by: "director", text: "Tâche résolue d'après le carnet : à confirmer par la direction." });
            }
          }
        }
        return found;
      });
    },

    // A problem the direction reports, outside the workshop book: a complaint,
    // a supplier late, a payment forgotten.
    async report({ fact, area = "autre", orderNumber = "", agent = "director", severity = "moyenne", by = "direction" }) {
      if (!text(fact)) {
        throw new ImprovementError("Décrire ce qui s'est passé.", "IMPROVEMENT_FACT_MISSING");
      }
      if (!SEVERITIES[severity]) {
        throw new ImprovementError(`Gravité attendue : ${Object.keys(SEVERITIES).join(", ")}.`, "IMPROVEMENT_SEVERITY_UNKNOWN");
      }
      return book.change((state) => {
        const at = now();
        const anomaly = {
          id: randomUUID(),
          number: nextNumber(state.anomalies),
          key: `signalee:${randomUUID()}`,
          source: "signalee",
          kind: text(area) || "autre",
          fact: text(fact),
          orderNumber: text(orderNumber),
          client: "",
          step: null,
          owner: text(agent) || "director",
          severity,
          status: "a_analyser",
          detectedAt: at,
          journal: [{ at, by: text(by) || "direction", text: "Anomalie signalée." }]
        };
        state.anomalies.push(anomaly);
        return Object.freeze({ ...anomaly });
      });
    },

    // The agent's analysis: the cause, and either a new rule proposed to the
    // direction or an active rule this anomaly falls under (then the rule did
    // not hold, and it is counted).
    async analyse(reference, { cause, rule = null, existingRule = "", by }) {
      if (!text(cause)) {
        throw new ImprovementError("Donner la cause de l'anomalie.", "IMPROVEMENT_CAUSE_MISSING");
      }
      if (!existingRule && !(text(rule?.title) && text(rule?.action))) {
        throw new ImprovementError("Proposer une règle (titre, quand, action) ou citer la règle existante.", "IMPROVEMENT_RULE_MISSING");
      }
      return book.change((state) => {
        const at = now();
        const anomaly = find(state.anomalies, reference, "Anomalie", "IMPROVEMENT_ANOMALY_NOT_FOUND");
        let target;
        if (existingRule) {
          target = find(state.rules, existingRule, "Règle", "IMPROVEMENT_RULE_NOT_FOUND");
          if (target.status === "active") {
            target.recurrences = [...(target.recurrences ?? []), { at, anomaly: anomaly.number }];
            target.journal.push({ at, by, text: `L'anomalie n° ${anomaly.number} est revenue alors que la règle était active : à renforcer.` });
          } else {
            target.journal.push({ at, by, text: `Concerne aussi l'anomalie n° ${anomaly.number}.` });
          }
          target.anomalies = [...new Set([...(target.anomalies ?? []), anomaly.number])];
        } else {
          target = {
            id: randomUUID(),
            number: nextNumber(state.rules),
            title: text(rule.title),
            trigger: text(rule.trigger),
            action: text(rule.action),
            owner: text(rule.owner) || by,
            status: "proposee",
            proposedBy: by,
            proposedAt: at,
            anomalies: [anomaly.number],
            recurrences: [],
            journal: [{ at, by, text: `Proposée après l'anomalie n° ${anomaly.number}.` }]
          };
          state.rules.push(target);
        }
        anomaly.cause = text(cause);
        anomaly.rule = target.number;
        anomaly.analysedBy = by;
        anomaly.analysedAt = at;
        if (anomaly.status === "a_analyser") {
          anomaly.status = "analysee";
        }
        anomaly.journal.push({ at, by, text: `Cause : ${anomaly.cause}. Règle n° ${target.number}${existingRule ? " (existante)" : " proposée"}.` });
        return Object.freeze({ anomaly: Object.freeze({ ...anomaly }), rule: Object.freeze({ ...target }) });
      });
    },

    // Only the direction validates, refuses or withdraws a rule.
    async decide(reference, decision, { by = "direction", note = "" } = {}) {
      const next = { valider: "active", refuser: "refusee", retirer: "retiree" }[decision];
      if (!next) {
        throw new ImprovementError("Décision attendue : valider, refuser ou retirer.", "IMPROVEMENT_DECISION_UNKNOWN");
      }
      return book.change((state) => {
        const rule = find(state.rules, reference, "Règle", "IMPROVEMENT_RULE_NOT_FOUND");
        const allowed = { valider: ["proposee"], refuser: ["proposee"], retirer: ["active"] }[decision];
        if (!allowed.includes(rule.status)) {
          throw new ImprovementError(`La règle n° ${rule.number} est ${RULE_STATUSES[rule.status]} : on ne peut pas la ${decision === "retirer" ? "retirer" : decision}.`, "IMPROVEMENT_DECISION_INVALID");
        }
        const at = now();
        rule.status = next;
        rule.decidedBy = by;
        rule.decidedAt = at;
        rule.journal.push({ at, by, text: `${{ active: "Validée", refusee: "Refusée", retiree: "Retirée" }[next]} par la direction${text(note) ? ` : ${text(note)}` : ""}.` });
        return Object.freeze({ ...rule });
      });
    },

    // A reported anomaly is lifted by hand once it is dealt with; the workshop's
    // own are lifted when the book no longer shows them. Lifted by the
    // direction, its task is closed with it.
    async lift(reference, { by = "direction" } = {}) {
      return book.change((state) => {
        const anomaly = find(state.anomalies, reference, "Anomalie", "IMPROVEMENT_ANOMALY_NOT_FOUND");
        const at = now();
        if (anomaly.status !== "levee") {
          anomaly.status = "levee";
          anomaly.liftedAt = at;
          anomaly.journal.push({ at, by, text: "Anomalie levée." });
        }
        if (anomaly.task && anomaly.task.status !== "cloturee") {
          Object.assign(anomaly.task, { status: "cloturee", closedAt: at, closedBy: by });
        }
        return Object.freeze({ ...anomaly });
      });
    },

    // The direction gives the anomaly to a trade (agent) and a person, with a
    // deadline. Given again, it goes to the new person, open again.
    async assign(reference, { agent, person = "", phone = "", dueDate, severity = "", instruction = "", by = "direction" }) {
      const due = isoDay(dueDate);
      if (!due) {
        throw new ImprovementError("Donner une échéance lisible (JJ/MM/AAAA).", "IMPROVEMENT_DUE_DATE_INVALID");
      }
      if (severity && !SEVERITIES[severity]) {
        throw new ImprovementError(`Gravité attendue : ${Object.keys(SEVERITIES).join(", ")}.`, "IMPROVEMENT_SEVERITY_UNKNOWN");
      }
      if (!text(agent)) {
        throw new ImprovementError("Dire à quel métier la tâche est confiée.", "IMPROVEMENT_ASSIGNEE_MISSING");
      }
      return book.change((state) => {
        const anomaly = find(state.anomalies, reference, "Anomalie", "IMPROVEMENT_ANOMALY_NOT_FOUND");
        if (anomaly.task?.status === "cloturee") {
          throw new ImprovementError(`La tâche n° ${anomaly.number} est clôturée : rouvrez-la d'abord.`, "IMPROVEMENT_TASK_CLOSED");
        }
        const at = now();
        if (severity) {
          anomaly.severity = severity;
        }
        anomaly.task = { agent: text(agent), person: text(person), phone: text(phone), dueDate: due, instruction: text(instruction), status: "ouverte", assignedBy: by, assignedAt: at };
        anomaly.journal.push({ at, by, text: `Tâche confiée à ${text(person) || text(agent)} pour le ${frenchDay(due)}${text(instruction) ? ` : ${text(instruction)}` : ""}.` });
        return Object.freeze({ ...anomaly, task: Object.freeze({ ...anomaly.task }) });
      });
    },

    // The task moves: taken, resolved (saying how), closed by the direction
    // (cloturer), or opened again (rouvrir, saying why).
    async updateTask(reference, action, { note = "", by = "direction" } = {}) {
      if (!TASK_MOVES[action]) {
        throw new ImprovementError(`Action attendue : ${Object.keys(TASK_MOVES).join(", ")}.`, "IMPROVEMENT_TASK_ACTION_UNKNOWN");
      }
      if (["resolue", "rouvrir"].includes(action) && !text(note)) {
        throw new ImprovementError(action === "resolue" ? "Dire comment la tâche a été résolue." : "Dire pourquoi la tâche est rouverte.", "IMPROVEMENT_TASK_NOTE_MISSING");
      }
      return book.change((state) => {
        const anomaly = find(state.anomalies, reference, "Anomalie", "IMPROVEMENT_ANOMALY_NOT_FOUND");
        const task = anomaly.task;
        if (!task) {
          throw new ImprovementError(`L'anomalie n° ${anomaly.number} n'est confiée à personne : assignez-la d'abord.`, "IMPROVEMENT_TASK_NOT_ASSIGNED");
        }
        if (!TASK_MOVES[action].includes(task.status)) {
          throw new ImprovementError(`La tâche n° ${anomaly.number} est ${TASK_STATUSES[task.status]}.`, "IMPROVEMENT_TASK_MOVE_INVALID");
        }
        const at = now();
        if (action === "prise_en_charge") {
          Object.assign(task, { status: "prise_en_charge", takenAt: at, takenBy: by });
          anomaly.journal.push({ at, by, text: "Tâche prise en charge." });
        } else if (action === "resolue") {
          Object.assign(task, { status: "resolue", resolvedAt: at, resolvedBy: by, resolution: text(note) });
          anomaly.journal.push({ at, by, text: `Tâche résolue : ${text(note)}. À confirmer par la direction.` });
        } else if (action === "cloturer") {
          Object.assign(task, { status: "cloturee", closedAt: at, closedBy: by });
          if (anomaly.status !== "levee") {
            anomaly.status = "levee";
            anomaly.liftedAt = at;
          }
          anomaly.journal.push({ at, by, text: `Clôture confirmée par la direction${text(note) ? ` : ${text(note)}` : ""}.` });
        } else {
          Object.assign(task, { status: "prise_en_charge", reopenedAt: at, reopenedBy: by, reopenReason: text(note) });
          if (anomaly.status === "levee" && anomaly.source === "signalee") {
            anomaly.status = anomaly.cause ? "analysee" : "a_analyser";
          }
          anomaly.journal.push({ at, by, text: `Tâche rouverte : ${text(note)}.` });
        }
        return Object.freeze({ ...anomaly, task: Object.freeze({ ...task }) });
      });
    },

    // The notices not yet sent, among those given; marked sent at once, so
    // two sweeps never send the same one.
    async claimNotices(keys) {
      return book.change((state) => {
        state.notified ??= {};
        const fresh = keys.filter((key) => state.notified[key] === undefined);
        for (const key of fresh) {
          state.notified[key] = now();
        }
        return fresh;
      });
    },

    async state() {
      return book.load();
    },

    // The rules in force, for the agents' instructions: an agent gets its own
    // and the Director gets all of them.
    async activeRules(agent = null) {
      return (await book.load()).rules.filter((rule) => rule.status === "active" && (!agent || agent === "director" || rule.owner === agent));
    }
  });
}

// What the workshop book says is wrong: a blocked step, a step past its planned
// date. One fact per order, step and kind, so a late step stays one anomaly
// however many times the book is read.
function workshopFacts(orders) {
  const facts = [];
  for (const order of orders ?? []) {
    for (const step of order.steps ?? []) {
      const base = { source: "atelier", orderNumber: String(order.number), client: order.client ?? "", step: step.id, owner: step.id === "approvisionnement" ? "purchasing" : "production" };
      if (step.status === "bloquee") {
        facts.push({ ...base, key: `atelier:${order.number}:${step.id}:blocage`, kind: "blocage", fact: `BC ${order.number} (${order.client}) : ${step.label} bloquée : ${step.note}` });
      }
      if (step.late) {
        facts.push({ ...base, key: `atelier:${order.number}:${step.id}:retard`, kind: "retard", fact: `BC ${order.number} (${order.client}) : ${step.label} prévue le ${frenchDay(step.plannedDate)}, pas terminée` });
      }
    }
  }
  return facts;
}

// The anomalies as the direction follows them: what is open, given to nobody,
// late, and resolved but waiting for its closure to be confirmed.
export function taskBoard(anomalies, today = new Date()) {
  const day = isoDay(today);
  const live = anomalies.filter((anomaly) => anomaly.task ? anomaly.task.status !== "cloturee" : anomaly.status !== "levee");
  const working = live.filter((anomaly) => anomaly.task && ["ouverte", "prise_en_charge"].includes(anomaly.task.status));
  return Object.freeze({
    open: live,
    severe: live.filter((anomaly) => anomaly.severity === "haute"),
    unassigned: live.filter((anomaly) => !anomaly.task),
    late: working.filter((anomaly) => anomaly.task.dueDate < day),
    toConfirm: live.filter((anomaly) => anomaly.task?.status === "resolue")
  });
}

// The rules as an agent reads them in its instructions.
export function rulesInstruction(rules) {
  if (rules.length === 0) {
    return "";
  }
  return [
    "Règles d'amélioration continue validées par la direction (à appliquer sans exception ; signale quand une situation en déclenche une) :",
    ...rules.map((rule) => `- Règle n° ${rule.number} « ${rule.title} »${rule.trigger ? ` — quand : ${rule.trigger}` : ""} — action : ${rule.action}`)
  ].join("\n");
}

function isoDay(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? "").trim());
  const iso = french ? `${french[3]}-${french[2]}-${french[1]}` : String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return null;
  }
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function frenchDay(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${day}/${month}/${year}` : "";
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
