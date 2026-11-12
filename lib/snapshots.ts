import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, dataDir, privatePath, digest, logError, mutateState, readState } from "./storage";
import type { SnapshotStatus, State } from "./models";

export const fallbackCatalogSource = "site-fallback";
export const snapshotCheckMinutes = 30;
const id = z.string().trim().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
const metadata = { schema_version: z.literal("1.0"), export_id: id, generated_at: timestamp, complete: z.literal(true) };
export const catalogProductSchema = z.object({
  externalId: id, categoryId: id, siteCategory: z.enum(["beer", "ciders", "poire", "beer_drinks", "lemonade", "snacks", "vapes"]), sku: id, barcode: z.string().max(100).nullable().optional(),
  name: z.string().trim().min(1).max(250), description: z.string().max(20000).default(""), country: z.string().max(200).nullable().optional(), manufacturer: z.string().max(300).nullable().optional(),
  price: z.number().finite().min(0).max(20_000_000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, "Price must have at most two decimals"), stock: z.number().finite().min(0).max(1_000_000),
  volume: z.union([z.string().max(100), z.number().nonnegative()]).default(""), unit: z.string().max(30).default("pcs"), alcohol: z.union([z.string().max(30), z.number().min(0).max(100)]).nullable().optional(),
  beerColor: z.enum(["light", "dark"]).nullable().optional(), beerFiltration: z.enum(["filtered", "unfiltered"]).nullable().optional(),
  shelfLifeDays: z.number().int().nonnegative().nullable().optional(), expiryDate: z.iso.date().nullable().optional(),
  batches: z.array(z.object({ batchId: id, quantity: z.number().nonnegative(), expiryDate: z.iso.date() }).passthrough()).max(10000).default([]),
  imageUrl: z.string().max(1000).refine(value => {
    if (/^\/images\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|avif)$/.test(value)) return true;
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
  }).nullable().optional(), isNew: z.boolean(), isActive: z.boolean(), updatedAt: timestamp,
  attributes: z.record(z.string().max(100), z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()])).default({}),
}).passthrough();
export const catalogSchema = z.object({ ...metadata, products: z.array(catalogProductSchema).max(100000) });
export const loyaltyOperationSchema = z.object({ operationId: id, receiptId: id, kind: z.enum(["ACCRUAL", "REDEMPTION", "REVERSAL"]), amount: z.number().finite().positive().max(1_000_000_000), createdAt: timestamp, status: z.enum(["SUCCESS", "PENDING", "FAILED", "REVERSED"]), description: z.string().max(1000).default("") });
export const loyaltyCustomerSchema = z.object({ customerId: id, cardId: id, balance: z.number().finite().nonnegative().max(1_000_000_000), updatedAt: timestamp, historyAvailable: z.boolean().optional(), operations: z.array(loyaltyOperationSchema).max(100000) });
export const loyaltySchema = z.object({ ...metadata, customers: z.array(loyaltyCustomerSchema).max(100000) });
export type LoyaltyCustomer = z.infer<typeof loyaltyCustomerSchema>;

