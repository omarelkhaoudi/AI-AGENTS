import { roundMoney, percentOfMoney, sumMoney } from "./document-calculations.js";
import { HKIDS_ACTIVE_PAYMENT_TERMS } from "./hkids-template.js";

export class PaymentScheduleError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PaymentScheduleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// The three moments a payment can be attached to. They are named once, because
// an installment without a condition is a number nobody can act on: the point
// of a schedule is knowing what has to happen before the money is due.
export const PAYMENT_CONDITIONS = Object.freeze({
  ON_ORDER: "à la commande",
  BEFORE_DELIVERY: "avant livraison",
  AFTER_INSTALLATION: "après installation"
});

function rule({ id, label, standard, parts }) {
  return Object.freeze({
    id,
    label,
    standard: standard === true,
    parts: Object.freeze(parts.map((part) => Object.freeze({ ...part })))
  });
}

// One standard rule and three exceptions. The standard keeps the id the rest of
// the project already uses, so nothing that referenced it has to change.
//
// An exception is a decision, not a default: the file has to name the rule it
// uses, and no rule is ever selected on the caller's behalf.
export const PAYMENT_SCHEDULE_RULES = Object.freeze({
  [HKIDS_ACTIVE_PAYMENT_TERMS.id]: rule({
    id: HKIDS_ACTIVE_PAYMENT_TERMS.id,
    label: HKIDS_ACTIVE_PAYMENT_TERMS.label,
    standard: true,
    parts: [
      { percent: 60, condition: PAYMENT_CONDITIONS.ON_ORDER },
      { percent: 20, condition: PAYMENT_CONDITIONS.BEFORE_DELIVERY },
      { percent: 20, condition: PAYMENT_CONDITIONS.AFTER_INSTALLATION }
    ]
  }),
  "hkids-50-30-20-exception": rule({
    id: "hkids-50-30-20-exception",
    label: "50 % à la commande ; 30 % avant livraison ; 20 % après installation.",
    parts: [
      { percent: 50, condition: PAYMENT_CONDITIONS.ON_ORDER },
      { percent: 30, condition: PAYMENT_CONDITIONS.BEFORE_DELIVERY },
      { percent: 20, condition: PAYMENT_CONDITIONS.AFTER_INSTALLATION }
    ]
  }),
  "hkids-40-40-20-exception": rule({
    id: "hkids-40-40-20-exception",
    label: "40 % à la commande ; 40 % avant livraison ; 20 % après installation.",
    parts: [
      { percent: 40, condition: PAYMENT_CONDITIONS.ON_ORDER },
      { percent: 40, condition: PAYMENT_CONDITIONS.BEFORE_DELIVERY },
      { percent: 20, condition: PAYMENT_CONDITIONS.AFTER_INSTALLATION }
    ]
  }),
  "hkids-100-exception": rule({
    id: "hkids-100-exception",
    label: "100 % à la commande.",
    parts: [{ percent: 100, condition: PAYMENT_CONDITIONS.ON_ORDER }]
  })
});

export const STANDARD_PAYMENT_SCHEDULE_RULE_ID = HKIDS_ACTIVE_PAYMENT_TERMS.id;

export function paymentScheduleRule(ruleId) {
  return PAYMENT_SCHEDULE_RULES[ruleId] ?? null;
}

export function isKnownPaymentScheduleRule(ruleId) {
  return Object.hasOwn(PAYMENT_SCHEDULE_RULES, ruleId);
}

// The percentage splits the company has approved, as plain sequences. An
// arbitrary split adding up to 100 % is still not one of them.
export const SUPPORTED_PAYMENT_PLANS = Object.freeze(
  Object.values(PAYMENT_SCHEDULE_RULES).map((entry) => Object.freeze(entry.parts.map((part) => Number(part.percent))))
);

/**
 * Whether a list of percentages is one of the approved splits.
 *
 * This looks at the shares and nothing else, which is why it must never be the
 * gate on its own: 60/20/20 released after installation, before delivery and
 * on order is the same split and a different agreement. Use
 * matchingPaymentPlanRule when deciding whether a plan may be used.
 */
