# PostgreSQL Setup

This project uses Prisma with PostgreSQL for durable MVP persistence.
Prisma 7 uses the official `@prisma/adapter-pg` driver adapter for runtime database connections.

PostgreSQL is optional. The application runs fully offline on the in-memory
business memory, which is the default. You need a database for two things:
durable persistence, and running the integration tests that are skipped
without one.

## Option A — Docker (recommended)

A `docker-compose.yml` is included so the database is reproducible across
machines. It publishes PostgreSQL on host port **5433**, not 5432, because a
PostgreSQL already listening on the default port is common. Set
`POSTGRES_HOST_PORT` if 5433 is taken too.

1. Start the database and wait for it to report healthy:

```powershell
docker compose up -d db
```

2. Install dependencies:

```powershell
npm install
```

3. Create a local `.env` file from `.env.example` and set `DATABASE_URL` to the
   value the compose file provides:

```text
DATABASE_URL="postgresql://ai_agents:ai_agents_local_dev@localhost:5433/ai_agents?schema=public"
```

Those credentials belong to a throwaway local container. They are not secrets,
and they must never be reused anywhere else. Do not commit `.env` or real
credentials.

Then continue with [Common steps](#common-steps).

To stop the database, keeping its data:

```powershell
docker compose down
```

To stop it and drop the data:

```powershell
docker compose down -v
```

## Option B — PostgreSQL installed locally

1. Install dependencies:

```powershell
npm install
```

2. Create a local PostgreSQL database named `ai_agents`.

Use your normal PostgreSQL tooling. For example, with `psql` available:

```powershell
createdb ai_agents
```

3. Create a local `.env` file from `.env.example` and set `DATABASE_URL`.

Example format only:

```text
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/ai_agents?schema=public"
```

Do not commit `.env` or real credentials.

## Common steps

4. Generate Prisma Client:

```powershell
npm run db:generate
```

5. Apply committed migrations:

```powershell
npm run db:migrate
```

6. Seed the ten MVP agents:

```powershell
npm run db:seed
```

The ten agents are `director`, `commercial`, `finance`, `production`,
`purchasing`, `hr`, `after_sales`, `marketing`, `community_manager` and
`legal`. This step seeds agents only: the business tables stay empty, so a run
with `BUSINESS_MEMORY_PROVIDER=postgres` would find no business records yet.

## Choosing where business records are stored

Two environment variables are involved, and they answer different questions.

| Variable | Values | Question it answers |
| --- | --- | --- |
| `BUSINESS_MEMORY_PROVIDER` | `memory`, `postgres` | Where records are stored |
| `BUSINESS_DATA_PROVIDER` | `demo`, `future_real_data` | Where records came from |

`BUSINESS_MEMORY_PROVIDER` defaults to `memory` and needs no database. Setting
it to `postgres` requires a valid `DATABASE_URL`; the application refuses to
start otherwise rather than silently falling back.

`future_real_data` is an offline placeholder that returns no records for every
domain. It exists to keep the real-data boundary typed and validated. No
external connection is enabled anywhere in this repository.

## Integration tests

Thirteen tests are skipped unless PostgreSQL is available. They cover the
request persistence chain, the approval flow, the planner through
orchestration, the tool adapter layer, the business memory domains, the
equivalence between the in-memory and PostgreSQL reports, and three security
guarantees including the one stating that only the hash of an API token is
ever stored.

Set both variables before running the suite:

```powershell
$env:RUN_POSTGRES_INTEGRATION="true"
$env:DATABASE_URL="postgresql://ai_agents:ai_agents_local_dev@localhost:5433/ai_agents?schema=public"
npm test
```

Without both, the suite still passes and reports those thirteen as skipped.

## Notes

- Docker is not required. Option B remains fully supported.
- The agent seed is idempotent and can be run multiple times without creating
  duplicate agents. It rewrites agent permissions from the model on every run,
  so a row that has drifted is restored.
- The demo business records carry dates relative to the day they are built, so
  that a real order is measured against the real clock rather than against a
  date belonging to a fixture. A snapshot seeded yesterday therefore ages:
  re-run `npm run db:seed:business -- --apply` to refresh it, otherwise the
  PostgreSQL report and the in-memory one drift apart.
- The `.env` file is git-ignored; `.env.example` is the only committed copy and
  contains no real values.
