import {
  BUSINESS_DOMAINS,
  BusinessMemoryError,
  createBusinessRecord,
  validateBusinessDomainAccess,
  validateDomain
} from "./domain-contract.js";
import {
  BUSINESS_DATA_PROVIDERS,
  BUSINESS_DATA_SOURCES,
  createBusinessDataSourceDescriptor,
  normalizeBusinessDataSource
} from "./source.js";

export class InMemoryBusinessMemoryRepository {
  #records = new Map();
  #dataSourceDescriptor = createBusinessDataSourceDescriptor({
    provider: BUSINESS_DATA_PROVIDERS.DEMO
  });

  constructor({ records = [], dataSourceDescriptor = null } = {}) {
    if (dataSourceDescriptor) {
      this.#dataSourceDescriptor = Object.freeze({ ...dataSourceDescriptor });
    }
    for (const record of records) {
      this.saveBusinessRecord(record);
    }
  }

  getBusinessDataSource() {
    return this.#dataSourceDescriptor;
  }

  listBusinessDomains() {
    return [...BUSINESS_DOMAINS];
  }

  saveBusinessRecord(input) {
    const record = createBusinessRecord(input);
    this.#records.set(createRecordKey(record), record);
    return record;
  }

  getBusinessRecord({ domain, id, agentId = "director", source = null } = {}) {
    validateBusinessDomainAccess({ domain, agentId });
    const records = this.#listRawRecords({ domain, source });
    return records.find((record) => record.id === id) ?? null;
  }

  listBusinessRecords({ domain, agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK } = {}) {
    validateBusinessDomainAccess({ domain, agentId });
    return this.#listRawRecords({ domain, source });
  }

  listBusinessRecordsByDomain({ agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK } = {}) {
    return Object.freeze(Object.fromEntries(BUSINESS_DOMAINS.map((domain) => {
      try {
        return [domain, this.listBusinessRecords({ domain, agentId, source })];
      } catch (error) {
        if (error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED") {
          return [domain, Object.freeze([])];
        }
        throw error;
      }
    })));
  }

  #listRawRecords({ domain, source }) {
    validateDomain(domain);
    const normalizedSource = source === null ? null : normalizeBusinessDataSource(source);
    const records = [...this.#records.values()].filter((record) =>
      record.domain === domain &&
      (normalizedSource === null || record.source === normalizedSource)
    );
    return Object.freeze(records);
  }
}

function createRecordKey(record) {
  return `${record.source}:${record.domain}:${record.id}`;
}
