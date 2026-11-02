export const DEFAULT_TVA_RATE = 0.2;

// Every amount in this file is a number of dirhams held to two decimals. There
// is no floating point tolerance anywhere else in the module: an amount is
// rounded once, here, and compared as an exact value afterwards.
export const MONEY_SCALE = 2;

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Rounds every term before adding, so a total is the sum of the amounts a
// reader can see on the document rather than of the unrounded ones behind them.
export function sumMoney(values = []) {
  return roundMoney(values.reduce((total, value) => total + roundMoney(value), 0));
}

export function percentOfMoney(amount, percent) {
  return roundMoney(Number(amount) * (Number(percent) / 100));
}

// Two decimals, always, even when the amount is round: "50 000,00" and not
// "50 000". A document that drops the decimals on some lines and keeps them on
// others reads as a mistake.
export function formatMoneyAmount(value) {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: MONEY_SCALE,
    maximumFractionDigits: MONEY_SCALE
  })
    .format(roundMoney(value))
    .replace(/ /g, " ");
}

export function isMoneyAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && roundMoney(amount) === amount;
}

// The totals a caller must always provide, and the ones it may. The required
// three are what every H-KIDS document has carried since the beginning; the
// optional ones describe a discount and are only checked when the caller states
// them, so a document without a discount is unaffected.
export const REQUIRED_TOTAL_FIELDS = Object.freeze(["totalHt", "tva", "totalTtc"]);
export const OPTIONAL_TOTAL_FIELDS = Object.freeze(["totalBrutHt", "totalDiscount", "totalNetHt"]);

export class DocumentCalculationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DocumentCalculationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// A discount never spreads on its own. `appliesToIndexes` names the lines it
// touches and is mandatory: a global percentage with no target used to be read
// as "every line", which is how a commercial gesture on three pieces of
// furniture silently became a rebate on the whole order.
function resolveDiscountTargets(discount, itemCount) {
  const indexes = discount.appliesToIndexes;
  if (!Array.isArray(indexes)) {
    throw new DocumentCalculationError(
      "A global discount must name the lines it applies to: appliesToIndexes is required.",
      "DISCOUNT_TARGET_REQUIRED",
      { percent: discount.percent ?? null }
    );
  }
  if (indexes.length === 0) {
    throw new DocumentCalculationError(
      "A global discount must apply to at least one line.",
      "DISCOUNT_TARGET_EMPTY",
      { percent: discount.percent ?? null }
    );
  }
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= itemCount) {
      throw new DocumentCalculationError(
        `A global discount targets line ${index}, which does not exist.`,
        "DISCOUNT_TARGET_UNKNOWN",
        { index, itemCount }
      );
    }
  }
  return new Set(indexes);
}

function assertPercent(value, code, field) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new DocumentCalculationError(
      `${field} must be a percentage between 0 and 100.`,
      code,
      { field, value }
    );
  }
  return percent;
}

// Whether a field of a discount was stated at all. Absent, null or empty is not
// stated; zero is. The same reading a line's own discount is given.
function isStated(value) {
  return value !== undefined && value !== null && value !== "";
}

// A rebate of a fixed amount on the document as a whole — file 7's "remise
// exceptionnelle" of 2 333,33 — or null when the discount is not one.
//
// It names no line: it is taken off the total, so a target would say it lands on
// lines it never touches. It is never taken with a percentage: a discount stating
// both carries two rebates, and keeping one of them would be guessing which. And
// it is held to the two decimals every amount here has: one with more is refused
// rather than rounded into a figure nobody stated.
function resolveFixedDiscount(discount) {
  if (!isStated(discount.fixedAmount)) {
    return null;
  }
  if (isStated(discount.percent)) {
    throw new DocumentCalculationError(
      "A discount is a percentage or a fixed amount, never both.",
      "DISCOUNT_FIXED_WITH_PERCENT",
      { percent: discount.percent, fixedAmount: discount.fixedAmount }
    );
  }
  if (isStated(discount.appliesToIndexes)) {
    throw new DocumentCalculationError(
      "A fixed discount is taken on the document as a whole and names no line: appliesToIndexes must be absent.",
      "DISCOUNT_FIXED_WITH_TARGETS",
      { appliesToIndexes: discount.appliesToIndexes }
    );
  }

  const raw = discount.fixedAmount;
  const amount = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new DocumentCalculationError(
      "discount.fixedAmount must be a positive amount.",
      "DISCOUNT_FIXED_INVALID",
      { fixedAmount: raw }
    );
  }
  if (!isMoneyAmount(amount)) {
    throw new DocumentCalculationError(
      "discount.fixedAmount must have at most two decimals.",
      "DISCOUNT_FIXED_PRECISION",
      { fixedAmount: raw }
    );
  }
  return amount;
}

