export const BUSINESS_DATA_SOURCES = Object.freeze({
  DEMO_MOCK: "demo_mock",
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
