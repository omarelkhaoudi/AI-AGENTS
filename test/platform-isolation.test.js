import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi } from "../src/index.js";
import { createSecurityConfig } from "../src/security/security-config.js";
import { createMemoryPlatformStore } from "../src/platform/memory-store.js";
import { createPlatformMailer, createTestInbox } from "../src/platform/mailer.js";
import { buildPlatform, readCookie, SESSION_COOKIE } from "../src/platform/server.js";
import { createCompanyService } from "../src/platform/companies.js";
import { generatePortalKeys } from "../src/security/portal-token.js";

// Two companies on one platform: one portal, two cockpits that each hold their
// own database and the same public key. Whatever a person of one company does,
// they never reach the other. Invented companies and accounts only.
const PORTAL = "https://portail.exemple.ma";
const PASSWORD = "example-atelier-26";

async function platform(t) {
  const keys = generatePortalKeys();
  const store = createMemoryPlatformStore();
  const inbox = createTestInbox();
  const portal = buildPlatform({ store, mailer: createPlatformMailer({ env: {}, inbox }), baseUrl: PORTAL, signingKey: keys.privateKey });
  const cockpit = (companyId) => {
    const app = buildApi({
      repository: new InMemoryRepository(),
      companyId,
      subscription: null,
      portalPublicKey: keys.publicKey,
      portalUrl: PORTAL,
      security: createSecurityConfig({ NODE_ENV: "production", RATE_LIMIT_LOGIN_MAX: "100", DIRECTION_TWO_FACTOR: "off" })
    });
    t.after(() => app.close());
    return app;
  };
  const cockpits = { hkids: cockpit("hkids"), recette: cockpit("recette") };

  const post = (url, payload, cookie = "") =>
    portal.inject({ method: "POST", url, payload, headers: { "content-type": "application/json", origin: PORTAL, ...(cookie ? { cookie } : {}) } });
  async function person(name, email) {
    await post("/api/auth/signup", { name, email, password: PASSWORD });
    const mail = (await inbox.messages({ limit: 1 }))[0];
    const token = new URL(mail.text.match(/https:\/\/\S+/)[0].replace("/#/", "/")).searchParams.get("jeton");
    await post("/api/auth/verify-email", { token });
    const login = await post("/api/auth/login", { email, password: PASSWORD });
    return `${SESSION_COOKIE}=${readCookie(login.headers["set-cookie"], SESSION_COOKIE)}`;
  }

  const hiba = await person("Hiba", "hiba@exemple.ma");
  const karim = await person("Karim", "karim@exemple.ma");
  const companies = createCompanyService({ store });
  const base = { country: "MA", sector: "fabrication", contactEmail: "contact@exemple.ma" };
  await companies.link({ ...base, slug: "hkids", legalName: "H KIDS", cockpitUrl: "https://hkids.exemple.ma", ownerEmail: "hiba@exemple.ma" });
  await companies.link({ ...base, slug: "recette", legalName: "Recette", cockpitUrl: "https://recette.exemple.ma", ownerEmail: "karim@exemple.ma" });

  const ticketOf = async (slug, cookie) => {
    const response = await post(`/api/companies/${slug}/enter`, {}, cookie);
    return { response, ticket: response.statusCode === 200 ? response.json().url.split("#portail=")[1] : null };
  };
  const enter = async (companyId, ticket) => {
    const response = await cockpits[companyId].inject({ method: "POST", url: "/api/auth/portal", payload: { token: ticket } });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  return { portal, cockpits, hiba, karim, ticketOf, enter };
}

test("each person lists only their own company", async (t) => {
  const { portal, hiba, karim } = await platform(t);
  const list = async (cookie) => (await portal.inject({ method: "GET", url: "/api/companies", headers: { cookie } })).json().companies.map((company) => company.slug);
  assert.deepEqual(await list(hiba), ["hkids"]);
  assert.deepEqual(await list(karim), ["recette"]);
});

test("the portal gives no ticket for a company one does not belong to, and does not tell whether it exists", async (t) => {
  const { hiba, ticketOf } = await platform(t);
  const other = await ticketOf("recette", hiba);
  const unknown = await ticketOf("inventee", hiba);
  assert.equal(other.response.statusCode, 404);
  assert.deepEqual(other.response.json(), unknown.response.json(), "same answer for another company and for none");
});

test("a ticket for one company never opens the other's cockpit", async (t) => {
  const { hiba, ticketOf, enter } = await platform(t);
  const { ticket } = await ticketOf("hkids", hiba);
  const refused = await enter("recette", ticket);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.details.code, "PORTAL_TOKEN_OTHER_COMPANY");
  assert.equal((await enter("hkids", ticket)).status, 200, "refused elsewhere, it still opens its own company");
});

test("a session of one cockpit is unknown to the other", async (t) => {
  const { cockpits, hiba, karim, ticketOf, enter } = await platform(t);
  const hibaSession = (await enter("hkids", (await ticketOf("hkids", hiba)).ticket)).body.token;
  const karimSession = (await enter("recette", (await ticketOf("recette", karim)).ticket)).body.token;
  const me = (companyId, token) => cockpits[companyId].inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal((await me("hkids", hibaSession)).statusCode, 200);
  assert.equal((await me("recette", hibaSession)).statusCode, 401);
  assert.equal((await me("hkids", karimSession)).statusCode, 401);
});
