import { z } from "zod";

const id = z.string().min(1).max(200);
const date = z.coerce.date();
const base = { id, createdAt: date, updatedAt: date };
const manualCatalogFields = { manualOverride: z.boolean().optional(), manualOrderBlocked: z.boolean().optional() };
const legalVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const orderStatus = z.enum(["NEW", "CONFIRMED", "PREPARING", "READY", "COMPLETED", "CANCELLED"]);
export type OrderStatus = z.infer<typeof orderStatus>;
export const rowSchemas = {
  user: z.object({ ...base, email: z.email(), name: z.string(), phone: z.string().nullable(), passwordHash: z.string().regex(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/), role: z.enum(["CUSTOMER", "ADMIN"]), externalId: id.nullable(), bonusBalance: z.number().nonnegative(), bonusUpdatedAt: date.nullable() }),
  session: z.object({ ...base, tokenHash: z.string().length(64), userId: id, expiresAt: date }),
  rateLimit: z.object({ ...base, key: id, count: z.number().int().positive(), expiresAt: date }),
  product: z.object({ ...base, ...manualCatalogFields, externalId: id.nullable(), sku: id, slug: id, name: z.string(), description: z.string(), category: z.enum(["beer", "ciders", "poire", "beer_drinks", "lemonade", "snacks", "vapes"]), categoryId: id.nullable(), barcode: z.string().nullable(), stock: z.number().nonnegative(), country: z.string().nullable(), manufacturer: z.string().nullable(), alcohol: z.string().nullable(), volume: z.string(), unit: z.string(), beerColor: z.enum(["light", "dark"]).nullable(), beerFiltration: z.enum(["filtered", "unfiltered"]).nullable(), price: z.number().int().nonnegative().max(2_000_000_000), imageUrl: z.string().nullable(), isNew: z.boolean(), isActive: z.boolean(), source: z.string(), status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]), sourceUpdatedAt: date.nullable(), priceUpdatedAt: date.nullable(), shelfLifeDays: z.number().int().nonnegative().nullable(), expiryDate: z.string().nullable(), batches: z.array(z.record(z.string(), z.unknown())), attributes: z.record(z.string(), z.unknown()) }),
  warehouse: z.object({ ...base, externalId: id.nullable(), name: z.string(), address: z.string(), pickupEnabled: z.boolean() }),
  inventory: z.object({ ...base, productId: id, warehouseId: id, quantity: z.number().nonnegative(), reserved: z.number().nonnegative(), sourceUpdatedAt: date.nullable() }),
  arrival: z.object({ ...base, externalId: id.nullable(), productId: id, warehouseId: id, expectedAt: date, quantity: z.number().nonnegative(), received: z.boolean() }),
  cart: z.object({ ...base, tokenHash: z.string().length(64), userId: id.nullable(), expiresAt: date }),
  cartItem: z.object({ ...base, cartId: id, productId: id, quantity: z.number().int().min(1).max(99) }),
  order: z.object({ ...base, number: z.number().int().positive(), externalId: id.nullable(), checkoutKey: z.uuid(), userId: id, warehouseId: id, name: z.string(), phone: z.string(), pickupAt: date, comment: z.string(), confirmedInOneCAt: date.nullable(), receiptId: id.nullable(), confirmedCatalogExportId: id.nullable(), status: orderStatus, total: z.number().int().nonnegative(), sourceUpdatedAt: date.nullable() }),
  orderItem: z.object({ ...base, orderId: id, productId: id, name: z.string(), sku: id, price: z.number().int().nonnegative(), quantity: z.number().int().positive() }),
  review: z.object({ ...base, userId: id, name: z.string(), rating: z.number().int().min(1).max(5), text: z.string().min(10).max(2000), status: z.enum(["PENDING", "APPROVED", "REJECTED"]) }),
  shopSettings: z.object({ ...base, address: z.string(), shortAddress: z.string(), phone: z.string(), email: z.string(), hoursWeek: z.string(), hoursWeekend: z.string(), announcement: z.string(), pickupOpen: z.number().int().min(0).max(23), pickupClose: z.number().int().min(1).max(24), timezone: z.string(), loyaltyRules: z.string().max(20000), loyaltyRulesConfirmed: z.boolean(), legalDetails: z.record(z.string(), z.string().max(1600)).optional() }),
  document: z.object({ ...base, slug: id, title: z.string(), content: z.string(), published: z.boolean(), draft: z.string().optional(), versions: z.array(z.object({ version: legalVersion, title: z.string(), content: z.string() })).optional() }),
  subscription: z.object({ ...base, email: z.email(), consentAt: date }),
  auditLog: z.object({ ...base, actorId: id, action: id, targetId: id.nullable(), legalVersions: z.record(z.string(), legalVersion).optional() }),
};
export type Model = keyof typeof rowSchemas;
export type Rows = { [K in Model]: z.infer<(typeof rowSchemas)[K]> };
export type Product = Rows["product"] & { inventories: Inventory[]; arrivals: (Rows["arrival"] & { warehouse: Rows["warehouse"] })[] };
export type Inventory = Rows["inventory"] & { warehouse: Rows["warehouse"]; product: Product };
export type CartItem = Rows["cartItem"] & { product: Product };
export type Order = Rows["order"] & { items: Rows["orderItem"][]; warehouse: Rows["warehouse"]; user: Rows["user"] };
export type Views = Rows & { product: Product; inventory: Inventory; cart: Rows["cart"] & { items: CartItem[] }; cartItem: CartItem; session: Rows["session"] & { user: Rows["user"] }; order: Order; arrival: Rows["arrival"] & { product: Product; warehouse: Rows["warehouse"] } };
export type SnapshotStatus = { checkedAt?: string; syncedAt?: string; generatedAt?: string; exportId?: string; digest?: string; error?: string; count?: number };
export type State = { version: 1; revision: number; tables: { [K in Model]: Rows[K][] }; sync: { catalog: SnapshotStatus; loyalty: SnapshotStatus }; catalog: unknown; loyalty: unknown };

