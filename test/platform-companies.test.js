import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPlatformStore } from "../src/platform/memory-store.js";
import { createPlatformMailer, createTestInbox } from "../src/platform/mailer.js";
import { buildPlatform, readCookie, SESSION_COOKIE } from "../src/platform/server.js";
import { MAX_COMPANIES_CREATED, createCompanyService, slugFrom } from "../src/platform/companies.js";

const BASE_URL = "https://portail.exemple.ma";
const PASSWORD = "example-atelier-26";
const COMPANY = Object.freeze({
  legalName: "Atelier Élan SARL",
  tradeName: "Atelier Élan",
  country: "MA",
  sector: "fabrication",
  contactEmail: "contact@atelier-elan.ma",
  language: "fr"
});

async function setUp() {
  const store = createMemoryPlatformStore();
  const inbox = createTestInbox();
  const app = buildPlatform({ store, mailer: createPlatformMailer({ env: {}, inbox }), baseUrl: BASE_URL });
  const post = (url, payload, cookie = "") =>
    app.inject({ method: "POST", url, payload, headers: { "content-type": "application/json", origin: BASE_URL, ...(cookie ? { cookie } : {}) } });
  const get = (url, cookie = "") => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

  async function person(name, email) {
    await post("/api/auth/signup", { name, email, password: PASSWORD });
    const mail = (await inbox.messages({ limit: 1 }))[0];
    const token = new URL(mail.text.match(/https:\/\/\S+/)[0].replace("/#/", "/")).searchParams.get("jeton");
    await post("/api/auth/verify-email", { token });
    const login = await post("/api/auth/login", { email, password: PASSWORD });
    return `${SESSION_COOKIE}=${readCookie(login.headers["set-cookie"], SESSION_COOKIE)}`;
  }

  return { app, store, post, get, person };
}

test("a person signed in creates a company and becomes its owner; it waits for its cockpit", async () => {
  const context = await setUp();
  const sara = await context.person("Sara", "sara@atelier-elan.ma");

  const created = await context.post("/api/companies", COMPANY, sara);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().company, {
    slug: "atelier-elan",
    tradeName: "Atelier Élan",
    legalName: "Atelier Élan SARL",
    country: "MA",
    sector: "fabrication",
    role: "owner",
    roleLabel: "Propriétaire",
    status: "provisioning",
    statusLabel: "En création",
    cockpitUrl: null
  });

  const list = await context.get("/api/companies", sara);
  assert.deepEqual(list.json().companies.map((company) => [company.slug, company.role]), [["atelier-elan", "owner"]]);
});

test("without a session nothing is listed nor created", async () => {
  const context = await setUp();
  assert.equal((await context.get("/api/companies")).statusCode, 401);
  assert.equal((await context.post("/api/companies", COMPANY)).statusCode, 401);
  assert.equal((await context.get("/api/companies", `${SESSION_COOKIE}=inventé`)).statusCode, 401);
});

test("each person sees only the companies they belong to", async () => {
  const context = await setUp();
  const sara = await context.person("Sara", "sara@atelier-elan.ma");
  const karim = await context.person("Karim", "karim@bureau-nord.ma");
  await context.post("/api/companies", COMPANY, sara);
  await context.post("/api/companies", { ...COMPANY, legalName: "Bureau Nord", tradeName: "", sector: "services", contactEmail: "contact@bureau-nord.ma" }, karim);

  assert.deepEqual((await context.get("/api/companies", sara)).json().companies.map((company) => company.slug), ["atelier-elan"]);
  assert.deepEqual((await context.get("/api/companies", karim)).json().companies.map((company) => company.tradeName), ["Bureau Nord"]);
});

test("two companies with the same name get two addresses", async () => {
  const context = await setUp();
  const sara = await context.person("Sara", "sara@atelier-elan.ma");
  const karim = await context.person("Karim", "karim@bureau-nord.ma");
  await context.post("/api/companies", COMPANY, sara);
  const second = await context.post("/api/companies", COMPANY, karim);
  assert.equal(second.json().company.slug, "atelier-elan-2");
});

test("the seven answers are checked; nothing is made up for what is missing", async () => {
  const context = await setUp();
  const sara = await context.person("Sara", "sara@atelier-elan.ma");
  const refusal = async (change) => (await context.post("/api/companies", { ...COMPANY, ...change }, sara)).json().details.code;
  assert.equal(await refusal({ legalName: " " }), "FIELD_REQUIRED");
  assert.equal(await refusal({ country: "ZZ" }), "COUNTRY_INVALID");
  assert.equal(await refusal({ sector: "" }), "SECTOR_INVALID");
  assert.equal(await refusal({ contactEmail: "pas-une-adresse" }), "EMAIL_INVALID");
  assert.equal(await refusal({ language: "de" }), "LANGUAGE_INVALID");
  assert.deepEqual((await context.get("/api/companies", sara)).json().companies, []);
});

