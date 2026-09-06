import { InMemoryRepository } from "./in-memory-repository.js";
import { PrismaRepository } from "./prisma-repository.js";

export class RepositoryConfigurationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RepositoryConfigurationError";
    this.code = "DATABASE_URL_INVALID";
    this.details = Object.freeze({ ...details });
  }
}

// Two situations that used to be one, and the difference is whether an operator
// asked for a database.
//
// No DATABASE_URL at all is the in-memory mode: nothing was configured, so
// nothing is expected, and the application starts offline as designed. The demo
// path and the tests rely on this and keep it.
//
// A DATABASE_URL that is set but is not a PostgreSQL URL is a mistake, not a
// mode. Falling back to memory there produced an application that started,
// answered every request, persisted nothing, and said nothing about it: the
// worst failure to diagnose on a fresh installation. It now refuses.
//
// The value itself never reaches the error: a connection string carries a
// password.
export async function createRepository({ env = process.env, prisma } = {}) {
  const databaseUrl = env.DATABASE_URL;

  if (!isDatabaseUrlConfigured(databaseUrl)) {
    return new InMemoryRepository();
  }

  if (!hasValidDatabaseUrl(databaseUrl)) {
    throw new RepositoryConfigurationError(
      "DATABASE_URL is set but is not a valid PostgreSQL connection string. Fix it, or remove it to run on the in-memory repository.",
      { hasDatabaseUrl: true, expectedProtocols: ["postgresql:", "postgres:"] }
    );
  }

  return prisma ? new PrismaRepository({ prisma }) : PrismaRepository.create();
}

// Set to something. Absent, or blank, is a legitimate choice and means the
// in-memory repository; anything else is a claim that a database exists.
export function isDatabaseUrlConfigured(databaseUrl) {
  return typeof databaseUrl === "string" && databaseUrl.trim() !== "";
}

export function hasValidDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    return false;
  }

  try {
    const parsed = new URL(databaseUrl);
    return parsed.protocol === "postgresql:" || parsed.protocol === "postgres:";
  } catch {
    return false;
  }
}
