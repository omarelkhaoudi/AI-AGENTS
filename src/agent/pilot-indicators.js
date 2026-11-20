// The pilot's indicators (CDC V2 annex, « Indicateurs de validation du
// pilote »): what the cockpit's own books show over a period of 30 to 60 days.
// Each figure is counted from recorded facts, says what it counts, and is
// null when there is nothing to count: never an estimate passed for a measure.
//
// The one hypothesis, the minutes an agent's mission saves, is the
// direction's (HKIDS_PILOT_MINUTES_PER_MISSION); without it the time saved is
// not computed, only the missions are counted.

const DAY_MS = 24 * 60 * 60 * 1000;

export function pilotPeriod({ from = "", to = "", start = "", today = new Date() } = {}) {
  const end = isoDay(to) ?? isoDay(today);
  const begin = isoDay(from) ?? isoDay(start) ?? isoDay(new Date(Date.parse(`${end}T00:00:00Z`) - 29 * DAY_MS));
  return begin <= end ? { from: begin, to: end } : { from: end, to: begin };
}

export function minutesPerMissionFromEnv(env = process.env) {
  const value = Number(String(env.HKIDS_PILOT_MINUTES_PER_MISSION ?? "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function pilotIndicators({ anomalies = [], rules = [], orders = [], missions = [], from, to, today = new Date(), minutesPerMission = null }) {
  const inPeriod = (stamp) => {
    const day = typeof stamp === "string" ? stamp.slice(0, 10) : "";
    return day !== "" && day >= from && day <= to;
  };
  const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

  // Late orders: the orders worked on in the period (not finished, or finished
  // in it), late when a step finished after its planned date or is past it.
  const day = isoDay(today);
  const worked = orders.filter((order) => {
    const ordered = isoDay(order.date);
    if (ordered && ordered > to) {
      return false;
    }
    const finishedOn = order.finished ? lastDone(order) : null;
    return !order.finished || (finishedOn !== null && finishedOn >= from);
  });
  const lateOrders = worked.filter((order) => (order.steps ?? []).some((step) => step.late
    || (step.plannedDate && step.doneDate && step.doneDate > step.plannedDate)
    || (step.plannedDate && step.status !== "terminee" && step.plannedDate < day)));

  // Anomalies found in the period; a false alarm is counted apart.
  const detected = anomalies.filter((anomaly) => inPeriod(anomaly.detectedAt));
  const falseAlarms = detected.filter((anomaly) => anomaly.falseAlarm);
  const real = detected.filter((anomaly) => !anomaly.falseAlarm);
  const byKind = {};
  for (const anomaly of real) {
    byKind[anomaly.kind] = (byKind[anomaly.kind] ?? 0) + 1;
  }

  // Resolution: from detection to the anomaly lifted (its task's closure
  // confirmed, or the workshop book back on track), in the period.
  const resolved = anomalies.filter((anomaly) => !anomaly.falseAlarm && anomaly.liftedAt && inPeriod(anomaly.liftedAt));
  const durations = resolved.map((anomaly) => Math.max(0, (Date.parse(anomaly.liftedAt) - Date.parse(anomaly.detectedAt)) / DAY_MS));
  const stillOpen = anomalies.filter((anomaly) => !anomaly.falseAlarm && anomaly.status !== "levee" && anomaly.detectedAt.slice(0, 10) <= to);

  // Procedures: the rules proposed in the period, and what the direction
  // decided. A rule withdrawn later had been approved.
  const proposed = rules.filter((rule) => inPeriod(rule.proposedAt));
  const approved = proposed.filter((rule) => ["active", "retiree"].includes(rule.status));
  const refused = proposed.filter((rule) => rule.status === "refusee");

  // Recurrence: an anomaly that came back while the rule meant to prevent it was in force.
  const recurrences = rules.flatMap((rule) => (rule.recurrences ?? []).filter((entry) => inPeriod(entry.at)).map((entry) => ({ rule: rule.number, title: rule.title, anomaly: entry.anomaly })));

  const missionCount = missions.filter((entry) => inPeriod(entry.at)).length;

  return Object.freeze({
    period: Object.freeze({ from, to, days: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1 }),
    lateOrders: Object.freeze({ late: lateOrders.length, worked: worked.length, percent: share(lateOrders.length, worked.length), numbers: lateOrders.map((order) => String(order.number)) }),
    resolution: Object.freeze({ resolved: resolved.length, averageDays: durations.length > 0 ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10 : null, stillOpen: stillOpen.length }),
    anomalies: Object.freeze({ detected: real.length, byKind: Object.freeze(byKind), severe: real.filter((anomaly) => anomaly.severity === "haute").length }),
    procedures: Object.freeze({ proposed: proposed.length, approved: approved.length, refused: refused.length, pending: proposed.length - approved.length - refused.length, percent: share(approved.length, approved.length + refused.length) }),
    recurrence: Object.freeze({ count: recurrences.length, percent: share(recurrences.length, real.length), entries: Object.freeze(recurrences) }),
    timeSaved: Object.freeze({ missions: missionCount, minutesPerMission, hours: minutesPerMission === null ? null : Math.round((missionCount * minutesPerMission) / 6) / 10 }),
    falseAlarms: Object.freeze({ count: falseAlarms.length, percent: share(falseAlarms.length, detected.length) })
  });
}

function lastDone(order) {
  const days = (order.steps ?? []).map((step) => step.doneDate).filter(Boolean).sort();
  return days.at(-1) ?? null;
}

// A day as YYYY-MM-DD, from an ISO stamp, a Date or a French JJ/MM/AAAA.
function isoDay(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const textValue = typeof value === "string" ? value.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}/.test(textValue)) {
    return textValue.slice(0, 10);
  }
  const french = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(textValue);
  return french ? `${french[3]}-${french[2].padStart(2, "0")}-${french[1].padStart(2, "0")}` : null;
}
