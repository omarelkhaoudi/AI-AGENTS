# Backup, restore and handover

The database is the only irreplaceable part of the system. Code is in Git,
configuration is in `.env.example`, agents and demo records are re-seedable.
Real business data is not.

The commands below were run against PostgreSQL 18.1 and verified end to end:
a dump was taken, restored into a separate database, and the row counts of both
databases compared. See [Verifying a backup](#verifying-a-backup).

## What to back up

| What | Where | Recoverable without a backup? |
| --- | --- | --- |
| Business data, requests, audit trail | PostgreSQL | **No** |
| `.env` | Local file, git-ignored | No — recreate from `.env.example` |
| Code, migrations, tests | Git | Yes |
| Agent rows | PostgreSQL | Yes — `npm run db:seed` |
| Demo business records | PostgreSQL | Yes — `npm run db:seed:business -- --apply` |

`.env` holds `DATABASE_URL` and API keys. It is git-ignored and must never be
committed. Keep it wherever your team keeps secrets, not in a dump.

## Taking a backup

`pg_dump` ships with PostgreSQL. On Windows it is under
`C:\Program Files\PostgreSQL\18\bin`.

```bash
pg_dump -h localhost -p 5432 -U postgres -d ai_agents -Fc -f ai_agents_2026-08-21.dump
```

`-Fc` writes the custom format: compressed, and restorable table by table.
`pg_dump` only reads, so it is safe to run against a live database.

Never write a dump inside the repository. It contains real business data, and
the git-ignore rules do not cover it.

A dump is worth what its restore is worth. An untested backup is a hope.

## Restoring

### Into a fresh database

```bash
psql -h localhost -p 5432 -U postgres -d postgres -c "CREATE DATABASE ai_agents;"
pg_restore -h localhost -p 5432 -U postgres -d ai_agents --no-owner ai_agents_2026-08-21.dump
```

`--no-owner` lets the restoring role own everything, which matters when the
dump came from another machine.

### Over an existing database

Restoring over live data is destructive and has no undo. Take a dump of the
current state first, then:

```bash
pg_restore -h localhost -p 5432 -U postgres -d ai_agents --clean --if-exists --no-owner ai_agents_2026-08-21.dump
```

`--clean --if-exists` drops each object before recreating it.

## Verifying a backup

Restore into a database that is not the production one, and compare. This is
the procedure that was run to validate this document:

```bash
psql -h localhost -p 5432 -U postgres -d postgres -c "CREATE DATABASE ai_agents_restore_test;"
pg_restore -h localhost -p 5432 -U postgres -d ai_agents_restore_test --no-owner ai_agents_2026-08-21.dump
```

Then run the same counting query against both databases:

```sql
SELECT 'Agent' AS table, count(*) FROM "Agent"
UNION ALL SELECT 'customers', count(*) FROM customers
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'production', count(*) FROM production
UNION ALL SELECT 'hr_demo_overview', count(*) FROM hr_demo_overview
UNION ALL SELECT 'bills_of_material', count(*) FROM bills_of_material
ORDER BY 1;
```

Both must return the same counts. When they do, drop the test database:

```bash
psql -h localhost -p 5432 -U postgres -d postgres -c "DROP DATABASE ai_agents_restore_test;"
```

`"Agent"` is quoted on purpose: Prisma created it with a capital A, and an
unquoted identifier is folded to lowercase by PostgreSQL.

## Rebuilding from nothing

If the database is lost and there is no dump, the system starts again without
real business data:

```bash
npm install
npm run db:generate      # generate Prisma Client
npm run db:migrate       # apply the five committed migrations
npm run db:seed          # the ten agents, with their permissions
npm run db:seed:business -- --apply   # demo business records, optional
```

Every one of these is idempotent. `db:seed` overwrites agent permissions from
`createMvpAgentPermissions` on each run, so a row that drifted is restored.

Real business data cannot be rebuilt this way. Only a dump brings it back.

## Handing the project to another developer

Everything needed is in the repository. Nothing critical exists only on a
personal machine or account, as CDC section 20 requires.

1. Clone the repository and run `npm install`.
2. Read `docs/AI_AGENTS_FOUNDATION_ARCHITECTURE.md` for how the pieces fit.
3. Read `docs/AGENTS.md` for what each agent may do and touch.
4. Read `docs/DATABASE_SCHEMA.md` for what is stored.
5. Follow `docs/POSTGRESQL_SETUP.md` to get a database running.
6. Create `.env` from `.env.example`, filling in the secrets from your own vault.
7. Run `npm test`. It passes with no database; PostgreSQL tests report as skipped.
8. Set `RUN_POSTGRES_INTEGRATION=true` with a `DATABASE_URL` to run those too.

Read `docs/AGENTS.md` before changing anything about permissions. An agent holds
exactly the domains its own tools need, and
`test/security-no-permission-drift.test.js` fails on any change that was not a
deliberate edit of the model.

## What is not covered

- **No scheduled backup.** These are manual commands. Scheduling them is an
  infrastructure decision that has not been made.
- **No off-site copy.** A dump beside the database is lost with the machine.
- **No point-in-time recovery.** That needs WAL archiving, which is not set up.