export function matchingSupportedPlan(parts = []) {
  const percentages = parts.map((part) => Number(part.percent));
  return SUPPORTED_PAYMENT_PLANS.find(
    (plan) => plan.length === percentages.length && plan.every((percent, index) => percent === percentages[index])
  ) ?? null;
}

export function isSupportedPaymentPlan(parts = []) {
  return matchingSupportedPlan(parts) !== null;
}

/**
 * The one place that decides whether a plan is an approved H-KIDS plan.
 *
 * A plan is the shares *and* what releases them, in order. Matching on the
 * percentages alone let "60 % après installation ; 20 % à la commande ; 20 %
 * avant livraison" pass as the standard rule, which would have the balance fall
 * due before the deposit.
 *
 * Both routes into a schedule go through this: the explicit `parts` list and
 * the written `terms`. The conditions are read from PAYMENT_SCHEDULE_RULES and
 * are never restated here.
 */
export function matchingPaymentPlanRule(parts = []) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return null;
  }

  return Object.values(PAYMENT_SCHEDULE_RULES).find((entry) => {
    if (entry.parts.length !== parts.length) {
      return false;
    }
    return entry.parts.every((expected, index) => {
      const part = parts[index];
      return Number(expected.percent) === Number(part?.percent)
        && normalizeConditionText(expected.condition) === normalizeConditionText(part?.condition ?? "");
    });
  }) ?? null;
}

export function isApprovedPaymentPlan(parts = []) {
  return matchingPaymentPlanRule(parts) !== null;
}

/**
 * Reads the percentages out of a free-text payment condition.
 *
 * Terms typed by hand are the way an unapproved plan gets onto a document:
 * "70 % commande ; 30 % livraison" reads perfectly well and has never been
 * agreed with the company. The figures are extracted so the sentence can be
 * held to the same rule as a selected one.
 *
 * Returns null when the text states no percentages at all — which is not a
 * supported plan either, only a different reason.
 */
export function parsePaymentPlanPercentages(terms) {
  const text = typeof terms === "string" ? terms : "";
  if (text.trim() === "") {
    return null;
  }

  const percentages = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((match) => Number(match[1].replace(",", ".")));
  if (percentages.length > 0) {
    return percentages;
  }

  // "50/50" and "25/75" carry no percent sign and are still a plan.
  const slashed = text.match(/\b\d+(?:\s*\/\s*\d+)+\b/);
  if (slashed) {
    return slashed[0].split("/").map((value) => Number(value.trim()));
  }

  return null;
}

// Written wording varies in ways that change nothing: capitals, a missing
// accent, a trailing full stop, doubled spaces. Those are folded away so the
// comparison is about the condition and not about the typing.
function normalizeConditionText(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a written payment condition into its installments.
 *
 * The canonical wording separates them with a semicolon:
 * "60 % à la commande ; 20 % avant livraison ; 20 % après installation."
 *
 * A segment has to carry exactly one percentage. Two in the same segment means
 * the sentence is not a list of installments — "50% avance 50 % à la livraison"
 * is one such — and null is returned rather than a guess at what was meant.
 */
export function parsePaymentTermsSegments(terms) {
  const text = typeof terms === "string" ? terms : "";
  if (text.trim() === "") {
    return null;
  }

  const segments = [];
  for (const raw of text.split(/[;\n]/)) {
    if (raw.trim() === "") {
      continue;
    }
    const percentages = [...raw.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)];
    if (percentages.length !== 1) {
      return null;
    }
    segments.push({
      percent: Number(percentages[0][1].replace(",", ".")),
      condition: normalizeConditionText(raw.replace(percentages[0][0], " "))
    });
  }

  return segments.length > 0 ? segments : null;
}

/**
 * The approved rule a written payment condition describes, or null.
 *
 * Percentages alone are not enough. "60 % après installation ; 20 % à la
 * commande ; 20 % avant livraison" splits 60/20/20 exactly like the standard
 * rule and says something entirely different: the balance would fall due before
 * the deposit. So each installment is matched on its percentage *and* on its
 * condition, at its own position, against the parts of a rule.
 *
 * The conditions are never invented here: they are read from
 * PAYMENT_SCHEDULE_RULES, whose standard wording is the company's own.
 */
