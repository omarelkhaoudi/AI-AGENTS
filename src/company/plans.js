// The subscriptions of the SaaS (CDC section 14). The prices are the spec's
// hypotheses, to be tested, not market prices. An instance gets its plan from
// HKIDS_PLAN; without one (the pilot, H-KIDS) nothing is limited.

export const PLANS = Object.freeze({
  starter: Object.freeze({ id: "starter", label: "Starter", priceMad: 499, maxUsers: 3, aiBudgetUsd: 15 }),
  business: Object.freeze({ id: "business", label: "Business", priceMad: 1499, maxUsers: 10, aiBudgetUsd: 60 }),
  enterprise: Object.freeze({ id: "enterprise", label: "Enterprise", priceMad: 3999, maxUsers: null, aiBudgetUsd: null })
});

export class PlanError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

export function planFromEnv(env = process.env) {
  const id = typeof env.HKIDS_PLAN === "string" ? env.HKIDS_PLAN.trim().toLowerCase() : "";
  if (id === "") {
    return null;
  }
  if (!Object.hasOwn(PLANS, id)) {
    throw new PlanError(`Offre inconnue : ${id}. Offres : ${Object.keys(PLANS).join(", ")}.`, "PLAN_UNKNOWN");
  }
  return PLANS[id];
}

// The monthly AI budget: HKIDS_AI_BUDGET_USD when set, else the plan's, which
// stops the Director once reached (the company pays a fixed price).
export function aiBudgetOf(env = process.env) {
  const set = Number(env.HKIDS_AI_BUDGET_USD);
  const stop = String(env.HKIDS_AI_BUDGET_STOP ?? "").trim().toLowerCase() === "on";
  if (set > 0) {
    return { budgetUsd: set, stopAtBudget: stop };
  }
  const plan = planFromEnv(env);
  return plan?.aiBudgetUsd ? { budgetUsd: plan.aiBudgetUsd, stopAtBudget: true } : { budgetUsd: null, stopAtBudget: stop };
}

// Refuses a new person past the plan's number of users; changing an existing
// account (its password, its role) is always allowed.
export async function assertSeatAvailable(repository, { userId, plan }) {
  if (!plan?.maxUsers) {
    return;
  }
  const existing = await repository.getUser(userId);
  if (existing?.status === "active") {
    return;
  }
  const used = await repository.countSignInUsers();
  if (used >= plan.maxUsers) {
    throw new PlanError(`L'offre ${plan.label} compte ${plan.maxUsers} utilisateurs, tous déjà pris. Désactivez un compte ou passez à l'offre supérieure.`, "PLAN_USERS_FULL");
  }
}
