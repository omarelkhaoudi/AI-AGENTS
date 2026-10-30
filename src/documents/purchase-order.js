import { roundMoney } from "./document-calculations.js";

// Purchase orders carry their own number series, independent of quotes,
// delivery notes and invoices. These were issued by hand before the generator
// existed; they are listed so the generator can never hand one of them out
// again. Orders generated afterwards are found on disk by the service.
export const HKIDS_ISSUED_PURCHASE_ORDER_NUMBERS = Object.freeze(["160", "161", "162", "163"]);

// The plans a purchase order may state. The free-text 50/50 refusal that guards
// delivery notes and invoices exists so old terms are not copied by accident;
// here the plan is picked explicitly for each order, so 50/50 is one of them.
export const HKIDS_PURCHASE_ORDER_PAYMENT_PLANS = Object.freeze([
  Object.freeze({
    id: "hkids-po-50-50",
    label: "50 % d'avance à la commande ; 50 % à la livraison.",
    parts: Object.freeze([
      Object.freeze({ percent: 50, due: "d'avance à la commande" }),
      Object.freeze({ percent: 50, due: "à la livraison" })
    ])
  }),
  Object.freeze({
    id: "hkids-60-20-20-2026",
    label: "60 % à la commande ; 20 % avant livraison ; 20 % après installation.",
    parts: Object.freeze([
      Object.freeze({ percent: 60, due: "à la commande" }),
      Object.freeze({ percent: 20, due: "avant livraison" }),
      Object.freeze({ percent: 20, due: "après installation" })
    ])
  })
]);

export function purchaseOrderPaymentPlan(id) {
  return HKIDS_PURCHASE_ORDER_PAYMENT_PLANS.find((plan) => plan.id === id) ?? null;
}

// The last instalment takes the remainder, so the instalments always add up to
// the total the client signs, to the cent.
export function computeInstalments(plan, totalTtc) {
  let allocated = 0;
  return Object.freeze(plan.parts.map((part, index) => {
    const amount = index === plan.parts.length - 1
      ? roundMoney(totalTtc - allocated)
      : roundMoney(totalTtc * part.percent / 100);
    allocated = roundMoney(allocated + amount);
    return Object.freeze({ percent: part.percent, due: part.due, amount });
  }));
}

export function nextPurchaseOrderNumber(usedNumbers = []) {
  const numbers = [...HKIDS_ISSUED_PURCHASE_ORDER_NUMBERS, ...usedNumbers]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return String(Math.max(0, ...numbers) + 1);
}

export function isPurchaseOrderNumberUsed(documentNumber, usedNumbers = []) {
  const wanted = Number(documentNumber);
  return [...HKIDS_ISSUED_PURCHASE_ORDER_NUMBERS, ...usedNumbers].some((value) => Number(value) === wanted);
}

export const REFERENCE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

// The reference visual arrives as a data URL from the form. Only JPEG and PNG
// are accepted because they are the two formats pdf-lib can embed.
export function parseReferenceImage(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { image: null, error: null };
  }
  const match = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (!match) {
    return { image: null, error: "INVALID_REFERENCE_IMAGE" };
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) {
    return { image: null, error: "INVALID_REFERENCE_IMAGE" };
  }
  if (bytes.length > REFERENCE_IMAGE_MAX_BYTES) {
    return { image: null, error: "REFERENCE_IMAGE_TOO_LARGE" };
  }
  return { image: { format: match[1] === "png" ? "png" : "jpeg", bytes }, error: null };
}
