# Database Schema

PostgreSQL through Prisma 7, with the `@prisma/adapter-pg` driver adapter. The
schema lives in `prisma/schema.prisma` and is applied by the five committed
migrations under `prisma/migrations/`.

This document describes what the schema holds and how the application reaches
it. It is checked against the code by `test/documentation-consistency.test.js`,
so a model added without a line here fails the suite.

## Two families of tables

**Orchestration** records what the system did: who asked, what was planned, what
ran, what was approved, and what was audited. **Business memory** records what
the company is: customers, quotes, invoices, orders, production, purchasing.

An agent reads business memory through a tool. It never reaches orchestration
tables, and orchestration never carries business content.

## Orchestration tables (10)

| Model | Holds |
| --- | --- |
| `User` | The people the system acts for. Requests and approvals name one. |
| `ApiToken` | Bearer credentials. Only the hash is stored, never the secret. |
| `Agent` | The ten agent rows, with their permissions. Written by `npm run db:seed`. |
| `Request` | One leader request, its payload and its final status. |
| `Plan` | The plan a planner produced for a request. |
| `PlanStep` | One step of a plan: an agent, a tool, a sequence number. |
| `Execution` | What running a step produced, or why it stopped. |
| `Approval` | A sensitive action waiting for a human decision. |
| `AuditEvent` | The trail. Twenty one event types, defined in `src/observability/audit.js`. |
| `Document` | Documents attached to a request. |

`Agent.permissions` is written from `createMvpAgentPermissions`, the source of
truth for the least privilege model. The seed overwrites it on every run: a row
that has drifted from the model is restored, never preserved.

## Business memory tables (16)

Fifteen business domains map to a Prisma model. `BillOfMaterialLine` is the
sixteenth table: it belongs to `BillOfMaterial` and is not a domain of its own.

| Domain | Prisma model | Table | Record type | Agents allowed to read |
| --- | --- | --- | --- | --- |
| `customers` | `Customer` | `customers` | `customer` | director, commercial, finance, after_sales, legal |
| `quotes` | `Quote` | `quotes` | `quote` | director, commercial |
| `invoices` | `Invoice` | `invoices` | `invoice` | director, finance |
| `payments` | `Payment` | `payments` | `payment` | director, finance |
| `orders` | `BusinessOrder` | `orders` | `order` | director, commercial, production, purchasing, after_sales |
| `production` | `ProductionRecord` | `production` | `production_signal` | director, production |
| `purchase_needs` | `PurchaseNeed` | `purchase_needs` | `purchase_need` | director, purchasing |
| `suppliers` | `Supplier` | `suppliers` | `supplier` | director, purchasing |
| `hr_demo_overview` | `HrSignal` | `hr_demo_overview` | `hr_signal` | director, hr |
| `after_sales_tickets` | `AfterSalesTicket` | `after_sales_tickets` | `after_sales_ticket` | director, after_sales |
| `products` | `Product` | `products` | `product` | director, commercial, production, purchasing |
| `prices` | `PriceListEntry` | `price_list_entries` | `price_entry` | director, commercial, finance |
| `stock` | `StockItem` | `stock_items` | `stock_item` | director, purchasing, production |
| `bills_of_material` | `BillOfMaterial` | `bills_of_material` | `bill_of_material` | director, production, purchasing |
| `payment_terms` | `PaymentTerm` | `payment_terms` | `payment_term` | director, finance, commercial |

The domain list is `BUSINESS_DOMAINS` in `src/business-memory/domain-contract.js`.
The domain to model mapping is `DOMAIN_MODEL_MAP` in
`src/business-memory/prisma-business-memory-repository.js`.

`prices` and `payment_terms` are modelled and migrated but no tool reads them
yet, so they stay empty after a business seed.

## The shape every business row shares

Whatever the domain, a row carries the same envelope:

- `businessId` — the identifier the business uses, not the database key
- `source` — `demo_mock` or `future_real_data`
- `status` — the business status of the record
- `data` — the business payload, as JSON
- `metadata` — storage metadata, as JSON
- `createdAt` / `updatedAt`
- domain specific relation and date columns, indexed

`@@unique([source, businessId])` is what makes a seed idempotent: the same
record from the same source updates in place instead of duplicating. It is also
what keeps sources apart, so asking for `demo_mock` never returns a
`future_real_data` row.

### Record order

A business record carries a `sequence`, a rank inside its domain. The in memory
provider returns records in declaration order while PostgreSQL returns rows
sorted by identifier, so the same company produced two different reports until
the rank existed. Both providers now sort by it through
`filterBusinessRecords`.

No column carries the rank: it travels inside the `metadata` JSON under
`__sequence`, and is lifted back out when the record is read. That avoids a
migration on fifteen models, at the cost of sorting in application code rather
than through an indexed `ORDER BY`. With real volume and pagination it should
become a column.

## Migrations

| Migration | Adds |
| --- | --- |
| `20260813000000_init_core` | Orchestration tables |
| `20260815000000_business_memory_mvp` | First business domains |
| `20260818000000_add_hr_business_memory` | `hr_demo_overview` |
| `20260819000000_add_api_tokens` | `ApiToken` |
| `20260820000000_add_business_reference_models` | Products, prices, stock, bills of material, payment terms |

Apply them with `npm run db:migrate`. Never edit a committed migration: add a
new one. See `docs/POSTGRESQL_SETUP.md` for the full install path and
`docs/BACKUP_AND_RESTORE.md` for backups.

## Reading the schema yourself

```bash
npm run db:validate
```

Prisma validates the schema against the datasource. It needs `DATABASE_URL` in
the environment: Prisma 7 resolves `prisma.config.js` through `process.env` and
no longer reads `.env` on its own.
