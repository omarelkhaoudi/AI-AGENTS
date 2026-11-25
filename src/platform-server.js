import { loadDotEnvIfPresent } from "./load-dotenv.js";
import { createMemoryPlatformStore } from "./platform/memory-store.js";
import { createPostgresPlatformStore } from "./platform/postgres-store.js";
import { createPlatformMailer } from "./platform/mailer.js";
import { buildPlatform } from "./platform/server.js";

// The portal of the platform, beside the companies' cockpits:
//
//   npm run platform:start
//
// PLATFORM_BASE_URL   its public address (the links in the e-mails point there);
//                     http://localhost:3100 by default
// PLATFORM_DATABASE_URL  its own PostgreSQL database; without it the records
//                     live in memory and are lost at the stop (to try it out)
// SMTP_*              its mail server; without it the e-mails go to the test
//                     inbox (npm run platform:emails)
loadDotEnvIfPresent();

const port = Number.parseInt(process.env.PLATFORM_PORT ?? "3100", 10);
const host = process.env.HOST ?? "127.0.0.1";
const baseUrl = process.env.PLATFORM_BASE_URL?.trim() || `http://localhost:${port}`;
const databaseUrl = process.env.PLATFORM_DATABASE_URL?.trim();

const store = databaseUrl ? await createPostgresPlatformStore({ connectionString: databaseUrl }) : createMemoryPlatformStore();
const app = buildPlatform({
  store,
  mailer: createPlatformMailer({ log: (line) => console.log(line) }),
  baseUrl,
  trustProxy: process.env.TRUST_PROXY === "true",
  logger: process.env.NODE_ENV === "production"
});

if (!databaseUrl) {
  console.log("Portail sans base de données : les comptes sont perdus à l'arrêt (PLATFORM_DATABASE_URL absent).");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await app.close();
    await store.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port, host });
  console.log(`Portail : ${baseUrl}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
