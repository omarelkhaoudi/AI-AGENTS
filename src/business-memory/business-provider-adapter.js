import { createDemoCompanyData } from "../demo/company-data.js";
import {
  BUSINESS_DOMAINS,
  assertBusinessRecordContract,
  filterBusinessRecords,
  normalizeBusinessDomain,
  validateDomain
} from "./domain-contract.js";
import { createDemoBusinessRecords } from "./demo-business-memory.js";
import {
  BUSINESS_DATA_PROVIDERS,
  createBusinessDataSourceDescriptor,
  normalizeBusinessDataProvider
} from "./source.js";
import {
  assertBusinessProviderContract,
  createBusinessProviderReadRequest,
  normalizeBusinessProviderCapabilities,
  normalizeBusinessProviderPage,
  validateBusinessProviderDescriptor
} from "./business-provider-contract.js";

export const BUSINESS_PROVIDER_ADAPTERS = Object.freeze({
  DEMO: "demo",
  FUTURE_REAL_DATA: "future_real_data"
});

export class BusinessProviderAdapterContractError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BusinessProviderAdapterContractError";
    this.code = code;
    this.details = details;
  }
}

export class DemoBusinessProviderAdapter {
  constructor({ data = createDemoCompanyData(), descriptor = createBusinessDataSourceDescriptor() } = {}) {
    this.descriptor = createProviderAdapterDescriptor({
      descriptor,
      adapter: BUSINESS_PROVIDER_ADAPTERS.DEMO,
      supportedDomains: BUSINESS_DOMAINS
    });
    this.records = normalizeProviderRecords(createDemoBusinessRecords(data));
    assertBusinessProviderAdapterContract(this);
  }

  getProviderDescriptor() {
    return this.descriptor;
  }

  listBusinessDomains() {
    return [...BUSINESS_DOMAINS];
  }

  listBusinessRecords({ domain, filters = null } = {}) {
    const normalizedDomain = normalizeProviderDomain(domain);
    return filterBusinessRecords(
      this.records.filter((record) => record.domain === normalizedDomain),
      { filters }
    );
  }

  listBusinessRecordsByDomain({ filters = null } = {}) {
    return Object.freeze(Object.fromEntries(
      BUSINESS_DOMAINS.map((domain) => [domain, this.listBusinessRecords({ domain, filters })])
    ));
  }
}

export class FutureRealDataProviderAdapter {
  constructor({
    descriptor = createBusinessDataSourceDescriptor({
      provider: BUSINESS_DATA_PROVIDERS.FUTURE_REAL_DATA
    }),
    adapter = BUSINESS_PROVIDER_ADAPTERS.FUTURE_REAL_DATA
  } = {}) {
    this.descriptor = createProviderAdapterDescriptor({ descriptor, adapter });
    assertBusinessProviderAdapterContract(this);
  }

  getProviderDescriptor() {
    return this.descriptor;
  }

  listBusinessDomains() {
    return [...BUSINESS_DOMAINS];
  }

  listBusinessRecords({ domain } = {}) {
    normalizeProviderDomain(domain);
    return Object.freeze([]);
  }

  listBusinessRecordsByDomain() {
    return Object.freeze(Object.fromEntries(
      BUSINESS_DOMAINS.map((domain) => [domain, Object.freeze([])])
    ));
  }
}

export class BusinessProviderBackedAdapter {
  constructor({ provider, adapter = BUSINESS_PROVIDER_ADAPTERS.FUTURE_REAL_DATA } = {}) {
    assertBusinessProviderContract(provider);
    this.provider = provider;
    this.descriptor = createProviderAdapterDescriptor({
      descriptor: provider.getProviderDescriptor(),
      adapter,
      supportedDomains: provider.listSupportedDomains()
    });
    assertBusinessProviderAdapterContract(this);
  }

  getProviderDescriptor() {
    return this.descriptor;
  }

  listBusinessDomains() {
    return this.provider.listSupportedDomains();
  }