export function matchingPaymentTermsRule(terms) {
  const segments = parsePaymentTermsSegments(terms);
  if (segments === null) {
    return null;
  }
  // Written terms and an explicit parts list are the same question asked twice,
  // so they are answered in the same place.
  return matchingPaymentPlanRule(segments);
}

/**
 * Whether a payment condition, however it was written, describes one of the
 * four approved plans — the right shares, released on the right events, in the
 * right order. Anything else is refused, including a sentence that states no
 * percentage at all, because it cannot be checked against a rule.
 */
export function isSupportedPaymentTerms(terms) {
  return matchingPaymentTermsRule(terms) !== null;
}

function assertPercentages(parts) {
  parts.forEach((part, index) => {
    const percent = Number(part.percent);
    if (!Number.isFinite(percent)) {
      throw new PaymentScheduleError(
        `Installment ${index + 1} has no usable percentage.`,
        "INSTALLMENT_PERCENT_INVALID",
        { index, percent: part.percent }
      );
    }
    if (percent < 0) {
      throw new PaymentScheduleError(
        `Installment ${index + 1} has a negative percentage (${percent} %).`,
        "INSTALLMENT_PERCENT_NEGATIVE",
        { index, percent }
      );
    }
    if (percent > 100) {
      throw new PaymentScheduleError(
        `Installment ${index + 1} exceeds 100 % (${percent} %).`,
        "INSTALLMENT_PERCENT_ABOVE_100",
        { index, percent }
      );
    }
  });

  const total = parts.reduce((sum, part) => sum + Number(part.percent), 0);
  // The percentages are exact by construction, so this is compared as an exact
  // value and not within a tolerance.
  if (roundMoney(total) !== 100) {
    throw new PaymentScheduleError(
      `The installments add up to ${roundMoney(total)} % instead of 100 %.`,
      "SCHEDULE_PERCENT_SUM_INVALID",
      { total: roundMoney(total) }
    );
  }
}

/**
 * Turns a rule and a TTC amount into the installments to be collected.
 *
 * Rounding is the delicate part. Each installment is rounded to the centime,
 * and the rounded amounts may then miss the total by a centime or two. Rather
 * than leave a schedule that does not add up, the difference is carried by the
 * last installment and reported in `roundingAdjustment`, so the correction is
 * visible instead of silent.
 */