test(`a person creates at most ${MAX_COMPANIES_CREATED} companies on their own`, async () => {
  const context = await setUp();
  const sara = await context.person("Sara", "sara@atelier-elan.ma");
  for (let index = 1; index <= MAX_COMPANIES_CREATED; index += 1) {
    assert.equal((await context.post("/api/companies", { ...COMPANY, tradeName: `Atelier ${index}` }, sara)).statusCode, 201);
  }
  const over = await context.post("/api/companies", { ...COMPANY, tradeName: "Atelier de trop" }, sara);
  assert.equal(over.statusCode, 409);
  assert.equal(over.json().details.code, "COMPANY_LIMIT");
});

test("a company linked by hand keeps its slug and opens its cockpit; the last owner keeps the role", async () => {
  const context = await setUp();
  const hiba = await context.person("Hiba", "hiba@exemple.ma");
  await context.person("Hicham", "hicham@exemple.ma");
  const companies = createCompanyService({ store: context.store });

  const linked = await companies.link({
    slug: "hkids", legalName: "H KIDS", tradeName: "H-KIDS", country: "MA", sector: "fabrication",
    contactEmail: "contact@exemple.ma", cockpitUrl: "https://hkids-cockpit.duckdns.org/", ownerEmail: "hiba@exemple.ma"
  });
  assert.equal(linked.cockpitUrl, "https://hkids-cockpit.duckdns.org");
  await assert.rejects(
    companies.link({ slug: "hkids", legalName: "Autre", country: "MA", sector: "autre", contactEmail: "a@exemple.ma", cockpitUrl: "https://autre.exemple.ma", ownerEmail: "hiba@exemple.ma" }),
    { code: "SLUG_TAKEN" }
  );
  await assert.rejects(
    companies.link({ slug: "nouvelle", legalName: "Nouvelle", country: "MA", sector: "autre", contactEmail: "a@exemple.ma", cockpitUrl: "https://n.exemple.ma", ownerEmail: "personne@exemple.ma" }),
    { code: "OWNER_UNKNOWN" }
  );

  const list = (await context.get("/api/companies", hiba)).json().companies;
  assert.deepEqual(list.map((company) => [company.slug, company.statusLabel, company.cockpitUrl]), [["hkids", "Active", "https://hkids-cockpit.duckdns.org"]]);

  await assert.rejects(companies.setRole({ slug: "hkids", email: "hiba@exemple.ma", role: "admin" }), { code: "LAST_OWNER" });
  await companies.setRole({ slug: "hkids", email: "hicham@exemple.ma", role: "owner" });
  await companies.setRole({ slug: "hkids", email: "hiba@exemple.ma", role: "admin" });
  await assert.rejects(companies.setRole({ slug: "hkids", email: "hicham@exemple.ma", role: "viewer" }), { code: "LAST_OWNER" });
  await assert.rejects(companies.setRole({ slug: "hkids", email: "hiba@exemple.ma", role: "chef" }), { code: "ROLE_INVALID" });
});

test("a suspended company is listed without the way in", async () => {
  const context = await setUp();
  const hiba = await context.person("Hiba", "hiba@exemple.ma");
  await createCompanyService({ store: context.store }).link({
    slug: "atelier", legalName: "Atelier", country: "MA", sector: "fabrication", contactEmail: "contact@exemple.ma",
    cockpitUrl: "https://atelier.exemple.ma", ownerEmail: "hiba@exemple.ma", status: "suspended"
  });
  const [company] = (await context.get("/api/companies", hiba)).json().companies;
  assert.equal(company.statusLabel, "Suspendue");
  assert.equal(company.cockpitUrl, null);
});

test("a company's address is made of its name, in letters, digits and hyphens", () => {
  assert.equal(slugFrom("Atelier Élan & Fils"), "atelier-elan-fils");
  assert.equal(slugFrom("  H-KIDS  "), "h-kids");
  assert.equal(slugFrom("É"), "entreprise-e");
  assert.equal(slugFrom("شركة"), "entreprise");
  assert.equal(slugFrom("a".repeat(60)).length, 40);
});

test("the portal gives the choices of the creation form", async () => {
  const context = await setUp();
  const config = (await context.get("/api/config")).json();
  assert.equal(config.countries.MA, "Maroc");
  assert.equal(config.sectors.fabrication, "Fabrication sur mesure");
  assert.equal(config.roles.owner, "Propriétaire");
});
