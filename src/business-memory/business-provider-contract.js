import {
  BUSINESS_DOMAINS,
  assertBusinessRecordContract,
  filterBusinessRecords,
  normalizeBusinessDomain,
  validateDomain
} from "./domain-contract.js";
import {
  BUSINESS_DATA_PROVIDERS,
  createBusinessDataSourceDescriptor
} from "./source.js";

export const BUSINESS_PROVIDER_CONNECTION_STATUSES = Object.freeze([
  "offline_not_connected",
  "offline_configured"
]);

export const DEFAULT_BUSINESS_PROVIDER_CAPABILITIES = Object.freeze({
  readRecords: true,
  pagination: false,
  incrementalSync: false,
  writeRecords: false
});

export class BusinessProviderContractError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BusinessProviderContractError";
    this.code = code;
    this.details = details;
  }
}

export function createBusinessProviderDescriptor({
  provider = BUSINESS_DATA_PROVIDERS.FUTURE_REAL_DATA,
  sourceId = null,
  label = "Generic business provider",
  supportedDomains = BUSINESS_DOMAINS,
  capabilities = {},
  connectionStatus = "offline_not_connected"
} = {}) {
  const sourceDescriptor = createBusinessDataSourceDescriptor({ provider, sourceId });
  const normalizedDomains = normalizeSupportedDomains(supportedDomains);
  const normalizedCapabilities = normalizeBusinessProviderCapabilities({
    ...DEFAULT_BUSINESS_PROVIDER_CAPABILITIES,
    ...capabilities
  });

  if (!BUSINESS_PROVIDER_CONNECTION_STATUSES.includes(connectionStatus)) {
    throw new BusinessProviderContractError("Unsupported business provider connection status.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR", {
      connectionStatus,
      supportedStatuses: BUSINESS_PROVIDER_CONNECTION_STATUSES
    });
  }

  return Object.freeze({
    ...sourceDescriptor,
    label,
    supportedDomains: normalizedDomains,
    capabilities: normalizedCapabilities,
    connectionStatus,
    externalConnectionsEnabled: false
  });
}

export function assertBusinessProviderContract(provider) {
  const missing = [
    "getProviderDescriptor",
    "listSupportedDomains",
    "readBusinessRecordsPage"
  ].filter((method) => typeof provider?.[method] !== "function");

  if (missing.length > 0) {
    throw new BusinessProviderContractError("Business provider does not implement the required contract.", "INVALID_BUSINESS_PROVIDER", {
      missing
    });
  }

  const descriptor = provider.getProviderDescriptor();
  validateBusinessProviderDescriptor(descriptor);
  const supportedDomains = normalizeSupportedDomains(provider.listSupportedDomains());
  if (!sameOrderedValues(descriptor.supportedDomains, supportedDomains)) {
    throw new BusinessProviderContractError("Business provider descriptor domains must match listSupportedDomains exactly.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR", {
      descriptorDomains: descriptor.supportedDomains,
      supportedDomains
    });
  }
  return true;
}

export function createBusinessProviderReadRequest({
  domain,
  filters = null,
  pagination = null,
  syncToken = null
} = {}) {
  const normalizedDomain = normalizeProviderDomain(domain);
  return Object.freeze({
    domain: normalizedDomain,
    filters,
    pagination: normalizePagination(pagination),
    syncToken
  });
}

export function normalizeBusinessProviderPage(page, { domain, filters = null } = {}) {
  const normalizedDomain = normalizeProviderDomain(domain);
  const normalizedPage = Array.isArray(page) ? { records: page } : page;

  if (!normalizedPage || typeof normalizedPage !== "object" || Array.isArray(normalizedPage)) {
    throw new BusinessProviderContractError("Business provider page must be an object.", "INVALID_BUSINESS_PROVIDER_PAGE");
  }

  if (!Array.isArray(normalizedPage.records)) {
    throw new BusinessProviderContractError("Business provider page records must be an array.", "INVALID_BUSINESS_PROVIDER_PAGE");
  }

  const records = filterBusinessRecords(normalizedPage.records.map((record) => {
    assertBusinessRecordContract(record);
    if (record.domain !== normalizedDomain) {
      throw new BusinessProviderContractError("Business provider returned a record for the wrong domain.", "INVALID_BUSINESS_PROVIDER_RECORD", {
        expectedDomain: normalizedDomain,
        actualDomain: record.domain
      });
    }
    return record;
  }), { filters });

  return Object.freeze({
    records,
    nextCursor: normalizedPage.nextCursor ?? null,
    syncToken: normalizedPage.syncToken ?? null
  });
}

export function validateBusinessProviderDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new BusinessProviderContractError("Business provider descriptor must be an object.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR");
  }
  if (descriptor.externalConnectionsEnabled !== false) {
    throw new BusinessProviderContractError("Business provider external connections must remain disabled.", "BUSINESS_PROVIDER_EXTERNAL_CONNECTION_FORBIDDEN");
  }
  normalizeSupportedDomains(descriptor.supportedDomains);
  normalizeBusinessProviderCapabilities(descriptor.capabilities);
  return true;
}

export function normalizeBusinessProviderCapabilities(capabilities = DEFAULT_BUSINESS_PROVIDER_CAPABILITIES) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new BusinessProviderContractError("capabilities must be an object.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR");
  }
  if (capabilities.writeRecords !== undefined && capabilities.writeRecords !== false) {
    throw new BusinessProviderContractError("Business provider write capability must remain disabled.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR", {
      capability: "writeRecords"
    });
  }

  const normalized = Object.freeze({
    ...DEFAULT_BUSINESS_PROVIDER_CAPABILITIES,
    ...capabilities,
    writeRecords: false
  });

  for (const [capability, value] of Object.entries(normalized)) {
    if (typeof value !== "boolean") {
      throw new BusinessProviderContractError("Business provider capabilities must be booleans.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR", {
        capability
      });
    }
  }

  if (normalized.writeRecords !== false) {
    throw new BusinessProviderContractError("Business provider write capability must remain disabled.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR");
  }

  return normalized;
}

function normalizeSupportedDomains(domains) {
  if (!Array.isArray(domains)) {
    throw new BusinessProviderContractError("supportedDomains must be an array.", "INVALID_BUSINESS_PROVIDER_DESCRIPTOR");
  }
  return Object.freeze([...new Set(domains.map((domain) => normalizeProviderDomain(domain)))]);
}

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeProviderDomain(domain) {
  validateDomain(domain);
  return normalizeBusinessDomain(domain);
}

function normalizePagination(pagination) {
  if (pagination === null || pagination === undefined) {
    return null;
  }
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) {
    throw new BusinessProviderContractError("pagination must be an object when provided.", "INVALID_BUSINESS_PROVIDER_READ_REQUEST");
  }
  return Object.freeze({
    cursor: typeof pagination.cursor === "string" ? pagination.cursor : null,
    limit: Number.isInteger(pagination.limit) && pagination.limit > 0 ? pagination.limit : null
  });
}
