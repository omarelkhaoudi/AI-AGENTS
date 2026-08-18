import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAINS,
  BusinessMemoryError,
  BusinessProviderBackedAdapter,
  BusinessProviderContractError,
  InMemoryRepository,
  ToolExecutionService,
  assertBusinessProviderContract,
  createBusinessMemoryRepository,
  createBusinessProviderDescriptor,
  createBusinessProviderReadRequest,
  createBusinessRecord,
  createMvpToolRegistry,
  createPermission,
  normalizeBusinessProviderPage
} from "../src/index.js";

test("generic business provider contract validates descriptor, domains, and capabilities", () => {
  const provider = createOfflineFakeBusinessProvider();
  const descriptor = provider.getProviderDescriptor();

  assert.equal(assertBusinessProviderContract(provider), true);
  assert.equal(descriptor.provider, "future_real_data");
  assert.equal(descriptor.sourceId, "offline-fake-provider");
  assert.deepEqual(descriptor.supportedDomains, ["payments", "quotes"]);
  assert.equal(descriptor.capabilities.readRecords, true);
  assert.equal(descriptor.capabilities.pagination, true);
  assert.equal(descriptor.capabilities.incrementalSync, true);
  assert.equal(descriptor.capabilities.writeRecords, false);
  assert.equal(descriptor.connectionStatus, "offline_not_connected");
  assert.equal(descriptor.externalConnectionsEnabled, false);
  assert.deepEqual(provider.listSupportedDomains(), ["payments", "quotes"]);
});

test("generic business provider contract rejects invalid providers and external connections", () => {
  assert.throws(
    () => assertBusinessProviderContract({ getProviderDescriptor: () => ({}) }),
    (error) => error instanceof BusinessProviderContractError && error.code === "INVALID_BUSINESS_PROVIDER"
  );
  assert.throws(
    () => assertBusinessProviderContract({
      getProviderDescriptor: () => ({
        ...createBusinessProviderDescriptor(),
        externalConnectionsEnabled: true
      }),
      listSupportedDomains: () => BUSINESS_DOMAINS,
      readBusinessRecordsPage: () => ({ records: [] })
    }),
    (error) => error instanceof BusinessProviderContractError && error.code === "BUSINESS_PROVIDER_EXTERNAL_CONNECTION_FORBIDDEN"
  );
  assert.throws(
    () => assertBusinessProviderContract({
      getProviderDescriptor: () => createBusinessProviderDescriptor({
        supportedDomains: ["payments"]
      }),
      listSupportedDomains: () => ["quotes"],
      readBusinessRecordsPage: () => ({ records: [] })
    }),
    (error) =>
      error instanceof BusinessProviderContractError &&
      error.code === "INVALID_BUSINESS_PROVIDER_DESCRIPTOR"
  );
});

test("generic business provider contract rejects non-boolean and write capabilities", () => {
  assert.throws(
    () => createBusinessProviderDescriptor({
      capabilities: {
        pagination: "yes"
      }
    }),
    (error) =>
      error instanceof BusinessProviderContractError &&
      error.code === "INVALID_BUSINESS_PROVIDER_DESCRIPTOR"
  );
  assert.throws(
    () => createBusinessProviderDescriptor({
      capabilities: {
        writeRecords: true
      }
    }),
    (error) =>
      error instanceof BusinessProviderContractError &&
      error.code === "INVALID_BUSINESS_PROVIDER_DESCRIPTOR"
  );
});

test("generic business provider read request and page normalization support offline pagination", () => {
  const provider = createOfflineFakeBusinessProvider();
  const request = createBusinessProviderReadRequest({
    domain: "payments",
    filters: { data: { invoiceId: "fake-invoice-001" } },
    pagination: { limit: 1, cursor: "start" },
    syncToken: "sync-001"
  });
  const page = normalizeBusinessProviderPage(provider.readBusinessRecordsPage(request), {
    domain: request.domain,
    filters: request.filters
  });

  assert.deepEqual(request, {
    domain: "payments",
    filters: { data: { invoiceId: "fake-invoice-001" } },
    pagination: { cursor: "start", limit: 1 },
    syncToken: "sync-001"
  });
  assert.deepEqual(page.records.map((record) => record.id), ["fake-payment-001"]);
  assert.equal(page.nextCursor, "cursor-002");
  assert.equal(page.syncToken, "sync-002");
});

test("BusinessProviderBackedAdapter maps a fake provider into BusinessMemory without exposing provider details to tools", async () => {
  const businessMemory = createBusinessMemoryRepository({
    businessProviderAdapter: new BusinessProviderBackedAdapter({
      provider: createOfflineFakeBusinessProvider()
    })
  });
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository, businessMemory })
  });

  const result = await service.execute({
    agentId: "finance",
    agentPermissions: [createPermission({ kind: "read_analyze", resource: "request:*" })],
    toolId: "get_pending_payments",
    input: { requestId: "req-provider-contract" },
    requestId: "req-provider-contract"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.dataSource, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA);
  assert.equal(result.output.result.sourceId, "offline-fake-provider");
  assert.deepEqual(result.output.result.items.map((item) => item.id), ["fake-payment-001", "fake-payment-002"]);
  assert.equal(result.output.result.items[0].providerSpecificShape.externalId, "provider-payment-001");
});