export function validateState(value: unknown): State {
  const root = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), tables: z.record(z.string(), z.unknown()), sync: z.object({ catalog: z.record(z.string(), z.unknown()), loyalty: z.record(z.string(), z.unknown()) }), catalog: z.unknown(), loyalty: z.unknown() }).parse(value);
  const tables = Object.fromEntries(Object.entries(rowSchemas).map(([key, schema]) => [key, z.array(schema).parse(root.tables[key])]));
  const state = { ...root, tables } as State;
  for (const [name, rows] of Object.entries(state.tables)) {
    const ids = rows.map(row => row.id);
    if (new Set(ids).size !== ids.length || ids.some(value => !/^[a-zA-Z0-9_-]+$/.test(value))) throw new Error(`Invalid local IDs: ${name}`);
  }
  const uniqueFields = { user: ["email", "externalId"], product: ["sku", "slug", "externalId"], session: ["tokenHash"], cart: ["tokenHash"], order: ["number", "checkoutKey"], document: ["slug"], subscription: ["email"], rateLimit: ["key"] };
  for (const [name, fields] of Object.entries(uniqueFields)) for (const field of fields) {
    const values = (state.tables[name as Model] as unknown as Record<string, unknown>[]).map(row => row[field]).filter(value => value != null);
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${name}.${field}`);
  }
  const references: Partial<Record<Model, Record<string, Model>>> = { session: { userId: "user" }, cart: { userId: "user" }, cartItem: { cartId: "cart", productId: "product" }, order: { userId: "user", warehouseId: "warehouse" }, orderItem: { orderId: "order", productId: "product" }, inventory: { productId: "product", warehouseId: "warehouse" }, review: { userId: "user" }, arrival: { productId: "product", warehouseId: "warehouse" } };
  for (const [name, fields] of Object.entries(references)) for (const [field, target] of Object.entries(fields)) {
    const valid = new Set(state.tables[target].map(row => row.id));
    for (const row of state.tables[name as Model] as unknown as Record<string, unknown>[]) if (row[field] != null && !valid.has(String(row[field]))) throw new Error(`Missing ${name}.${field}`);
  }
  for (const rows of [state.tables.inventory.map(row => `${row.productId}:${row.warehouseId}`), state.tables.cartItem.map(row => `${row.cartId}:${row.productId}`), state.tables.orderItem.map(row => `${row.orderId}:${row.productId}`)]) if (new Set(rows).size !== rows.length) throw new Error("Duplicate compound key");
  const orders = new Map(state.tables.order.map(row => [row.id, row]));
  const totals = new Map<string, number>(), reservations = new Map<string, number>();
  for (const item of state.tables.orderItem) {
    totals.set(item.orderId, (totals.get(item.orderId) || 0) + item.price * item.quantity);
    const order = orders.get(item.orderId)!;
    if (order.status !== "CANCELLED" && !order.confirmedInOneCAt) {
      const key = `${item.productId}:${order.warehouseId}`;
      reservations.set(key, (reservations.get(key) || 0) + item.quantity);
    }
  }
  for (const order of state.tables.order) if (!totals.has(order.id) || totals.get(order.id) !== order.total) throw new Error("Order total mismatch");
  for (const inventory of state.tables.inventory) {
    const key = `${inventory.productId}:${inventory.warehouseId}`;
    if ((reservations.get(key) || 0) !== inventory.reserved) throw new Error("Reservation mismatch");
    reservations.delete(key);
  }
  if (reservations.size) throw new Error("Missing reserved inventory");
  if (state.tables.shopSettings.length !== 1 || state.tables.shopSettings[0].id !== "main") throw new Error("Missing settings");
  return state;
}
