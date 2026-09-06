export const DEFAULT_TVA_RATE = 0.2;

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function calculateDocumentTotals(items = [], tvaRate = DEFAULT_TVA_RATE) {
  const normalizedItems = items.map((item) => {
    const quantity = Number(item.quantity);
    const unitPriceHt = Number(item.unitPriceHt);
    const itemTva = roundMoney(quantity * unitPriceHt * Number(tvaRate));
    const unitPriceTtc = roundMoney(unitPriceHt * (1 + Number(tvaRate)));
    return Object.freeze({
      ...item,
      quantity,
      unitPriceHt,
      amountHt: roundMoney(quantity * unitPriceHt),
      tva: itemTva,
      unitPriceTtc,
      totalTtc: roundMoney(quantity * unitPriceTtc)
    });
  });

  const totalHt = roundMoney(normalizedItems.reduce((sum, item) => sum + item.amountHt, 0));
  const tva = roundMoney(totalHt * Number(tvaRate));
  const totalTtc = roundMoney(totalHt + tva);

  return Object.freeze({
    items: Object.freeze(normalizedItems),
    totals: Object.freeze({ totalHt, tva, totalTtc, tvaRate: Number(tvaRate) })
  });
}

export function assertProvidedTotalsMatch(calculated, providedTotals = {}) {
  const errors = [];
  for (const [field, expected] of Object.entries(calculated.totals)) {
    if (field === "tvaRate") {
      continue;
    }
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
