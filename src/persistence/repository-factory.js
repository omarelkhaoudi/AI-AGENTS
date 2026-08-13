import { InMemoryRepository } from "./in-memory-repository.js";
import { PrismaRepository } from "./prisma-repository.js";

export async function createRepository({ env = process.env, prisma } = {}) {
  if (hasValidDatabaseUrl(env.DATABASE_URL)) {
    return prisma ? new PrismaRepository({ prisma }) : PrismaRepository.create();
  }

  return new InMemoryRepository();
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
