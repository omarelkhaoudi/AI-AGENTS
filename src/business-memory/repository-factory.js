import { createRequire } from "node:module";
import { hasValidDatabaseUrl } from "../persistence/repository-factory.js";
import {
  collectBusinessSourceRecords,
  createBusinessSource
} from "./business-source.js";
import {
  assertBusinessProviderAdapterCompatibility,
  normalizeBusinessProviderAdapter
} from "./business-provider-adapter.js";
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
  const providerAdapter = normalizeBusinessProviderAdapter(env.BUSINESS_PROVIDER_ADAPTER ?? dataProvider);
  assertBusinessProviderAdapterCompatibility({ provider: dataProvider, adapter: providerAdapter });
  return Object.freeze({
    provider,
    dataSource: Object.freeze({
      provider: dataProvider,
      sourceId: normalizeBusinessSourceId(env.BUSINESS_DATA_SOURCE_ID, dataProvider),
      providerAdapter,
      adapterStatus: "offline_configured",
      externalConnectionsEnabled: false
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
  businessSource = null,
  businessProviderAdapter = null
} = {}) {
  const config = createBusinessMemoryConfig(env);
  const source = businessSource ?? createBusinessSource({
    provider: config.dataSource.provider,
    sourceId: config.dataSource.sourceId,
    data,
    adapterId: config.dataSource.providerAdapter,
    adapter: businessProviderAdapter
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

// Prisma is loaded lazily so the demo / in-memory provider starts without
// requiring a generated Prisma Client. The real Prisma path is unchanged.
let prismaModulesCache = null;

export function loadPrismaModules() {
  if (prismaModulesCache) {
    return prismaModulesCache;
  }

  try {
    const requirePrisma = createRequire(import.meta.url);
    const { PrismaClient } = requirePrisma("@prisma/client");
    const { PrismaPg } = requirePrisma("@prisma/adapter-pg");
    prismaModulesCache = Object.freeze({ PrismaClient, PrismaPg });
  } catch (cause) {
    throw new BusinessMemoryConfigurationError(
      "Prisma Client is not available. Run `npm install` and `npm run db:generate` before using BUSINESS_MEMORY_PROVIDER=postgres.",
      {
        causeName: cause?.name ?? "Error",
        causeCode: cause?.code,
        causeMessage: cause?.message ?? String(cause)
      }
    );
  }

  return prismaModulesCache;
}

export function createBusinessMemoryPrismaClient(databaseUrl) {
  const { PrismaClient, PrismaPg } = loadPrismaModules();
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
