import { randomUUID } from "node:crypto";

// The portal's records in its own PostgreSQL database (PLATFORM_DATABASE_URL),
// never in a company's: the portal knows who may enter which company, nothing
// of what is inside. Same answers as memory-store.js.
//
// The schema is small and the portal's alone, so it is written here as plain
// SQL, applied in order at start-up and remembered in platform_migrations: no
// second Prisma client beside the cockpit's.

export const PLATFORM_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: "001_accounts",
    sql: `
      CREATE TABLE platform_account (
        id uuid PRIMARY KEY,
        email text NOT NULL UNIQUE,
        name text NOT NULL,
        password_hash text NOT NULL,
        email_verified_at timestamptz,
        status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE platform_email_token (
        hash text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
        kind text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz
      );
      CREATE INDEX platform_email_token_account ON platform_email_token (account_id, kind);
      CREATE TABLE platform_session (
        hash text PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX platform_session_account ON platform_session (account_id);
      CREATE TABLE platform_event (
        id bigserial PRIMARY KEY,
        type text NOT NULL,
        account_id uuid,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX platform_event_account ON platform_event (account_id, at);
    `
  })
]);

export async function migratePlatformDatabase(pool) {
  const client = await pool.connect();
  try {
    // One portal applies the migrations at a time, even if two start together.
    await client.query("SELECT pg_advisory_lock(7310421)");
    await client.query("CREATE TABLE IF NOT EXISTS platform_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT id FROM platform_migrations")).rows.map((row) => row.id));
    for (const migration of PLATFORM_MIGRATIONS) {
      if (done.has(migration.id)) {
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO platform_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(7310421)").catch(() => {});
    client.release();
  }
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

function account(row) {
  return row
    ? {
        id: row.id,
        email: row.email,
        name: row.name,
        passwordHash: row.password_hash,
        emailVerifiedAt: iso(row.email_verified_at),
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at)
      }
    : null;
}

export async function createPostgresPlatformStore({ connectionString, pool = null }) {
  let ownPool = null;
  if (!pool) {
    const { default: pg } = await import("pg");
    ownPool = new pg.Pool({ connectionString, max: 5 });
  }
  const db = pool ?? ownPool;
  await migratePlatformDatabase(db);
  const one = async (sql, values) => (await db.query(sql, values)).rows[0] ?? null;

  return Object.freeze({
    kind: "postgres",

    async createAccount({ email, name, passwordHash }) {
      return account(await one(
        `INSERT INTO platform_account (id, email, name, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO NOTHING RETURNING *`,
        [randomUUID(), email, name, passwordHash]
      ));
    },

    async findAccountByEmail(email) {
      return account(await one("SELECT * FROM platform_account WHERE email = $1", [email]));
    },

    async findAccountById(id) {
      return account(await one("SELECT * FROM platform_account WHERE id = $1", [id]));
    },

    async markEmailVerified(id) {
      return account(await one(
        "UPDATE platform_account SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      ));
    },

    async setPasswordHash(id, passwordHash) {
      return account(await one("UPDATE platform_account SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, passwordHash]));
    },

    async createToken({ accountId, kind, hash, expiresAt }) {
      await db.query("INSERT INTO platform_email_token (hash, account_id, kind, expires_at) VALUES ($1, $2, $3, $4)", [hash, accountId, kind, expiresAt]);
    },

    // One UPDATE: two clicks on the same link at once, only one gets through.
    async consumeToken({ kind, hash }) {
      const row = await one(
        `UPDATE platform_email_token SET used_at = now()
         WHERE hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING account_id`,
        [hash, kind]
      );
      return row?.account_id ?? null;
    },

    async deleteTokens({ accountId, kind }) {
      await db.query("DELETE FROM platform_email_token WHERE account_id = $1 AND kind = $2", [accountId, kind]);
    },

    async createSession({ accountId, hash, expiresAt }) {
      await db.query("INSERT INTO platform_session (hash, account_id, expires_at) VALUES ($1, $2, $3)", [hash, accountId, expiresAt]);
    },

    async findSession(hash) {
      const row = await one("SELECT * FROM platform_session WHERE hash = $1 AND expires_at > now()", [hash]);
      return row ? { hash: row.hash, accountId: row.account_id, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at) } : null;
    },

    async deleteSession(hash) {
      await db.query("DELETE FROM platform_session WHERE hash = $1", [hash]);
    },

    async deleteSessions(accountId) {
      await db.query("DELETE FROM platform_session WHERE account_id = $1", [accountId]);
    },

    async record({ type, accountId = null, metadata = {} }) {
      await db.query("INSERT INTO platform_event (type, account_id, metadata) VALUES ($1, $2, $3)", [type, accountId, JSON.stringify(metadata)]);
    },

    async events({ accountId = null } = {}) {
      const rows = (await db.query(
        "SELECT type, account_id, metadata, at FROM platform_event WHERE ($1::uuid IS NULL OR account_id = $1) ORDER BY id",
        [accountId]
      )).rows;
      return rows.map((row) => ({ type: row.type, accountId: row.account_id, metadata: row.metadata, at: iso(row.at) }));
    },

    async close() {
      await ownPool?.end();
    }
  });
}