export function normalizeSnapshot(value: unknown, kind: "catalog" | "loyalty") {
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const result = { ...row, schema_version: row.schema_version ?? row.schemaVersion, export_id: row.export_id ?? row.exportId, generated_at: row.generated_at ?? row.generatedAt ?? row.exportedAt };
  if (kind === "catalog" && Array.isArray(row.products)) {
    return {
      ...result,
      products: row.products.map(product => ({
        ...product,
        siteCategory: product.siteCategory === "beer_drink" ? "beer_drinks" : product.siteCategory,
        unit: product.unit ?? product.stockUnit ?? "pcs",
      })),
    };
  }
  if (kind === "loyalty" && Array.isArray(row.customers)) return { ...result, customers: row.customers.map(customer => ({ ...customer, operations: Array.isArray(customer.operations) ? customer.operations.map((operation: Record<string, unknown>) => ({ ...operation, createdAt: operation.createdAt ?? operation.occurredAt })) : customer.operations })) };
  return result;
}
function noDuplicates(values: string[], label: string) { if (new Set(values).size !== values.length) throw new Error(`DUPLICATE_${label}`); }
function freshness(next: { export_id: string; generated_at: string }, previous: SnapshotStatus, hash: string) {
  if (Date.parse(next.generated_at) > Date.now() + 300_000) throw new Error("FUTURE_EXPORT");
  if (next.export_id === previous.exportId) { if (hash !== previous.digest) throw new Error("EXPORT_ID_REUSED"); return false; }
  if (previous.generatedAt && Date.parse(next.generated_at) <= Date.parse(previous.generatedAt)) throw new Error("STALE_EXPORT");
  return true;
}
const list = (value?: string) => new Set((value || "").split(",").map(item => item.trim()).filter(Boolean));
async function archive(kind: string, previous: unknown) {
  if (previous) await atomicWrite(path.join(/*turbopackIgnore: true*/ dataDir(), "archive", kind, `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}.json`), previous);
}
export async function importSnapshot(kind: "catalog" | "loyalty", value: unknown) {
  return mutateState(async state => {
    const normalized = normalizeSnapshot(value, kind);
    if (normalized && typeof normalized === "object") {
      const envelope = normalized as Record<string, unknown>;
      const rows = envelope[kind === "catalog" ? "products" : "customers"];
      for (const countKey of kind === "catalog" ? ["productCount", "product_count", "total"] : ["total", "customerCount"]) {
        if (envelope[countKey] !== undefined && (!Array.isArray(rows) || envelope[countKey] !== rows.length)) throw new Error("INCOMPLETE_SNAPSHOT");
      }
      if (envelope.hasMore === true || envelope.nextPage || envelope.nextCursor || (envelope.snapshotType !== undefined && envelope.snapshotType !== "full") || (envelope.mode !== undefined && envelope.mode !== "full") || (envelope.currency !== undefined && envelope.currency !== "RUB")) throw new Error("FULL_RUB_SNAPSHOT_REQUIRED");
    }
    const snapshot = kind === "catalog" ? catalogSchema.parse(normalized) : loyaltySchema.parse(normalized);
    const hash = digest(JSON.stringify(snapshot));
    const status = state.sync[kind];
    const changed = freshness(snapshot, status, hash);
    if (kind === "catalog") {
      const catalog = catalogSchema.parse(snapshot);
      noDuplicates(catalog.products.map(row => row.externalId), "PRODUCT_ID"); noDuplicates(catalog.products.map(row => row.sku), "SKU");
      noDuplicates(catalog.products.flatMap(row => row.barcode ? [row.barcode] : []), "BARCODE");
      const categories = list(process.env.ONE_C_ALLOWED_CATEGORY_IDS), ids = list(process.env.ONE_C_ALLOWED_PRODUCT_IDS);
      if (!categories.size && !ids.size) throw new Error("ALLOWLIST_REQUIRED");
      const products = catalog.products.filter(row => categories.has(row.categoryId) || ids.has(row.externalId));
      for (const product of catalog.products) {
        if (Date.parse(product.updatedAt) > Date.parse(catalog.generated_at)) throw new Error("PRODUCT_NEWER_THAN_EXPORT");
        const old = state.tables.product.find(row => row.externalId === product.externalId);
        if (old?.sourceUpdatedAt && Date.parse(product.updatedAt) < old.sourceUpdatedAt.getTime()) throw new Error("STALE_PRODUCT");
        noDuplicates(product.batches.map(batch => batch.batchId), "BATCH_ID");
      }
      const policy = digest(`${process.env.ONE_C_ALLOWED_CATEGORY_IDS || ""}:${process.env.ONE_C_ALLOWED_PRODUCT_IDS || ""}`);
      const acceptedPolicy = (status as SnapshotStatus & { policy?: string }).policy;
      if (changed || policy !== acceptedPolicy) {
        await archive(kind, state.catalog);
        const resetIds = new Set<string>();
        for (const old of state.tables.product) {
          if (old.source !== "1c" && old.source !== fallbackCatalogSource && !old.manualOverride) continue;
          resetIds.add(old.id);
          old.isActive = false;
          old.stock = 0;
          old.status = "ARCHIVED";
          old.manualOverride = false;
          old.updatedAt = new Date();
        }
        for (const stock of state.tables.inventory) if (resetIds.has(stock.productId)) stock.quantity = 0;
        for (const product of products) {
          const now = new Date(), old = state.tables.product.find(row => row.externalId === product.externalId);
          const productId = old?.id || crypto.randomUUID();
          const attributes = { ...product.attributes };
          for (const key of ["ciderType", "poireType", "sweetness", "flavor", "nicotine", "puffs", "composition", "packaging", "productSubtype", "netWeightGrams", "nicotineMg", "puffCount"]) if (product[key] !== undefined) attributes[key] = product[key] as string;
          const row = { ...product, id: productId, category: product.siteCategory, slug: old?.slug || `p-${digest(product.externalId).slice(0, 32)}`, price: Math.round(product.price * 100), volume: String(product.volume), alcohol: product.alcohol == null ? null : String(product.alcohol), imageUrl: product.imageUrl ?? null, categoryId: product.categoryId, externalId: product.externalId, barcode: product.barcode ?? null, country: product.country ?? null, manufacturer: product.manufacturer ?? null, beerColor: product.beerColor ?? null, beerFiltration: product.beerFiltration ?? null, shelfLifeDays: product.shelfLifeDays ?? null, expiryDate: product.expiryDate ?? null, source: "1c", status: product.isActive ? "PUBLISHED" as const : "ARCHIVED" as const, createdAt: old?.createdAt || now, updatedAt: now, sourceUpdatedAt: new Date(product.updatedAt), priceUpdatedAt: new Date(product.updatedAt), attributes };
          const conflict = state.tables.product.some(item => item.id !== productId && (item.sku === row.sku || item.slug === row.slug));
          if (conflict) throw new Error("CATALOG_CONFLICT");
          if (old) Object.assign(old, row, { manualOverride: false, manualOrderBlocked: false }); else state.tables.product.push(row);
          const inventory = state.tables.inventory.find(item => item.productId === productId && item.warehouseId === "hops-store");
          if (inventory) { inventory.quantity = product.isActive ? product.stock : 0; inventory.sourceUpdatedAt = new Date(product.updatedAt); inventory.updatedAt = now; }
          else state.tables.inventory.push({ id: crypto.randomUUID(), productId, warehouseId: "hops-store", quantity: product.isActive ? product.stock : 0, reserved: 0, createdAt: now, updatedAt: now, sourceUpdatedAt: new Date(product.updatedAt) });
        }
        state.catalog = catalog;
        (status as SnapshotStatus & { policy?: string }).policy = policy;
      }
      status.count = products.length;
    } else {
      const loyalty = loyaltySchema.parse(snapshot);
      noDuplicates(loyalty.customers.map(row => row.customerId), "CUSTOMER_ID"); noDuplicates(loyalty.customers.map(row => row.cardId), "CARD_ID");
      noDuplicates(loyalty.customers.flatMap(row => row.operations.map(operation => operation.operationId)), "OPERATION_ID");
      const previous = state.loyalty ? loyaltySchema.parse(state.loyalty) : null;
      for (const customer of loyalty.customers) {
        if (Date.parse(customer.updatedAt) > Date.parse(loyalty.generated_at)) throw new Error("CUSTOMER_NEWER_THAN_EXPORT");
        if (customer.operations.some(op => Date.parse(op.createdAt) > Date.parse(customer.updatedAt))) throw new Error("OPERATION_NEWER_THAN_BALANCE");
        const old = previous?.customers.find(row => row.customerId === customer.customerId);
        if (old && Date.parse(customer.updatedAt) < Date.parse(old.updatedAt)) throw new Error("STALE_BALANCE");
      }
      if (changed) { await archive(kind, state.loyalty); state.loyalty = loyalty; }
      refreshBalances(state); status.count = loyalty.customers.length;
    }
    Object.assign(status, { checkedAt: new Date().toISOString(), ...(changed ? { syncedAt: new Date().toISOString() } : {}), generatedAt: snapshot.generated_at, exportId: snapshot.export_id, digest: hash, error: undefined });
    return changed;
  });
}
function refreshBalances(state: State) {
  const customers = state.loyalty ? loyaltySchema.parse(state.loyalty).customers : [];
  for (const user of state.tables.user) {
    const account = user.externalId ? customers.find(row => row.customerId === user.externalId) : null;
    user.bonusBalance = account?.balance || 0; user.bonusUpdatedAt = account ? new Date(account.updatedAt) : null;
  }
}
export async function bindCustomer(userId: string, customerId: string, actorId: string) {
  await mutateState(state => {
    if (!state.tables.user.some(user => user.id === actorId && user.role === "ADMIN")) throw new Error("ADMIN_REQUIRED");
    const user = state.tables.user.find(row => row.id === userId);
    const loyalty = loyaltySchema.parse(state.loyalty);
    if (!user || !loyalty.customers.some(row => row.customerId === customerId)) throw new Error("CUSTOMER_NOT_FOUND");
    if (user.externalId && user.externalId !== customerId) throw new Error("ACCOUNT_ALREADY_LINKED");
    if (state.tables.user.some(row => row.id !== userId && row.externalId === customerId)) throw new Error("CUSTOMER_ALREADY_LINKED");
    user.externalId = customerId; refreshBalances(state);
    state.tables.auditLog.push({ id: crypto.randomUUID(), actorId, action: "CLIENT_BIND_VERIFIED", targetId: userId, createdAt: new Date(), updatedAt: new Date() });
  });
}
export async function ownLoyalty(userId: string): Promise<LoyaltyCustomer | null> {
  await syncSnapshots();
  const state = await readState(), user = state.tables.user.find(row => row.id === userId);
  if (!user?.externalId || !state.loyalty) return null;
  return loyaltySchema.parse(state.loyalty).customers.find(row => row.customerId === user.externalId) || null;
}
type SnapshotSync = {
  nextCheck: number;
  running?: Promise<void>;
  signatures: Map<string, string>;
};
// Next bundles startup instrumentation and routes separately in the same Node process.
const runtime = globalThis as typeof globalThis & { hopsSnapshotSync?: SnapshotSync };
const sync: SnapshotSync = runtime.hopsSnapshotSync ??= { nextCheck: 0, signatures: new Map() };

