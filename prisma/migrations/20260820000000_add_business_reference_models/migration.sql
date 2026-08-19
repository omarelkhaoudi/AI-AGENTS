-- Lot 2A.1 business reference models: products, prices, stock, bills of
-- material and payment terms.
-- Strictly additive: no table is dropped, renamed or altered, and no existing
-- row is read or written by this migration.

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reference" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_entries" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "productBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "amount" DECIMAL(65,30),
    "currency" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "productBusinessId" TEXT,
    "supplierBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "quantity" DECIMAL(65,30),
    "unit" TEXT,
    "countedAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills_of_material" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "productBusinessId" TEXT,
    "orderBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "validFrom" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bills_of_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_of_material_lines" (
    "id" TEXT NOT NULL,
    "billOfMaterialId" TEXT NOT NULL,
    "lineBusinessId" TEXT NOT NULL,
    "productBusinessId" TEXT,
    "quantity" DECIMAL(65,30),
    "unit" TEXT,
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bill_of_material_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_terms" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "customerBusinessId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "netDays" INTEGER,
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_terms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_source_businessId_key" ON "products"("source", "businessId");
CREATE INDEX "products_source_idx" ON "products"("source");
CREATE INDEX "products_reference_idx" ON "products"("reference");
CREATE INDEX "products_status_idx" ON "products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_entries_source_businessId_key" ON "price_list_entries"("source", "businessId");
CREATE INDEX "price_list_entries_source_idx" ON "price_list_entries"("source");
CREATE INDEX "price_list_entries_productBusinessId_idx" ON "price_list_entries"("productBusinessId");
CREATE INDEX "price_list_entries_status_idx" ON "price_list_entries"("status");
CREATE INDEX "price_list_entries_validUntil_idx" ON "price_list_entries"("validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_source_businessId_key" ON "stock_items"("source", "businessId");
CREATE INDEX "stock_items_source_idx" ON "stock_items"("source");
CREATE INDEX "stock_items_productBusinessId_idx" ON "stock_items"("productBusinessId");
CREATE INDEX "stock_items_supplierBusinessId_idx" ON "stock_items"("supplierBusinessId");
CREATE INDEX "stock_items_status_idx" ON "stock_items"("status");

-- CreateIndex
CREATE UNIQUE INDEX "bills_of_material_source_businessId_key" ON "bills_of_material"("source", "businessId");
CREATE INDEX "bills_of_material_source_idx" ON "bills_of_material"("source");
CREATE INDEX "bills_of_material_productBusinessId_idx" ON "bills_of_material"("productBusinessId");
CREATE INDEX "bills_of_material_orderBusinessId_idx" ON "bills_of_material"("orderBusinessId");
CREATE INDEX "bills_of_material_status_idx" ON "bills_of_material"("status");

-- CreateIndex
CREATE UNIQUE INDEX "bill_of_material_lines_billOfMaterialId_lineBusinessId_key" ON "bill_of_material_lines"("billOfMaterialId", "lineBusinessId");
CREATE INDEX "bill_of_material_lines_billOfMaterialId_idx" ON "bill_of_material_lines"("billOfMaterialId");
CREATE INDEX "bill_of_material_lines_productBusinessId_idx" ON "bill_of_material_lines"("productBusinessId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_terms_source_businessId_key" ON "payment_terms"("source", "businessId");
CREATE INDEX "payment_terms_source_idx" ON "payment_terms"("source");
CREATE INDEX "payment_terms_customerBusinessId_idx" ON "payment_terms"("customerBusinessId");
CREATE INDEX "payment_terms_status_idx" ON "payment_terms"("status");

-- AddForeignKey
ALTER TABLE "bill_of_material_lines" ADD CONSTRAINT "bill_of_material_lines_billOfMaterialId_fkey"
    FOREIGN KEY ("billOfMaterialId") REFERENCES "bills_of_material"("id") ON DELETE CASCADE ON UPDATE CASCADE;
