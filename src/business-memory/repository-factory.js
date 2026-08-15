import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hasValidDatabaseUrl } from "../persistence/repository-factory.js";
import { createDemoBusinessMemoryRepository } from "./demo-business-memory.js";
import { PrismaBusinessMemoryRepository } from "./prisma-business-memory-repository.js";

export const BUSINESS_MEMORY_PROVIDERS = Object.freeze(["memory", "postgres"]);

export class BusinessMemoryConfigurationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BusinessMemoryConfigurationError";
    this.code = "BUSINESS_MEMORY_CONFIGURATION_ERROR";
    this.details = details;
  }
}

export function createBusinessMemoryConfig(env = process.env) {
  const provider = normalizeBusinessMemoryProvider(env.BUSINESS_MEMORY_PROVIDER);
  return Object.freeze({
    provider,
    database: Object.freeze({
      hasUrl: hasValidDatabaseUrl(env.DATABASE_URL)
    })
  });
}

export function createBusinessMemoryRepository({
  env = process.env,
  prisma = null,
  data = undefined
} = {}) {
  const config = createBusinessMemoryConfig(env);

  if (config.provider === "memory") {
    return createDemoBusinessMemoryRepository(data);
  }

  if (!hasValidDatabaseUrl(env.DATABASE_URL)) {
    throw new BusinessMemoryConfigurationError(
      "DATABASE_URL must be a valid PostgreSQL URL when BUSINESS_MEMORY_PROVIDER=postgres.",
      {
        provider: config.provider,
        hasDatabaseUrl: Boolean(env.DATABASE_URL)
      }
    );
  }

  return new PrismaBusinessMemoryRepository({
    prisma: prisma ?? createBusinessMemoryPrismaClient(env.DATABASE_URL)
  });
}

export function createBusinessMemoryPrismaClient(databaseUrl) {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

function normalizeBusinessMemoryProvider(provider = "memory") {
  const normalized = provider || "memory";
  if (BUSINESS_MEMORY_PROVIDERS.includes(normalized)) {
    return normalized;
  }

  throw new BusinessMemoryConfigurationError(`Unsupported BUSINESS_MEMORY_PROVIDER: ${provider}`, {
    provider,
    supportedProviders: BUSINESS_MEMORY_PROVIDERS
  });
}
