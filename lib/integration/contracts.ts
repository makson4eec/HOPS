import { z } from "zod";

const externalId = z.string().trim().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true });
const amount = z.number().int().min(0).max(2_000_000_000);
const count = z.number().int().min(0).max(1_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);
const imageUrl = z.string().max(2048).refine((value) => {
  return /^\/images\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|avif)$/.test(value);
}, "Use local /images/ assets; remote image origins require an explicit CSP policy");

export const productSchema = z.object({
  externalId, sku: text(100), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180),
  name: text(250), description: z.string().max(20_000).default(""), category: text(100),
  volume: z.string().max(100).default(""), imageUrl: imageUrl.nullable().default(null),
  isNew: z.boolean().default(false), status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
  updatedAt: timestamp,
}).strict();
export const warehouseSchema = z.object({
  externalId, name: text(200), address: z.string().max(500), pickupEnabled: z.boolean(), updatedAt: timestamp,
}).strict();
export const priceSchema = z.object({ productExternalId: externalId, amount, currency: z.literal("RUB"), updatedAt: timestamp }).strict();
export const stockSchema = z.object({ productExternalId: externalId, warehouseExternalId: externalId, quantity: count, updatedAt: timestamp }).strict();
export const arrivalSchema = z.object({
  externalId, productExternalId: externalId, warehouseExternalId: externalId,
  expectedAt: timestamp, quantity: count, received: z.boolean(), updatedAt: timestamp,
}).strict();
const paging = { cursor: z.string().max(2000).nullable(), hasMore: z.boolean() };
export const catalogPageSchema = z.object({
  ...paging,
  products: z.array(productSchema).max(5000), warehouses: z.array(warehouseSchema).max(1000),
  prices: z.array(priceSchema).max(5000), stock: z.array(stockSchema).max(10_000), arrivals: z.array(arrivalSchema).max(5000),
}).strict().superRefine((page, ctx) => {
  if (page.hasMore && !page.cursor) ctx.addIssue({ code: "custom", message: "A continuation page requires a cursor" });
  const feeds: Array<[string, string[]]> = [
    ["products", page.products.map((p) => p.externalId)], ["warehouses", page.warehouses.map((w) => w.externalId)],
    ["prices", page.prices.map((p) => p.productExternalId)],
    ["stock", page.stock.map((s) => JSON.stringify([s.productExternalId, s.warehouseExternalId]))],
    ["arrivals", page.arrivals.map((a) => a.externalId)],
  ];
  for (const [feed, ids] of feeds) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [feed], message: "Duplicate external identifiers in page" });
  }
});
export const orderStatusSchema = z.enum(["NEW", "CONFIRMED", "PREPARING", "READY", "COMPLETED", "CANCELLED"]);
export const statusPageSchema = z.object({
  ...paging,
  orders: z.array(z.object({ externalId, status: orderStatusSchema, updatedAt: timestamp }).strict()).max(5000),
}).strict().superRefine((page, ctx) => {
  if (page.hasMore && !page.cursor) ctx.addIssue({ code: "custom", message: "A continuation page requires a cursor" });
  if (new Set(page.orders.map((o) => o.externalId)).size !== page.orders.length) ctx.addIssue({ code: "custom", path: ["orders"], message: "Duplicate order identifiers" });
});
export const exportOrderSchema = z.object({
  idempotencyKey: text(250), localId: text(100), externalId: externalId.nullable(), number: z.number().int().positive(),
  customer: z.object({ externalId: externalId.nullable(), name: text(200), email: z.email(), phone: text(40) }).strict(),
  warehouseExternalId: externalId, pickupAt: timestamp, comment: z.string().max(2000),
  status: orderStatusSchema, total: amount, currency: z.literal("RUB"), updatedAt: timestamp,
  items: z.array(z.object({ productExternalId: externalId, sku: text(100), name: text(250), price: amount, quantity: count.min(1) }).strict()).min(1).max(500),
}).strict().refine((order) => order.items.reduce((sum, item) => sum + item.price * item.quantity, 0) === order.total, "Order total differs from item sum");
export const exportReceiptSchema = z.object({ externalId, accepted: z.literal(true) }).strict();
export const clientQuerySchema = z.object({ email: z.email(), phone: z.string().max(40).nullable() }).strict();
export const clientResultSchema = z.object({
  client: z.object({ externalId, bonusBalance: amount, updatedAt: timestamp }).strict().nullable(),
}).strict();
export const bonusRequestSchema = z.object({
  idempotencyKey: text(250), clientExternalId: externalId,
  kind: z.enum(["ACCRUAL", "REDEMPTION", "REVERSAL"]), amount: amount.min(1), description: text(500),
}).strict();
export const bonusReceiptSchema = z.object({ externalId, balance: amount, updatedAt: timestamp, accepted: z.literal(true) }).strict();

export type CatalogPage = z.infer<typeof catalogPageSchema>;
export type StatusPage = z.infer<typeof statusPageSchema>;
export type ExportOrder = z.infer<typeof exportOrderSchema>;
export type ClientQuery = z.infer<typeof clientQuerySchema>;
export type BonusRequest = z.infer<typeof bonusRequestSchema>;

/** Transport deliberately returns unknown: every response must cross runtime validation. */
export interface OneCAdapter {
  readonly mode: "test" | "live";
  fetchCatalog(cursor: string | null, signal: AbortSignal): Promise<unknown>;
  fetchOrderStatuses(cursor: string | null, signal: AbortSignal): Promise<unknown>;
  exportOrder(order: ExportOrder, signal: AbortSignal): Promise<unknown>;
  findClient(query: ClientQuery, signal: AbortSignal): Promise<unknown>;
  operateBonus(operation: BonusRequest, signal: AbortSignal): Promise<unknown>;
}
