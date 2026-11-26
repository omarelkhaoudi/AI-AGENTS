import { loadDotEnvIfPresent } from "./load-dotenv.js";
import { createMemoryPlatformStore } from "./platform/memory-store.js";
import { createPostgresPlatformStore } from "./platform/postgres-store.js";
import { createPlatformMailer } from "./platform/mailer.js";
import { buildPlatform } from "./platform/server.js";
import { readFileSync } from "node:fs";
import { generatePortalKeys, privateKeyFrom, publicBase64Of } from "./security/portal-token.js";

// The portal of the platform, beside the companies' cockpits:
//
//   npm run platform:start
//
// PLATFORM_BASE_URL   its public address (the links in the e-mails point there);
//                     http://localhost:3100 by default
// PLATFORM_DATABASE_URL  its own PostgreSQL database; without it the records
//                     live in memory and are lost at the stop (to try it out)
// PLATFORM_SIGNING_KEY_FILE  the private key that signs the tickets into the
//                     cockpits (npm run platform:keys makes it); without it a
//                     key is drawn at each start, good for trying it out only
// SMTP_*              its mail server; without it the e-mails go to the test
//                     inbox (npm run platform:emails)
loadDotEnvIfPresent();

const port = Number.parseInt(process.env.PLATFORM_PORT ?? "3100", 10);
const host = process.env.HOST ?? "127.0.0.1";
const baseUrl = process.env.PLATFORM_BASE_URL?.trim() || `http://localhost:${port}`;
const databaseUrl = process.env.PLATFORM_DATABASE_URL?.trim();

const keyFile = process.env.PLATFORM_SIGNING_KEY_FILE?.trim();
let signingKey = keyFile ? privateKeyFrom(readFileSync(keyFile, "utf8")) : privateKeyFrom(process.env.PLATFORM_SIGNING_KEY);
if (!signingKey && process.env.NODE_ENV === "production") {
  console.error("PLATFORM_SIGNING_KEY_FILE manque : en production, la clé doit être la même à chaque démarrage (npm run platform:keys).");
  process.exit(1);
}
if (!signingKey) {
  signingKey = generatePortalKeys().privateKey;
  console.log("Portail sans clé de signature : une clé d'essai est tirée pour cette fois.");
}
console.log(`Clé publique à donner aux cockpits (PORTAL_PUBLIC_KEY) : ${publicBase64Of(signingKey)}`);

const store = databaseUrl ? await createPostgresPlatformStore({ connectionString: databaseUrl }) : createMemoryPlatformStore();
const app = buildPlatform({
  store,
  mailer: createPlatformMailer({ log: (line) => console.log(line) }),
  baseUrl,
  signingKey,
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
