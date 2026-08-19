import {
  BUSINESS_DOMAINS,
  BUSINESS_DOMAIN_DATE_FIELDS,
  BUSINESS_DOMAIN_RELATION_FIELDS,
  BusinessMemoryError,
  createBusinessRecord,
  normalizeBusinessDomain,
  validateDomain
} from "./domain-contract.js";
import { normalizeBusinessDataSource } from "./source.js";

export class BusinessIngestionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BusinessIngestionError";
    this.code = code;
    this.details = details;
  }
}

// Ingestion never guesses where data comes from. A missing source would let
// real business data be written under the demo label, which is exactly the
// confusion the provenance model exists to prevent.
export function requireIngestionSource(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new BusinessIngestionError(
      "An ingestion batch must declare an explicit source.",
      "INGESTION_SOURCE_REQUIRED"
    );
  }

  return normalizeBusinessDataSource(source.trim());
}

export function requireIngestionDomain(domain) {
  if (typeof domain !== "string" || domain.trim().length === 0) {
    throw new BusinessIngestionError(
      "An ingestion batch must declare an explicit domain.",
      "INGESTION_DOMAIN_REQUIRED"
    );
  }

  const normalized = normalizeBusinessDomain(domain.trim());
  validateDomain(normalized);
  return normalized;
}

// Validates a whole batch without touching any repository. Every record is
// built through the canonical contract, so non-canonical fields, unknown
// relations and mismatched record types are all rejected here.
export function validateIngestionBatch({ domain, source, records } = {}) {
  const normalizedDomain = requireIngestionDomain(domain);
  const normalizedSource = requireIngestionSource(source);
  const definition = validateDomain(normalizedDomain);

  if (!Array.isArray(records)) {
    throw new BusinessIngestionError(
      "An ingestion batch must provide an array of records.",
      "INGESTION_RECORDS_REQUIRED"
    );
  }

  const accepted = [];
  const rejected = [];

  for (const [index, candidate] of records.entries()) {
    try {
      // The record contract fills in missing canonical fields but tolerates
      // unknown relation and date keys. Ingestion is stricter on purpose: a key
      // that no domain declares is a mapping mistake, not extra information.
      assertDeclaredKeys(candidate?.relations, BUSINESS_DOMAIN_RELATION_FIELDS[normalizedDomain], "relations");
      assertDeclaredKeys(candidate?.dates, BUSINESS_DOMAIN_DATE_FIELDS[normalizedDomain], "dates");

      accepted.push(createBusinessRecord({
        ...candidate,
        domain: normalizedDomain,
        recordType: candidate?.recordType ?? definition.recordType,
        source: normalizedSource
      }));
    } catch (cause) {
      rejected.push(Object.freeze({
        index,
        id: typeof candidate?.id === "string" ? candidate.id : null,
        code: cause instanceof BusinessMemoryError || cause instanceof BusinessIngestionError
          ? cause.code
          : "INVALID_RECORD",
        message: cause.message
      }));
    }
  }

  return Object.freeze({
    domain: normalizedDomain,
    source: normalizedSource,
    total: records.length,
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected)
  });
}

// Dry run by default: an ingestion writes only when the caller asks for it in
// so many words, and only when the entire batch is valid.
export async function ingestBusinessRecords({
  memory,
  domain,
  source,
  records,
  dryRun = true,
  stopOnError = true
} = {}) {
  if (!memory || typeof memory.saveBusinessRecord !== "function") {
    throw new BusinessIngestionError(
      "Ingestion requires a business memory repository.",
      "INGESTION_MEMORY_REQUIRED"
    );
  }

  const batch = validateIngestionBatch({ domain, source, records });
  const blocked = stopOnError && batch.rejected.length > 0;
  const shouldWrite = dryRun === false && !blocked;

  const written = [];
  if (shouldWrite) {
    for (const record of batch.accepted) {
      written.push(await memory.saveBusinessRecord(record));
    }
  }

  return Object.freeze({
    domain: batch.domain,
    source: batch.source,
    dryRun: dryRun !== false,
    total: batch.total,
    acceptedCount: batch.accepted.length,
    rejectedCount: batch.rejected.length,
    rejected: batch.rejected,
    blocked,
    writtenCount: written.length,
    written: Object.freeze(written)
  });
}

export function listIngestableDomains() {
  return [...BUSINESS_DOMAINS];
}

function assertDeclaredKeys(value, declaredFields = [], container) {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BusinessIngestionError(
      `${container} must be an object when provided.`,
      "INGESTION_INVALID_CONTAINER",
      { container }
    );
  }

  const unknown = Object.keys(value).filter((key) => !declaredFields.includes(key));
  if (unknown.length > 0) {
    throw new BusinessIngestionError(
      `${container} contain undeclared fields: ${unknown.join(", ")}`,
      "INGESTION_UNDECLARED_FIELD",
      { container, unknown, declaredFields: [...declaredFields] }
    );
  }

  return true;
}
