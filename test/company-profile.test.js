import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { PILOT_COMPANY, brandPage, brandPayload, brandText, loadCompanyProfile } from "../src/company/company-profile.js";
import { PLANS, aiBudgetOf, assertSeatAvailable, planFromEnv } from "../src/company/plans.js";
import { BLANK_LOGO_PATH, HKIDS_FIXED_IDENTITY, HKIDS_LOGO_PATH, companyLogoPath } from "../src/documents/hkids-template.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// An invented client company, as in every committed fixture.
const OTHER = loadCompanyProfile({
  COMPANY_NAME: "Atelier Exemple",
  COMPANY_SHORT_NAME: "Atelier-Ex",
  COMPANY_CITY: "Fès",
  COMPANY_LEADERS: "Sara | Karim",
  COMPANY_ACTIVITY: "menuiserie sur mesure"
});

test("without settings the cockpit is H-KIDS, exactly as before", () => {
  assert.equal(loadCompanyProfile({}), PILOT_COMPANY);
  assert.equal(HKIDS_FIXED_IDENTITY.companyName, "H KIDS");
  assert.match(HKIDS_FIXED_IDENTITY.legalLine, /ICE:002635757000066/);
  assert.equal(companyLogoPath({}), HKIDS_LOGO_PATH);
  assert.equal(companyLogoPath({ HKIDS_LOGO_PATH: " /app/data/logo.jpg " }), "/app/data/logo.jpg");
  const payload = { instructions: "Tu es le Director IA de H KIDS.", tools: [] };
  assert.equal(brandPayload(payload, PILOT_COMPANY), payload);
  assert.equal(brandPage("H-KIDS · Marrakech", PILOT_COMPANY), "H-KIDS · Marrakech");
});

test("another company keeps nothing of H-KIDS: not its address, legal numbers or rules", () => {
  assert.deepEqual(OTHER.addressLines, []);
  assert.equal(OTHER.legalLine, "");
  assert.deepEqual(OTHER.leaders, ["Sara", "Karim"]);
  assert.match(OTHER.footerMention, /Atelier Exemple/);
  const told = brandText([
    "Tu es le Director IA de H KIDS, fabricant marocain de mobilier et d'aménagement sur mesure pour enfants (Marrakech).",
    "Tu parles à la direction (Hiba, Omar).",
    PILOT_COMPANY.commercialRules,
    "Un message est un brouillon que Hiba enverra elle-même. Documents H-KIDS."
  ].join("\n"), OTHER);
  assert.match(told, /Director IA de Atelier Exemple, menuiserie sur mesure \(Fès\)/);
  assert.match(told, /la direction \(Sara, Karim\)/);
  assert.match(told, /brouillon que Sara enverra/);
  assert.match(told, /Documents Atelier-Ex/);
  assert.doesNotMatch(told, /H KIDS|H-KIDS|Hiba|Marrakech|60 % à la commande/);
  const payload = brandPayload({ instructions: "Équipe H KIDS", tools: [{ name: "x", description: "Catalogue H-KIDS" }] }, OTHER);
  assert.deepEqual([payload.instructions, payload.tools[0].description], ["Équipe Atelier Exemple", "Catalogue Atelier-Ex"]);
  assert.equal(brandPage("<span>H-KIDS · Marrakech</span><title>H-KIDS</title>", OTHER), "<span>Atelier-Ex · Fès</span><title>Atelier-Ex</title>");
  assert.notEqual(BLANK_LOGO_PATH, HKIDS_LOGO_PATH);
});

test("a subscription sets the AI budget and counts the people who sign in", async () => {
  assert.equal(planFromEnv({}), null);
  assert.equal(planFromEnv({ HKIDS_PLAN: " Business " }), PLANS.business);
  assert.throws(() => planFromEnv({ HKIDS_PLAN: "gratuit" }), { code: "PLAN_UNKNOWN" });
  assert.deepEqual(aiBudgetOf({ HKIDS_PLAN: "starter" }), { budgetUsd: 15, stopAtBudget: true });
  assert.deepEqual(aiBudgetOf({ HKIDS_PLAN: "starter", HKIDS_AI_BUDGET_USD: "40" }), { budgetUsd: 40, stopAtBudget: false }, "a budget set by hand wins");
  assert.deepEqual(aiBudgetOf({ HKIDS_PLAN: "enterprise" }), { budgetUsd: null, stopAtBudget: false });

  const repository = new InMemoryRepository();
  for (const id of ["sara", "karim", "nadia"]) {
    await assertSeatAvailable(repository, { userId: id, plan: PLANS.starter });
    repository.upsertUser({ id, email: `${id}@exemple.ma`, role: "leader" });
    repository.setUserPassword(id, "hash");
  }
  await assert.rejects(assertSeatAvailable(repository, { userId: "omar", plan: PLANS.starter }), { code: "PLAN_USERS_FULL" });
  await assertSeatAvailable(repository, { userId: "sara", plan: PLANS.starter });
  await assertSeatAvailable(repository, { userId: "omar", plan: PLANS.business });
  await assertSeatAvailable(repository, { userId: "omar", plan: null });
});

test("the cockpit says which company and which subscription it runs", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), subscription: PLANS.business });
  t.after(() => app.close());
  const company = JSON.parse((await inject({ method: "GET", url: "/api/company" })).body);
  assert.equal(company.name, "H KIDS");
  assert.equal(company.plan.label, "Business");
  assert.equal(company.plan.maxUsers, 10);
  assert.equal(company.plan.usersUsed, 0, "the test signs in with a token: no password account yet");
});
