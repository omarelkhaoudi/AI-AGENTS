import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPlatformStore } from "../src/platform/memory-store.js";
import { createPostgresPlatformStore } from "../src/platform/postgres-store.js";

// The same answers from both stores: the memory one the tests run on, the
// PostgreSQL one the portal runs on. The second needs a database of its own:
//   RUN_POSTGRES_INTEGRATION=true PLATFORM_TEST_DATABASE_URL=postgresql://… node --test test/platform-store.test.js
// It creates an account with a random address and leaves it there.

const postgresUrl = process.env.PLATFORM_TEST_DATABASE_URL;
const postgresSkip = process.env.RUN_POSTGRES_INTEGRATION === "true" && postgresUrl
  ? false
  : "Set RUN_POSTGRES_INTEGRATION=true and PLATFORM_TEST_DATABASE_URL to run the portal's PostgreSQL store.";

async function contract(store) {
  const email = `essai-${Date.now()}-${Math.random().toString(36).slice(2)}@exemple.ma`;
  const account = await store.createAccount({ email, name: "Essai", passwordHash: "scrypt$x" });
  assert.equal(account.email, email);
  assert.equal(account.emailVerifiedAt, null);
  assert.equal(await store.createAccount({ email, name: "Doublon", passwordHash: "scrypt$y" }), null);
  assert.equal((await store.findAccountByEmail(email)).id, account.id);

  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  await store.createToken({ accountId: account.id, kind: "verify_email", hash: `${email}-a`, expiresAt: future });
  await store.createToken({ accountId: account.id, kind: "verify_email", hash: `${email}-old`, expiresAt: past });
  assert.equal(await store.consumeToken({ kind: "reset_password", hash: `${email}-a` }), null);
  assert.equal(await store.consumeToken({ kind: "verify_email", hash: `${email}-old` }), null);
  const [first, second] = await Promise.all([
    store.consumeToken({ kind: "verify_email", hash: `${email}-a` }),
    store.consumeToken({ kind: "verify_email", hash: `${email}-a` })
  ]);
  assert.deepEqual([first, second].filter(Boolean), [account.id]);

  const verified = await store.markEmailVerified(account.id);
  assert.ok(verified.emailVerifiedAt);
  assert.equal((await store.markEmailVerified(account.id)).emailVerifiedAt, verified.emailVerifiedAt);

  await store.createSession({ accountId: account.id, hash: `${email}-s1`, expiresAt: future });
  await store.createSession({ accountId: account.id, hash: `${email}-s2`, expiresAt: future });
  await store.createSession({ accountId: account.id, hash: `${email}-s3`, expiresAt: past });
  assert.equal((await store.findSession(`${email}-s1`)).accountId, account.id);
  assert.equal(await store.findSession(`${email}-s3`), null);
  await store.deleteSessions(account.id);
  assert.equal(await store.findSession(`${email}-s2`), null);

  const slug = `essai-${Math.random().toString(36).slice(2, 10)}`;
  const fields = { legalName: "Essai SARL", tradeName: "Essai", country: "MA", sector: "autre", contactEmail: email, language: "fr", status: "provisioning", ownerAccountId: account.id };
  const created = await store.createCompany({ ...fields, slug });
  assert.equal(created.slug, slug);
  assert.equal((await store.createCompany({ ...fields, slug })).slug, `${slug}-2`);
  assert.equal(await store.createCompany({ ...fields, slug, exact: true }), null);
  assert.equal(await store.countCompaniesCreatedBy(account.id), 2);
  assert.deepEqual((await store.listMemberships(account.id)).map((entry) => [entry.company.slug, entry.role]).sort(), [[slug, "owner"], [`${slug}-2`, "owner"]]);
  assert.deepEqual(await store.setMembership({ accountId: account.id, companyId: created.id, role: "admin" }), { refused: "LAST_OWNER" });
  const other = await store.createAccount({ email: `autre-${email}`, name: "Autre", passwordHash: "scrypt$z" });
  assert.equal((await store.setMembership({ accountId: other.id, companyId: created.id, role: "owner" })).membership.role, "owner");
  assert.equal((await store.setMembership({ accountId: account.id, companyId: created.id, role: "admin" })).membership.role, "admin");
  assert.deepEqual((await store.listMembers(created.id)).map((member) => member.role).sort(), ["admin", "owner"]);

  await store.record({ type: "essai", accountId: account.id, metadata: { n: 1 } });
  const events = await store.events({ accountId: account.id });
  assert.deepEqual(events.map((event) => [event.type, event.metadata]), [["essai", { n: 1 }]]);
}

test("the memory store keeps the portal's contract", async () => {
  await contract(createMemoryPlatformStore());
});

test("the PostgreSQL store keeps the portal's contract", { skip: postgresSkip }, async () => {
  const store = await createPostgresPlatformStore({ connectionString: postgresUrl });
  try {
    await contract(store);
  } finally {
    await store.close();
  }
});
