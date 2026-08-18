import {
  BUSINESS_DOMAINS,
  BusinessMemoryError,
  createBusinessRecord,
  filterBusinessRecords,
  normalizeBusinessDomain,
  validateBusinessDomainAccess,
  validateDomain
} from "./domain-contract.js";
import {
  BUSINESS_DATA_PROVIDERS,
  BUSINESS_DATA_SOURCES,
  createBusinessDataSourceDescriptor
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

  getBusinessRecord({ domain, id, agentId = "director", source = null, filters = null } = {}) {
    const normalizedDomain = normalizeBusinessDomain(domain);
    validateBusinessDomainAccess({ domain: normalizedDomain, agentId });
    const records = this.#listRawRecords({ domain: normalizedDomain, source, filters });
    return records.find((record) => record.id === id) ?? null;
  }

  listBusinessRecords({ domain, agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK, filters = null } = {}) {
    const normalizedDomain = normalizeBusinessDomain(domain);
    validateBusinessDomainAccess({ domain: normalizedDomain, agentId });
    return this.#listRawRecords({ domain: normalizedDomain, source, filters });
  }

  listBusinessRecordsByDomain({ agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK, filters = null } = {}) {
    return Object.freeze(Object.fromEntries(BUSINESS_DOMAINS.map((domain) => {
      try {
        return [domain, this.listBusinessRecords({ domain, agentId, source, filters })];
      } catch (error) {
        if (error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED") {
          return [domain, Object.freeze([])];
        }
        throw error;
      }
    })));
  }

  #listRawRecords({ domain, source, filters }) {
    const normalizedDomain = normalizeBusinessDomain(domain);
    validateDomain(normalizedDomain);
    return filterBusinessRecords(
      [...this.#records.values()].filter((record) => record.domain === normalizedDomain),
      { source, filters }
    );
  }
}

function createRecordKey(record) {
  return `${record.source}:${record.domain}:${record.id}`;
}
