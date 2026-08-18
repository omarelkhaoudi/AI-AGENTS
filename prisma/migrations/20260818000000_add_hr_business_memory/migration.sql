CREATE TABLE "hr_demo_overview" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "employeeBusinessId" TEXT,
    "departmentId" TEXT,
    "recruitmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "category" TEXT,
    "priority" TEXT,
    "observedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "data" JSONB NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_demo_overview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hr_demo_overview_source_businessId_key" ON "hr_demo_overview"("source", "businessId");
CREATE INDEX "hr_demo_overview_source_idx" ON "hr_demo_overview"("source");
CREATE INDEX "hr_demo_overview_employeeBusinessId_idx" ON "hr_demo_overview"("employeeBusinessId");
CREATE INDEX "hr_demo_overview_departmentId_idx" ON "hr_demo_overview"("departmentId");
CREATE INDEX "hr_demo_overview_recruitmentId_idx" ON "hr_demo_overview"("recruitmentId");
CREATE INDEX "hr_demo_overview_status_idx" ON "hr_demo_overview"("status");
CREATE INDEX "hr_demo_overview_priority_idx" ON "hr_demo_overview"("priority");
