-- Extend the existing Product table; retain its identifiers and order relations.
ALTER TABLE "Product"
  ADD COLUMN "category_id" TEXT,
  ADD COLUMN "barcode" TEXT,
  ADD COLUMN "stock" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "manufacturer" TEXT,
  ADD COLUMN "alcohol" TEXT,
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_nonnegative" CHECK ("stock" >= 0);
CREATE INDEX "Product_source_is_active_idx" ON "Product"("source", "is_active");