  listBusinessRecords({ domain, filters = null, pagination = null } = {}) {
    const firstRequest = createBusinessProviderReadRequest({ domain, filters, pagination });
    const records = [];
    const seenCursors = new Set();
    let cursor = firstRequest.pagination?.cursor ?? null;
    let limit = firstRequest.pagination?.limit ?? null;

    do {
      const request = createBusinessProviderReadRequest({
        domain: firstRequest.domain,
        filters,
        pagination: cursor || limit ? { cursor, limit } : null
      });
      const page = normalizeBusinessProviderPage(this.provider.readBusinessRecordsPage(request), {
        domain: request.domain,
        filters
      });
      records.push(...page.records);

      if (!page.nextCursor) {
        cursor = null;
        break;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new BusinessProviderAdapterContractError("Business provider returned a repeated pagination cursor.", "INVALID_PROVIDER_PAGINATION", {
          cursor: page.nextCursor
        });
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);

    return Object.freeze(records);
  }

  listBusinessRecordsByDomain({ filters = null } = {}) {
    return Object.freeze(Object.fromEntries(
      this.listBusinessDomains().map((domain) => [domain, this.listBusinessRecords({ domain, filters })])
    ));
  }
}

export function createBusinessProviderAdapter({
  provider = BUSINESS_DATA_PROVIDERS.DEMO,
  sourceId = null,
  data = undefined,
  adapter = null
} = {}) {
  const normalizedAdapter = normalizeBusinessProviderAdapter(adapter ?? provider);
  validateProviderAdapterCompatibility({ provider, adapter: normalizedAdapter });
  const descriptor = createBusinessDataSourceDescriptor({ provider, sourceId });
  if (normalizedAdapter === BUSINESS_PROVIDER_ADAPTERS.DEMO) {
    return new DemoBusinessProviderAdapter({ data, descriptor });
  }

  return new FutureRealDataProviderAdapter({
    descriptor,
    adapter: normalizedAdapter
  });
}

export function normalizeBusinessProviderAdapter(adapter = BUSINESS_PROVIDER_ADAPTERS.DEMO) {
  const normalized = adapter || BUSINESS_PROVIDER_ADAPTERS.DEMO;
  if (Object.values(BUSINESS_PROVIDER_ADAPTERS).includes(normalized)) {
    return normalized;
  }

  throw new BusinessProviderAdapterContractError(
    `Unsupported BUSINESS_PROVIDER_ADAPTER: ${adapter}`,
    "INVALID_BUSINESS_PROVIDER_ADAPTER",
    {
      adapter,
      supportedAdapters: Object.values(BUSINESS_PROVIDER_ADAPTERS)
    }
  );
}

export function assertBusinessProviderAdapterCompatibility({ provider, adapter }) {
  if (normalizeBusinessDataProvider(provider) === normalizeBusinessProviderAdapter(adapter)) {
    return true;
  }

  throw new BusinessProviderAdapterContractError(
    "BUSINESS_DATA_PROVIDER and BUSINESS_PROVIDER_ADAPTER must describe the same offline source.",
    "INCOMPATIBLE_BUSINESS_PROVIDER_ADAPTER",
    {
      provider,
      adapter
    }
  );
}

export function assertBusinessProviderAdapterContract(adapter) {
  const missing = [
    "getProviderDescriptor",
    "listBusinessDomains",
    "listBusinessRecords",
    "listBusinessRecordsByDomain"
  ].filter((method) => typeof adapter?.[method] !== "function");

  if (missing.length > 0) {
    throw new BusinessProviderAdapterContractError(
      "Business provider adapter does not implement the required contract.",
      "INVALID_BUSINESS_PROVIDER_ADAPTER",
      { missing }
    );
  }

  const descriptor = adapter.getProviderDescriptor();
  validateBusinessProviderDescriptor(descriptor);
  const supportedDomains = normalizeProviderDomains(adapter.listBusinessDomains());
  if (!sameOrderedValues(descriptor.supportedDomains, supportedDomains)) {
    throw new BusinessProviderAdapterContractError(
      "Business provider adapter descriptor domains must match listBusinessDomains exactly.",
      "INVALID_BUSINESS_PROVIDER_ADAPTER",
      {
        descriptorDomains: descriptor.supportedDomains,
        supportedDomains
      }
    );
  }

  return true;
}

export function normalizeProviderRecords(records) {
  if (!Array.isArray(records)) {
    throw new BusinessProviderAdapterContractError(
      "Business provider adapter records must be an array.",
      "INVALID_PROVIDER_RECORDS"
    );
  }

  return Object.freeze(records.map((record) => {
    assertBusinessRecordContract(record);
    return record;
  }));
}

function createProviderAdapterDescriptor({ descriptor, adapter, supportedDomains = BUSINESS_DOMAINS }) {
  return Object.freeze({
    ...descriptor,
    adapter: normalizeBusinessProviderAdapter(adapter),
    supportedDomains: normalizeProviderDomains(supportedDomains),
    capabilities: normalizeBusinessProviderCapabilities(descriptor.capabilities ?? {}),
    connectionStatus: descriptor.connectionStatus ?? "offline_configured",
    adapterStatus: "offline_configured",
    externalConnectionsEnabled: false
  });
}

function normalizeProviderDomain(domain) {
  validateDomain(domain);
  return normalizeBusinessDomain(domain);
}

function normalizeProviderDomains(domains) {
  if (!Array.isArray(domains)) {
    throw new BusinessProviderAdapterContractError("Business provider adapter domains must be an array.", "INVALID_BUSINESS_PROVIDER_ADAPTER");
  }
  return Object.freeze([...new Set(domains.map((domain) => normalizeProviderDomain(domain)))]);
}

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateProviderAdapterCompatibility({ provider, adapter }) {
  return assertBusinessProviderAdapterCompatibility({ provider, adapter });
}