test("BusinessProviderBackedAdapter consumes all provider pages without dropping records", () => {
  const adapter = new BusinessProviderBackedAdapter({
    provider: createOfflineFakeBusinessProvider()
  });

  assert.deepEqual(adapter.listBusinessRecords({
    domain: "payments",
    pagination: { limit: 1 }
  }).map((record) => record.id), ["fake-payment-001", "fake-payment-002"]);
});

test("generic business provider contract rejects pages with wrong-domain records", () => {
  assert.throws(
    () => normalizeBusinessProviderPage({
      records: [
        createBusinessRecord({
          id: "wrong-domain",
          domain: "quotes",
          recordType: "quote",
          source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
          data: { id: "wrong-domain" }
        })
      ]
    }, { domain: "payments" }),
    (error) => error instanceof BusinessProviderContractError && error.code === "INVALID_BUSINESS_PROVIDER_RECORD"
  );
});

test("generic business provider contract keeps provider-specific fields inside data", () => {
  const canonicalRecord = createBusinessRecord({
    id: "provider-specific-inside-data",
    domain: "payments",
    recordType: "payment",
    status: "expected",
    source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    data: {
      id: "provider-specific-inside-data",
      invoiceId: "provider-invoice-001",
      providerPayload: {
        externalId: "external-payment-001"
      }
    },
    relations: {
      invoiceId: "provider-invoice-001"
    },
    dates: {
      dueAt: "2026-08-20"
    },
    metadata: {
      provider: "offline-fake"
    }
  });

  assert.deepEqual(normalizeBusinessProviderPage({
    records: [canonicalRecord]
  }, { domain: "payments" }).records.map((record) => record.data.providerPayload.externalId), ["external-payment-001"]);
  assert.throws(
    () => normalizeBusinessProviderPage({
      records: [{
        ...canonicalRecord,
        externalId: "external-payment-001"
      }]
    }, { domain: "payments" }),
    (error) =>
      error instanceof BusinessMemoryError &&
      error.code === "INVALID_BUSINESS_RECORD"
  );
});

function createOfflineFakeBusinessProvider() {
  const descriptor = createBusinessProviderDescriptor({
    provider: "future_real_data",
    sourceId: "offline-fake-provider",
    label: "Offline fake business provider",
    supportedDomains: ["payments", "quotes"],
    capabilities: {
      pagination: true,
      incrementalSync: true
    }
  });
  const recordsByDomain = Object.freeze({
    payments: Object.freeze([
      createBusinessRecord({
        id: "fake-payment-001",
        domain: "payments",
        recordType: "payment",
        status: "expected",
        source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
        data: {
          id: "fake-payment-001",
          invoiceId: "fake-invoice-001",
          status: "expected",
          amount: 100,
          currency: "MAD",
          providerSpecificShape: {
            externalId: "provider-payment-001"
          }
        },
        relations: { invoiceId: "fake-invoice-001" },
        dates: { dueAt: "2026-08-20" },
        metadata: { provider: "offline-fake", draft: true }
      }),
      createBusinessRecord({
        id: "fake-payment-002",
        domain: "payments",
        recordType: "payment",
        status: "expected",
        source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
        data: {
          id: "fake-payment-002",
          invoiceId: "fake-invoice-002",
          status: "expected",
          amount: 200,
          currency: "MAD",
          providerSpecificShape: {
            externalId: "provider-payment-002"
          }
        },
        relations: { invoiceId: "fake-invoice-002" },
        dates: { dueAt: "2026-08-21" },
        metadata: { provider: "offline-fake", draft: true }
      })
    ]),
    quotes: Object.freeze([
      createBusinessRecord({
        id: "fake-quote-001",
        domain: "quotes",
        recordType: "quote",
        status: "pending_customer_reply",
        source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
        data: { id: "fake-quote-001", status: "pending_customer_reply" },
        dates: { issuedAt: "2026-08-18" },
        metadata: { provider: "offline-fake", draft: true }
      })
    ])
  });

  return Object.freeze({
    getProviderDescriptor: () => descriptor,
    listSupportedDomains: () => descriptor.supportedDomains,
    readBusinessRecordsPage: ({ domain, pagination = null } = {}) => {
      const records = recordsByDomain[domain] ?? [];
      const start = pagination?.cursor === "cursor-002" ? 1 : 0;
      const limit = pagination?.limit ?? records.length;
      const end = start + limit;
      return {
        records: records.slice(start, end),
        nextCursor: records.length > end ? "cursor-002" : null,
        syncToken: "sync-002"
      };
    }
  });
}
