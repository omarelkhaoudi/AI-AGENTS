export const BUSINESS_DATA_SOURCES = Object.freeze({
  DEMO_MOCK: "demo_mock",
  FUTURE_REAL_DATA: "future_real_data"
});

export const BUSINESS_DATA_PROVIDERS = Object.freeze({
  DEMO: "demo",
  FUTURE_REAL_DATA: "future_real_data"
});

export class BusinessDataSourceError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BusinessDataSourceError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeBusinessDataSource(source = BUSINESS_DATA_SOURCES.DEMO_MOCK) {
  if (source === BUSINESS_DATA_SOURCES.DEMO_MOCK || source === BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA) {
    return source;
  }

  throw new BusinessDataSourceError(`Unsupported business data source: ${source}`, "INVALID_DATA_SOURCE", {
    source
  });
}

export function normalizeBusinessDataProvider(provider = BUSINESS_DATA_PROVIDERS.DEMO) {
  const normalized = provider || BUSINESS_DATA_PROVIDERS.DEMO;
  if (Object.values(BUSINESS_DATA_PROVIDERS).includes(normalized)) {
    return normalized;
  }

  throw new BusinessDataSourceError(`Unsupported BUSINESS_DATA_PROVIDER: ${provider}`, "INVALID_DATA_PROVIDER", {
    provider,
    supportedProviders: Object.values(BUSINESS_DATA_PROVIDERS)
  });
}

export function createBusinessDataSourceDescriptor({
  provider = BUSINESS_DATA_PROVIDERS.DEMO,
  sourceId = null
} = {}) {
  const normalizedProvider = normalizeBusinessDataProvider(provider);
  const demo = normalizedProvider === BUSINESS_DATA_PROVIDERS.DEMO;
  return Object.freeze({
    provider: normalizedProvider,
    sourceId: normalizeSourceId(sourceId, normalizedProvider),
    mode: demo ? BUSINESS_DATA_SOURCES.DEMO_MOCK : BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    recordSource: demo ? BUSINESS_DATA_SOURCES.DEMO_MOCK : BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    demo,
    externalConnectionsEnabled: false
  });
}

function normalizeSourceId(sourceId, provider) {
  if (typeof sourceId === "string" && sourceId.trim().length > 0) {
    return sourceId.trim();
  }
  return provider;
}