// The discount carried by one line: either a percentage of that line, or an
// explicit amount. Both at once is a contradiction and is refused rather than
// resolved by an arbitrary precedence rule.
function lineDiscountAmount(item, grossAmount, index) {
  const hasPercent = item.discountPercent !== undefined && item.discountPercent !== null && item.discountPercent !== "";
  const hasAmount = item.discountAmount !== undefined && item.discountAmount !== null && item.discountAmount !== "";

  if (hasPercent && hasAmount) {
    throw new DocumentCalculationError(
      `Line ${index} carries both discountPercent and discountAmount.`,
      "LINE_DISCOUNT_AMBIGUOUS",
      { index }
    );
  }
  if (hasPercent) {
    return percentOfMoney(grossAmount, assertPercent(item.discountPercent, "LINE_DISCOUNT_INVALID", `items.${index}.discountPercent`));
  }
  if (!hasAmount) {
    return 0;
  }

  const amount = roundMoney(item.discountAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new DocumentCalculationError(
      `items.${index}.discountAmount must be a positive amount.`,
      "LINE_DISCOUNT_INVALID",
      { index, value: item.discountAmount }
    );
  }
  return amount;
}

/**
 * Computes the line amounts and the totals of a document.
 *
 * Called with two arguments it behaves exactly as it always has: no discount,
 * `totals.totalHt` is the sum of the lines. The third argument adds the
 * discount, and `totalHt` then carries the net — what is actually invoiced —
 * while the gross and the rebate are reported beside it.
 *
 * The document's discount is one of two kinds. A percentage (`percent`, with
 * `appliesToIndexes`) is taken line by line, on the lines it names. A fixed amount
 * (`fixedAmount`) is taken off the total once the lines are computed: no line
 * receives a share of it, and every line keeps the figures it has without it.
 */