export function createPaymentSchedule({ ruleId = null, parts = null, totalTtc } = {}) {
  const amount = roundMoney(totalTtc);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PaymentScheduleError(
      "A payment schedule needs a positive TTC amount.",
      "SCHEDULE_TOTAL_INVALID",
      { totalTtc }
    );
  }

  let resolved = null;
  if (ruleId !== null) {
    resolved = paymentScheduleRule(ruleId);
    if (!resolved) {
      throw new PaymentScheduleError(
        `${ruleId} is not a known H-KIDS payment rule.`,
        "SCHEDULE_RULE_UNKNOWN",
        { ruleId, knownRules: Object.keys(PAYMENT_SCHEDULE_RULES) }
      );
    }
  } else if (Array.isArray(parts)) {
    resolved = rule({ id: null, label: "", standard: false, parts });
  } else {
    throw new PaymentScheduleError(
      "A payment schedule needs either a ruleId or an explicit list of parts.",
      "SCHEDULE_RULE_REQUIRED"
    );
  }

  assertPercentages(resolved.parts);

  // A split reaching 100 % is necessary and not sufficient, and neither is the
  // split alone: the shares have to be released by the right events, in order.
  // Checking the percentages only let an explicit `parts` list carry 60/20/20
  // with the conditions shuffled, or with conditions nobody recognises.
  const approved = matchingPaymentPlanRule(resolved.parts);
  if (!approved) {
    throw new PaymentScheduleError(
      `${resolved.parts.map((part) => `${Number(part.percent)} % ${part.condition ?? ""}`.trim()).join(" ; ")} is not one of the approved H-KIDS payment plans.`,
      "SCHEDULE_PLAN_NOT_SUPPORTED",
      {
        requested: resolved.parts.map((part) => ({ percent: Number(part.percent), condition: part.condition ?? "" })),
        approvedPlans: Object.values(PAYMENT_SCHEDULE_RULES).map((entry) => entry.label)
      }
    );
  }

  // A parts list that matches an approved rule is that rule. Carrying its id
  // and its wording keeps a schedule built this way indistinguishable from one
  // selected by name, so nothing downstream has to special-case it.
  if (resolved.id === null) {
    resolved = approved;
  }

  const installments = resolved.parts.map((part, index) => ({
    index,
    percent: Number(part.percent),
    amountTtc: percentOfMoney(amount, part.percent),
    condition: part.condition ?? "",
    label: part.label ?? `${Number(part.percent)} % ${part.condition ?? ""}`.trim()
  }));

  const rounded = sumMoney(installments.map((installment) => installment.amountTtc));
  const roundingAdjustment = roundMoney(amount - rounded);
  if (roundingAdjustment !== 0 && installments.length > 0) {
    const last = installments[installments.length - 1];
    last.amountTtc = roundMoney(last.amountTtc + roundingAdjustment);
  }

  const schedule = Object.freeze({
    ruleId: resolved.id,
    label: resolved.label,
    standard: resolved.standard,
    totalTtc: amount,
    roundingAdjustment,
    installments: Object.freeze(installments.map((installment) => Object.freeze({ ...installment })))
  });

  // Belt and braces: the schedule is validated before it is handed out, so a
  // caller can never receive one whose installments do not add up to the TTC.
  const errors = validatePaymentSchedule(schedule);
  if (errors.length > 0) {
    throw new PaymentScheduleError(errors[0].message, errors[0].code, errors[0]);
  }

  return schedule;
}

export function validatePaymentSchedule(schedule) {
  const errors = [];
  if (!schedule || !Array.isArray(schedule.installments) || schedule.installments.length === 0) {
    return Object.freeze([
      { field: "schedule", code: "SCHEDULE_EMPTY", message: "A payment schedule must carry at least one installment." }
    ]);
  }

  schedule.installments.forEach((installment, index) => {
    const percent = Number(installment.percent);
    if (!Number.isFinite(percent) || percent < 0) {
      errors.push({
        field: `schedule.installments.${index}.percent`,
        code: "INSTALLMENT_PERCENT_NEGATIVE",
        message: `Installment ${index + 1} has a negative or unusable percentage.`
      });
    }
    if (percent > 100) {
      errors.push({
        field: `schedule.installments.${index}.percent`,
        code: "INSTALLMENT_PERCENT_ABOVE_100",
        message: `Installment ${index + 1} exceeds 100 %.`
      });
    }
    if (installment.condition === undefined || String(installment.condition).trim() === "") {
      errors.push({
        field: `schedule.installments.${index}.condition`,
        code: "INSTALLMENT_CONDITION_MISSING",
        message: `Installment ${index + 1} states no condition.`
      });
    }
  });

  const percentTotal = roundMoney(schedule.installments.reduce((sum, installment) => sum + Number(installment.percent), 0));
  if (percentTotal !== 100) {
    errors.push({
      field: "schedule.percent",
      code: "SCHEDULE_PERCENT_SUM_INVALID",
      message: `The installments add up to ${percentTotal} % instead of 100 %.`,
      expected: 100,
      actual: percentTotal
    });
  }

  const amountTotal = sumMoney(schedule.installments.map((installment) => installment.amountTtc));
  if (amountTotal !== roundMoney(schedule.totalTtc)) {
    errors.push({
      field: "schedule.totalTtc",
      code: "SCHEDULE_TOTAL_MISMATCH",
      message: `The installments add up to ${amountTotal} instead of ${roundMoney(schedule.totalTtc)}.`,
      expected: roundMoney(schedule.totalTtc),
      actual: amountTotal
    });
  }

  return Object.freeze(errors);
}
