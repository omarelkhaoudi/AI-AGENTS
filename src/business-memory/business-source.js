import { createDemoCompanyData } from "../demo/company-data.js";
import {
  BUSINESS_DOMAINS,
  filterBusinessRecords,
  normalizeBusinessDomain,
  validateDomain
} from "./domain-contract.js";
import { createDemoBusinessRecords } from "./demo-business-memory.js";
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

export class DemoBusinessSource {
  constructor({ data = createDemoCompanyData(), descriptor = createBusinessDataSourceDescriptor() } = {}) {
    this.descriptor = descriptor;
    this.records = createDemoBusinessRecords(data);
    assertBusinessSourceContract(this);
  }

  getSourceDescriptor() {
    return this.descriptor;
  }

  listBusinessDomains() {
    return [...BUSINESS_DOMAINS];
  }

  listBusinessRecords({ domain, source = null, filters = null } = {}) {
    const normalizedDomain = validateSourceDomain(domain);
    return filterBusinessRecords(
      this.records.filter((record) => record.domain === normalizedDomain),
      { source, filters }
    );
  }

  listBusinessRecordsByDomain() {
    return Object.freeze(Object.fromEntries(
      BUSINESS_DOMAINS.map((domain) => [domain, this.listBusinessRecords({ domain })])
    ));
  }
}

export class FutureRealDataBusinessSource {
  constructor({
    descriptor = createBusinessDataSourceDescriptor({
      provider: BUSINESS_DATA_PROVIDERS.FUTURE_REAL_DATA
    })
  } = {}) {
    this.descriptor = descriptor;
    assertBusinessSourceContract(this);
  }

  getSourceDescriptor() {
    return this.descriptor;
  }

  listBusinessDomains() {
    return [...BUSINESS_DOMAINS];
  }

  listBusinessRecords({ domain } = {}) {
    validateSourceDomain(domain);
    return Object.freeze([]);
  }

  listBusinessRecordsByDomain() {
    return Object.freeze(Object.fromEntries(
      BUSINESS_DOMAINS.map((domain) => [domain, Object.freeze([])])
    ));
  }
}

export function createBusinessSource({
  provider = BUSINESS_DATA_PROVIDERS.DEMO,
  sourceId = null,
  data = undefined
} = {}) {
  const descriptor = createBusinessDataSourceDescriptor({ provider, sourceId });
  if (descriptor.provider === BUSINESS_DATA_PROVIDERS.DEMO) {
    return new DemoBusinessSource({ data, descriptor });
  }

  return new FutureRealDataBusinessSource({ descriptor });
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
  return Object.freeze(BUSINESS_DOMAINS.flatMap((domain) => recordsByDomain[domain] ?? []));
}

function validateSourceDomain(domain) {
  validateDomain(domain);
  return normalizeBusinessDomain(domain);
}
