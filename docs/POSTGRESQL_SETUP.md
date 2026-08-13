# PostgreSQL Setup

This project uses Prisma with PostgreSQL for durable MVP persistence.
Prisma 7 uses the official `@prisma/adapter-pg` driver adapter for runtime database connections.

## Local Setup

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

4. Generate Prisma Client:

```powershell
npm run db:generate
```

5. Apply committed migrations:

```powershell
npm run db:migrate
```

6. Seed the five MVP agents:

```powershell
npm run db:seed
```

## Notes

- Docker is not required by this repository.
- If Docker is already part of your local workflow, any standard PostgreSQL container can be used as long as `DATABASE_URL` points to it.
- The seed is idempotent and can be run multiple times without creating duplicate agents.
- PostgreSQL integration tests are opt-in. Set `RUN_POSTGRES_INTEGRATION=true` and `DATABASE_URL` before running `npm test`.
