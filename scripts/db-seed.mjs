import { existsSync, readFileSync } from "node:fs";
import {
  PrismaRepository,
  createPrismaClient,
  hasValidDatabaseUrl,
  seedMvpAgents
} from "../src/index.js";

loadDotEnvIfPresent();

if (!hasValidDatabaseUrl(process.env.DATABASE_URL)) {
  console.error("DATABASE_URL must be a valid PostgreSQL URL before running db:seed.");
  process.exit(1);
}

const prisma = await createPrismaClient();
const repository = new PrismaRepository({ prisma });

try {
  const agents = await seedMvpAgents(repository);
  console.log(`Seeded ${agents.length} MVP agents: ${agents.map((agent) => agent.id).join(", ")}`);
} finally {
  await repository.disconnect();
}

function loadDotEnvIfPresent(path = ".env") {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = stripQuotes(trimmed.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
