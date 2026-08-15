-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "customerBusinessId" TEXT,
    "prospectId" TEXT,
    "linkedOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issuedAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "customerBusinessId" TEXT,
    "quoteBusinessId" TEXT,
    "orderBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "amount" DECIMAL(65,30),
    "currency" TEXT,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "customerBusinessId" TEXT,
    "invoiceBusinessId" TEXT,
    "quoteBusinessId" TEXT,
    "orderBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "amount" DECIMAL(65,30),
    "currency" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "customerBusinessId" TEXT,
    "quoteBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "risk" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "orderBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "delayRisk" TEXT,
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "leadTimeDays" INTEGER,
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_needs" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "supplierBusinessId" TEXT,
    "linkedOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "urgency" TEXT,
    "neededAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_needs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sales_tickets" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "customerBusinessId" TEXT,
    "orderBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "priority" TEXT,
    "openedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "after_sales_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_source_businessId_key" ON "customers"("source", "businessId");
CREATE INDEX "customers_source_idx" ON "customers"("source");
CREATE INDEX "customers_status_idx" ON "customers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_source_businessId_key" ON "quotes"("source", "businessId");
CREATE INDEX "quotes_source_idx" ON "quotes"("source");
CREATE INDEX "quotes_customerBusinessId_idx" ON "quotes"("customerBusinessId");
CREATE INDEX "quotes_status_idx" ON "quotes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_source_businessId_key" ON "invoices"("source", "businessId");
CREATE INDEX "invoices_source_idx" ON "invoices"("source");
CREATE INDEX "invoices_customerBusinessId_idx" ON "invoices"("customerBusinessId");
CREATE INDEX "invoices_quoteBusinessId_idx" ON "invoices"("quoteBusinessId");
CREATE INDEX "invoices_orderBusinessId_idx" ON "invoices"("orderBusinessId");
CREATE INDEX "invoices_status_idx" ON "invoices"("status");
CREATE INDEX "invoices_dueAt_idx" ON "invoices"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_source_businessId_key" ON "payments"("source", "businessId");
CREATE INDEX "payments_source_idx" ON "payments"("source");
CREATE INDEX "payments_customerBusinessId_idx" ON "payments"("customerBusinessId");
CREATE INDEX "payments_invoiceBusinessId_idx" ON "payments"("invoiceBusinessId");
CREATE INDEX "payments_status_idx" ON "payments"("status");
CREATE INDEX "payments_dueAt_idx" ON "payments"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_source_businessId_key" ON "orders"("source", "businessId");
CREATE INDEX "orders_source_idx" ON "orders"("source");
CREATE INDEX "orders_customerBusinessId_idx" ON "orders"("customerBusinessId");
CREATE INDEX "orders_quoteBusinessId_idx" ON "orders"("quoteBusinessId");
CREATE INDEX "orders_status_idx" ON "orders"("status");
CREATE INDEX "orders_dueAt_idx" ON "orders"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "production_source_businessId_key" ON "production"("source", "businessId");
CREATE INDEX "production_source_idx" ON "production"("source");
CREATE INDEX "production_orderBusinessId_idx" ON "production"("orderBusinessId");
CREATE INDEX "production_status_idx" ON "production"("status");
CREATE INDEX "production_delayRisk_idx" ON "production"("delayRisk");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_source_businessId_key" ON "suppliers"("source", "businessId");
CREATE INDEX "suppliers_source_idx" ON "suppliers"("source");
CREATE INDEX "suppliers_status_idx" ON "suppliers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_needs_source_businessId_key" ON "purchase_needs"("source", "businessId");
CREATE INDEX "purchase_needs_source_idx" ON "purchase_needs"("source");
CREATE INDEX "purchase_needs_supplierBusinessId_idx" ON "purchase_needs"("supplierBusinessId");
CREATE INDEX "purchase_needs_linkedOrderId_idx" ON "purchase_needs"("linkedOrderId");
CREATE INDEX "purchase_needs_status_idx" ON "purchase_needs"("status");
CREATE INDEX "purchase_needs_urgency_idx" ON "purchase_needs"("urgency");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_tickets_source_businessId_key" ON "after_sales_tickets"("source", "businessId");
CREATE INDEX "after_sales_tickets_source_idx" ON "after_sales_tickets"("source");
CREATE INDEX "after_sales_tickets_customerBusinessId_idx" ON "after_sales_tickets"("customerBusinessId");
CREATE INDEX "after_sales_tickets_orderBusinessId_idx" ON "after_sales_tickets"("orderBusinessId");
CREATE INDEX "after_sales_tickets_status_idx" ON "after_sales_tickets"("status");
CREATE INDEX "after_sales_tickets_priority_idx" ON "after_sales_tickets"("priority");
