import { randomUUID } from "node:crypto";

// The portal's records kept in memory: the tests, and a portal started with no
// PLATFORM_DATABASE_URL to try it out. It answers exactly as postgres-store.js
// does; a record leaves it as a copy, never as the object it keeps.
//
// The portal knows people and their access, never a company's business data:
// accounts, one-time e-mail tokens, sessions, the companies with who belongs
// to each and in which role, and its own journal.

export function createMemoryPlatformStore({ clock = () => new Date() } = {}) {
  const accounts = new Map();
  const tokens = new Map();
  const sessions = new Map();
  const journal = [];
  const companies = new Map();
  const memberships = [];
  const copy = (record) => (record ? structuredClone(record) : null);

  return Object.freeze({
    kind: "memory",

    async createAccount({ email, name, passwordHash }) {
      if ([...accounts.values()].some((account) => account.email === email)) {
        return null;
      }
      const now = clock().toISOString();
      const account = { id: randomUUID(), email, name, passwordHash, emailVerifiedAt: null, status: "active", createdAt: now, updatedAt: now };
      accounts.set(account.id, account);
      return copy(account);
    },

    async findAccountByEmail(email) {
      return copy([...accounts.values()].find((account) => account.email === email));
    },

    async findAccountById(id) {
      return copy(accounts.get(id));
    },

    async markEmailVerified(id) {
      const account = accounts.get(id);
      if (account && !account.emailVerifiedAt) {
        account.emailVerifiedAt = clock().toISOString();
        account.updatedAt = account.emailVerifiedAt;
      }
      return copy(account);
    },

    async setPasswordHash(id, passwordHash) {
      const account = accounts.get(id);
      if (account) {
        account.passwordHash = passwordHash;
        account.updatedAt = clock().toISOString();
      }
      return copy(account);
    },

    // kind: verify_email or reset_password. Only the hash of the secret is kept.
    async createToken({ accountId, kind, hash, expiresAt }) {
      tokens.set(hash, { hash, accountId, kind, expiresAt, usedAt: null });
    },

    // The account of a token still valid, used up at once: a link works once.
    async consumeToken({ kind, hash }) {
      const token = tokens.get(hash);
      if (!token || token.kind !== kind || token.usedAt || token.expiresAt <= clock().toISOString()) {
        return null;
      }
      token.usedAt = clock().toISOString();
      return token.accountId;
    },

    async deleteTokens({ accountId, kind }) {
      for (const [hash, token] of tokens) {
        if (token.accountId === accountId && token.kind === kind) {
          tokens.delete(hash);
        }
      }
    },

    async createSession({ accountId, hash, expiresAt }) {
      sessions.set(hash, { hash, accountId, expiresAt, createdAt: clock().toISOString() });
    },

    async findSession(hash) {
      const session = sessions.get(hash);
      return session && session.expiresAt > clock().toISOString() ? copy(session) : null;
    },

    async deleteSession(hash) {
      sessions.delete(hash);
    },

    async deleteSessions(accountId) {
      for (const [hash, session] of sessions) {
        if (session.accountId === accountId) {
          sessions.delete(hash);
        }
      }
    },

    // slug: the exact one when exact (a company linked by hand), else the first
    // free one of slug, slug-2, slug-3… The creator becomes its owner.
    async createCompany({ slug, exact = false, legalName, tradeName, country, sector, contactEmail, language, status, cockpitUrl = null, ownerAccountId }) {
      const taken = (candidate) => [...companies.values()].some((company) => company.slug === candidate);
      let chosen = slug;
      for (let index = 2; taken(chosen); index += 1) {
        if (exact) {
          return null;
        }
        chosen = `${slug}-${index}`;
      }
      const now = clock().toISOString();
      const company = { id: randomUUID(), slug: chosen, legalName, tradeName, country, sector, contactEmail, language, status, cockpitUrl, createdBy: ownerAccountId, createdAt: now, updatedAt: now };
      companies.set(company.id, company);
      memberships.push({ accountId: ownerAccountId, companyId: company.id, role: "owner", status: "active", createdAt: now });
      return copy(company);
    },

    async findCompanyBySlug(slug) {
      return copy([...companies.values()].find((company) => company.slug === slug));
    },

    async countCompaniesCreatedBy(accountId) {
      return [...companies.values()].filter((company) => company.createdBy === accountId).length;
    },

    async listMemberships(accountId) {
      return memberships
        .filter((membership) => membership.accountId === accountId)
        .map((membership) => ({ role: membership.role, status: membership.status, company: copy(companies.get(membership.companyId)) }))
        .sort((left, right) => left.company.tradeName.localeCompare(right.company.tradeName, "fr"));
    },

    async listMembers(companyId) {
      return memberships.filter((membership) => membership.companyId === companyId).map(copy);
    },

    // A company always keeps an active owner: the last one cannot be given
    // another role (cahier des charges, section 2).
    async setMembership({ accountId, companyId, role }) {
      const existing = memberships.find((membership) => membership.accountId === accountId && membership.companyId === companyId);
      const owners = memberships.filter((membership) => membership.companyId === companyId && membership.role === "owner" && membership.status === "active");
      if (existing?.role === "owner" && role !== "owner" && owners.length <= 1) {
        return { refused: "LAST_OWNER" };
      }
      if (existing) {
        existing.role = role;
      } else {
        memberships.push({ accountId, companyId, role, status: "active", createdAt: clock().toISOString() });
      }
      return { membership: copy(existing ?? memberships.at(-1)) };
    },

    async record({ type, accountId = null, metadata = {} }) {
      journal.push({ type, accountId, metadata: structuredClone(metadata), at: clock().toISOString() });
    },

    async events({ accountId = null } = {}) {
      return journal.filter((event) => accountId === null || event.accountId === accountId).map(copy);
    },

    async close() {}
  });
}
