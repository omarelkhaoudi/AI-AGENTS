import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hasValidDatabaseUrl } from "../persistence/repository-factory.js";
import {
  collectBusinessSourceRecords,
  createBusinessSource
} from "./business-source.js";
import { InMemoryBusinessMemoryRepository } from "./in-memory-business-memory.js";
import { PrismaBusinessMemoryRepository } from "./prisma-business-memory-repository.js";
import { normalizeBusinessDataProvider } from "./source.js";

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
  const dataProvider = normalizeBusinessDataProvider(env.BUSINESS_DATA_PROVIDER);
  return Object.freeze({
    provider,
    dataSource: Object.freeze({
      provider: dataProvider,
      sourceId: normalizeBusinessSourceId(env.BUSINESS_DATA_SOURCE_ID, dataProvider)
    }),
    database: Object.freeze({
      hasUrl: hasValidDatabaseUrl(env.DATABASE_URL)
    })
  });
}

export function createBusinessMemoryRepository({
  env = process.env,
  prisma = null,
  data = undefined,
  businessSource = null
} = {}) {
  const config = createBusinessMemoryConfig(env);
  const source = businessSource ?? createBusinessSource({
    provider: config.dataSource.provider,
    sourceId: config.dataSource.sourceId,
    data
  });

  if (config.provider === "memory") {
    return new InMemoryBusinessMemoryRepository({
      records: collectBusinessSourceRecords(source),
      dataSourceDescriptor: source.getSourceDescriptor()
    });
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
    prisma: prisma ?? createBusinessMemoryPrismaClient(env.DATABASE_URL),
    dataSourceDescriptor: source.getSourceDescriptor()
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

function normalizeBusinessSourceId(sourceId, provider) {
  if (typeof sourceId === "string" && sourceId.trim().length > 0) {
    return sourceId.trim();
  }
  return provider;
}
