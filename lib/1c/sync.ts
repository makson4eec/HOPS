import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { fetchOneCProducts } from "./client";
import { getOneCConfig, isAllowed, type OneCConfig } from "./config";
import { OneCError } from "./errors";
import { extractOneCProducts, normalizeOneCProduct, websiteCategory } from "./normalize";

export type SyncStats = { received: number; allowed: number; created: number; updated: number; disabled: number; errors: string[] };
export class OneCSyncError extends OneCError {
  constructor(code: string, status: number, readonly stats: SyncStats) { super(code, status); }
}

export async function syncOneCCatalog(config?: OneCConfig): Promise<SyncStats> {
  const stats: SyncStats = { received: 0, allowed: 0, created: 0, updated: 0, disabled: 0, errors: [] };
  console.info("[1c] catalog sync started");
  try {
    const settings = config ?? getOneCConfig();
    const result = await db.$transaction(async tx => {
      // Lock BEFORE fetching: overlapping requests cannot apply older snapshots last.
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(18471, 1) AS "locked"`;
      if (!lock?.locked) throw new OneCError("SYNC_ALREADY_RUNNING", 409);
      const rows = extractOneCProducts(await fetchOneCProducts(settings));
      stats.received = rows.length;
      const seen = new Set<string>();
      const products = rows.map((row, index) => {
        try {
          const product = normalizeOneCProduct(row);
          if (seen.has(product.externalId)) throw new OneCError("ONE_C_DUPLICATE_ID");
          seen.add(product.externalId);
          return product;
        } catch (error) {
          const code = error instanceof OneCError ? error.message : "ONE_C_INVALID_PRODUCT";
          throw new OneCError(`${code}_ROW_${index + 1}`);
        }
      }).filter(product => isAllowed(product, settings));
      stats.allowed = products.length;
      const warehouse = await tx.warehouse.findUnique({ where: { id: "hops-store" }, select: { id: true } });
      if (!warehouse) throw new OneCError("STORE_NOT_CONFIGURED_RUN_DB_SEED", 503);
      const now = new Date();
      let created = 0;
      let updated = 0;
      for (const entry of products) {
        const existing = await tx.product.findUnique({ where: { externalId: entry.externalId } });
        // An external ID alone does not grant ownership of a manual product.
        if (existing && existing.source !== "1c") throw new OneCError("EXTERNAL_ID_OWNED_BY_OTHER_SOURCE", 409);
        const suffix = createHash("sha256").update(entry.externalId).digest("hex");
        const { categoryId, price, ...fields } = entry;
        const data = {
          ...fields, categoryId, category: websiteCategory(categoryId),
          price: Math.round(price * 100), sku: entry.sku || existing?.sku || `1c-${suffix}`,
          barcode: entry.barcode ?? null, imageUrl: entry.imageUrl ?? null,
          description: entry.description ?? "", volume: entry.volume ?? "",
          country: entry.country ?? null, manufacturer: entry.manufacturer ?? null, alcohol: entry.alcohol ?? null,
          source: "1c", isActive: true, sourceUpdatedAt: now, priceUpdatedAt: now,
        };
        const product = await tx.product.upsert({
          where: { externalId: entry.externalId },
          create: { ...data, slug: `1c-${suffix}`, status: "PUBLISHED" },
          update: data, // Retain editorial status, URL, "new" flag and order references.
        });
        // Atomic with checkout reservations. Keep existing reserves even when the
        // external physical snapshot falls below them; expose zero free units.
        const inventory = await tx.inventory.upsert({
          where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
          create: { productId: product.id, warehouseId: warehouse.id, quantity: entry.stock, sourceUpdatedAt: now },
          update: {},
        });
        await tx.$executeRaw`UPDATE "Inventory"
          SET "quantity" = GREATEST(${entry.stock}, "reserved"), "sourceUpdatedAt" = ${now}, "updatedAt" = ${now}
          WHERE "id" = ${inventory.id}`;
        if (existing) updated++; else created++;
      }
      const disabled = await tx.product.updateMany({
        where: { source: "1c", isActive: true, ...(products.length ? { externalId: { notIn: products.map(product => product.externalId) } } : {}) },
        data: { isActive: false },
      });
      return { created, updated, disabled: disabled.count };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 60_000, maxWait: 5000 });
    Object.assign(stats, result);
    console.info("[1c] catalog sync completed", stats);
    return stats;
  } catch (error) {
    const code = error instanceof OneCError ? error.message : "DATABASE_SYNC_FAILED";
    stats.errors.push(code);
    console.error("[1c] catalog sync rolled back", { code, received: stats.received, allowed: stats.allowed });
    throw new OneCSyncError(code, error instanceof OneCError ? error.status : 503, stats);
  }
}