export function calculateDocumentTotals(items = [], tvaRate = DEFAULT_TVA_RATE, options = {}) {
  const rate = Number(tvaRate);
  const discount = options.discount ?? null;
  const fixedDiscount = discount ? resolveFixedDiscount(discount) : null;
  // Targets and percentages concern a percentage only, and are read exactly as
  // they were before a fixed amount existed.
  const percentDiscount = fixedDiscount === null ? discount : null;
  const targets = percentDiscount ? resolveDiscountTargets(percentDiscount, items.length) : null;
  const globalPercent = percentDiscount
    ? assertPercent(percentDiscount.percent, "DISCOUNT_PERCENT_INVALID", "discount.percent")
    : 0;

  const normalizedItems = items.map((item, index) => {
    const quantity = Number(item.quantity);
    const unitPriceHt = Number(item.unitPriceHt);
    const grossAmountHt = roundMoney(quantity * unitPriceHt);

    const lineDiscount = lineDiscountAmount(item, grossAmountHt, index);
    const afterLineDiscount = roundMoney(grossAmountHt - lineDiscount);
    const globalDiscount = targets?.has(index) ? percentOfMoney(afterLineDiscount, globalPercent) : 0;
    const discountAmount = roundMoney(lineDiscount + globalDiscount);
    const netAmountHt = roundMoney(grossAmountHt - discountAmount);

    if (netAmountHt < 0) {
      throw new DocumentCalculationError(
        `Line ${index} is discounted below zero.`,
        "LINE_DISCOUNT_EXCEEDS_AMOUNT",
        { index, grossAmountHt, discountAmount }
      );
    }

    const unitPriceTtc = roundMoney(unitPriceHt * (1 + rate));

    return Object.freeze({
      ...item,
      quantity,
      unitPriceHt,
      // amountHt stays the gross line amount, which is what it has always been
      // and what the existing renderers print.
      amountHt: grossAmountHt,
      discountAmount,
      netAmountHt,
      tva: roundMoney(netAmountHt * rate),
      unitPriceTtc,
      totalTtc: roundMoney(netAmountHt * (1 + rate))
    });
  });

  const totalBrutHt = sumMoney(normalizedItems.map((item) => item.amountHt));
  // What the lines take off: their own rebates, and their shares of a percentage.
  const linesDiscount = sumMoney(normalizedItems.map((item) => item.discountAmount));
  // A fixed amount is taken on what the lines come to once theirs are off, and
  // never takes more than that: a document is not invoiced below zero.
  const linesNetHt = roundMoney(totalBrutHt - linesDiscount);
  if (fixedDiscount !== null && fixedDiscount > linesNetHt) {
    throw new DocumentCalculationError(
      `discount.fixedAmount (${fixedDiscount}) exceeds the ${linesNetHt} HT it is taken on.`,
      "DISCOUNT_FIXED_EXCEEDS_AMOUNT",
      { fixedAmount: fixedDiscount, baseHt: linesNetHt }
    );
  }
  const totalDiscount = fixedDiscount === null ? linesDiscount : roundMoney(linesDiscount + fixedDiscount);
  const totalNetHt = roundMoney(totalBrutHt - totalDiscount);
  const tva = roundMoney(totalNetHt * rate);
  const totalTtc = roundMoney(totalNetHt + tva);

  return Object.freeze({
    items: Object.freeze(normalizedItems),
    totals: Object.freeze({
      totalBrutHt,
      totalDiscount,
      totalNetHt,
      // totalHt is the net: it is the figure the document invoices, and it is
      // identical to the gross whenever there is no discount.
      totalHt: totalNetHt,
      tva,
      totalTtc,
      tvaRate: rate
    }),
    discount: percentDiscount
      ? Object.freeze({
        percent: globalPercent,
        appliesToIndexes: Object.freeze([...targets].sort((a, b) => a - b)),
        label: typeof discount.label === "string" ? discount.label.trim() : "",
        // The base the percentage was taken on, so a reader can check the
        // rebate without re-deriving which lines were concerned.
        baseHt: sumMoney(normalizedItems.filter((_, index) => targets.has(index)).map((item) => item.amountHt)),
        amount: totalDiscount
      })
      : fixedDiscount !== null
        ? Object.freeze({
          fixedAmount: fixedDiscount,
          label: typeof discount.label === "string" ? discount.label.trim() : "",
          // What it was taken on: the lines, after their own rebates.
          baseHt: linesNetHt,
          amount: totalDiscount
        })
        : null
  });
}

export function assertProvidedTotalsMatch(calculated, providedTotals = {}) {
  const errors = [];
  const checked = [
    ...REQUIRED_TOTAL_FIELDS,
    // An optional total is only compared when the caller states it, so adding
    // the discount fields cannot make an existing document fail.
    ...OPTIONAL_TOTAL_FIELDS.filter((field) => providedTotals[field] !== undefined && providedTotals[field] !== null)
  ];

  for (const field of checked) {
    const expected = calculated.totals[field];
    const provided = Number(providedTotals[field]);
    if (!Number.isFinite(provided) || roundMoney(provided) !== expected) {
      errors.push({
        field: `totals.${field}`,
        code: "TOTAL_MISMATCH",
        message: `${field} must equal ${expected}.`,
        expected,
        actual: Number.isFinite(provided) ? roundMoney(provided) : providedTotals[field]
      });
    }
  }

  return Object.freeze(errors);
}
