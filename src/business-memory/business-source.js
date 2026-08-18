import {
  filterBusinessRecords,
  normalizeBusinessDomain,
  validateDomain
} from "./domain-contract.js";
import {
  DemoBusinessProviderAdapter,
  FutureRealDataProviderAdapter,
  assertBusinessProviderAdapterContract,
  createBusinessProviderAdapter
} from "./business-provider-adapter.js";
import {
  BUSINESS_DATA_PROVIDERS,
  createBusinessDataSourceDescriptor
} from "./source.js";

export class BusinessSourceContractError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BusinessSourceContractError";
    this.code = code;
    this.details = details;
  }
}

export class AdapterBusinessSource {
  constructor({ adapter }) {
    assertBusinessProviderAdapterContract(adapter);
    this.adapter = adapter;
    assertBusinessSourceContract(this);
  }

  getSourceDescriptor() {
    return this.adapter.getProviderDescriptor();
  }

  listBusinessDomains() {
    return this.adapter.listBusinessDomains();
  }

  listBusinessRecords({ domain, source = null, filters = null } = {}) {
    const normalizedDomain = validateSourceDomain(domain);
    validateSupportedSourceDomain({
      domain: normalizedDomain,
      supportedDomains: this.listBusinessDomains()
    });
    return filterBusinessRecords(
      this.adapter.listBusinessRecords({ domain: normalizedDomain, filters }),
      { source }
    );
  }

  listBusinessRecordsByDomain({ source = null, filters = null } = {}) {
    return Object.freeze(Object.fromEntries(
      this.listBusinessDomains().map((domain) => [domain, this.listBusinessRecords({ domain, source, filters })])
    ));
  }
}

export class DemoBusinessSource extends AdapterBusinessSource {
  constructor({ data = undefined, descriptor = createBusinessDataSourceDescriptor(), adapter = null } = {}) {
    super({
      adapter: adapter ?? new DemoBusinessProviderAdapter({ data, descriptor })
    });
  }
}

export class FutureRealDataBusinessSource extends AdapterBusinessSource {
  constructor({
    descriptor = createBusinessDataSourceDescriptor({
      provider: BUSINESS_DATA_PROVIDERS.FUTURE_REAL_DATA
    }),
    adapter = null
  } = {}) {
    super({
      adapter: adapter ?? new FutureRealDataProviderAdapter({ descriptor })
    });
  }
}

export function createBusinessSource({
  provider = BUSINESS_DATA_PROVIDERS.DEMO,
  sourceId = null,
  data = undefined,
  adapter = null,
  adapterId = null
} = {}) {
  const selectedAdapter = adapter ?? createBusinessProviderAdapter({
    provider,
    sourceId,
    data,
    adapter: adapterId
  });
  const descriptor = selectedAdapter.getProviderDescriptor();
  if (descriptor.provider === BUSINESS_DATA_PROVIDERS.DEMO) {
    return new DemoBusinessSource({ adapter: selectedAdapter });
  }
  if (descriptor.provider === BUSINESS_DATA_PROVIDERS.FUTURE_REAL_DATA) {
    return new FutureRealDataBusinessSource({ adapter: selectedAdapter });
  }
  return new AdapterBusinessSource({ adapter: selectedAdapter });
}

export function assertBusinessSourceContract(source) {
  const missing = [
    "getSourceDescriptor",
    "listBusinessDomains",
    "listBusinessRecords",
    "listBusinessRecordsByDomain"
  ].filter((method) => typeof source?.[method] !== "function");

  if (missing.length > 0) {
    throw new BusinessSourceContractError("Business source does not implement the required contract.", "INVALID_BUSINESS_SOURCE", {
      missing
    });
  }

  return true;
}

export function collectBusinessSourceRecords(source) {
  assertBusinessSourceContract(source);
  const recordsByDomain = source.listBusinessRecordsByDomain();
  return Object.freeze(source.listBusinessDomains().flatMap((domain) => recordsByDomain[domain] ?? []));
}

function validateSourceDomain(domain) {
  validateDomain(domain);
  return normalizeBusinessDomain(domain);
}

function validateSupportedSourceDomain({ domain, supportedDomains }) {
  const normalizedSupportedDomains = supportedDomains.map((supportedDomain) => validateSourceDomain(supportedDomain));
  if (!normalizedSupportedDomains.includes(domain)) {
    throw new BusinessSourceContractError("Business source does not support this domain.", "UNSUPPORTED_BUSINESS_SOURCE_DOMAIN", {
      domain,
      supportedDomains: normalizedSupportedDomains
    });
  }
  return true;
}