export async function syncSnapshots(force = false): Promise<void> {
  if (sync.running) return sync.running;
  const now = Date.now();
  if (!force && now < sync.nextCheck) return;
  sync.nextCheck = now + snapshotCheckMinutes * 60_000;
  sync.running = (async () => {
    for (const kind of ["catalog", "loyalty"] as const) {
      try {
        const file = privatePath(process.env[kind === "catalog" ? "HOPS_CATALOG_FILE" : "HOPS_LOYALTY_FILE"] || path.join(/*turbopackIgnore: true*/ dataDir(), "incoming", `${kind}.json`));
        const stat = await fs.stat(/*turbopackIgnore: true*/ file);
        if (stat.size > 64 * 1024 * 1024) throw new Error("SNAPSHOT_TOO_LARGE");
        const signature = `${stat.mtimeMs}:${stat.size}:${list(process.env.ONE_C_ALLOWED_CATEGORY_IDS).size}:${process.env.ONE_C_ALLOWED_CATEGORY_IDS}:${process.env.ONE_C_ALLOWED_PRODUCT_IDS}`;
        if (!force && sync.signatures.get(kind) === signature) continue;
        const body = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8");
        const after = await fs.stat(/*turbopackIgnore: true*/ file);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("SNAPSHOT_CHANGING");
        await importSnapshot(kind, JSON.parse(body.replace(/^\uFEFF/, ""))); sync.signatures.set(kind, signature);
      } catch (error) {
        sync.signatures.delete(kind);
        await logError(`${kind}-sync`, error);
        await mutateState(state => { state.sync[kind].checkedAt = new Date().toISOString(); state.sync[kind].error = (error as NodeJS.ErrnoException).code === "ENOENT" ? "Файл выгрузки пока не найден." : "Выгрузка отклонена. Используются прежние проверенные данные. Проверьте формат, дату, ID и разрешённые категории."; });
      }
    }
  })().finally(() => { sync.running = undefined; });
  return sync.running;
}
