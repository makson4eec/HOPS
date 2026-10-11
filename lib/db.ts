import "server-only";
import { randomUUID } from "node:crypto";
import { rowSchemas, type Model, type State, type Views } from "./models";
import { mutateState, readState } from "./storage";
import { syncSnapshots } from "./snapshots";

export type Query = { where?: Record<string, unknown>; include?: Record<string, unknown>; select?: Record<string, unknown>; orderBy?: Record<string, unknown> | Record<string, unknown>[]; take?: number; skip?: number };
type RecordData = Record<string, unknown>;
export class LocalConflictError extends Error {}
const relations: Partial<Record<Model, Record<string, [Model, string, string, boolean]>>> = {
  product: { inventories: ["inventory", "id", "productId", true], arrivals: ["arrival", "id", "productId", true] },
  inventory: { product: ["product", "productId", "id", false], warehouse: ["warehouse", "warehouseId", "id", false] },
  arrival: { product: ["product", "productId", "id", false], warehouse: ["warehouse", "warehouseId", "id", false] },
  session: { user: ["user", "userId", "id", false] },
  cart: { items: ["cartItem", "id", "cartId", true] }, cartItem: { product: ["product", "productId", "id", false] },
  order: { items: ["orderItem", "id", "orderId", true], warehouse: ["warehouse", "warehouseId", "id", false], user: ["user", "userId", "id", false] },
};
const records = (state: State, model: Model) => state.tables[model] as unknown as RecordData[];
function related(state: State, model: Model, row: RecordData, key: string) {
  const relation = relations[model]?.[key];
  if (!relation) return undefined;
  const [target, local, foreign, many] = relation;
  const rows = records(state, target).filter(item => item[foreign] === row[local]);
  return { target, rows, many };
}
function compare(a: unknown, b: unknown) {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  return left === right ? 0 : (left as string | number) < (right as string | number) ? -1 : 1;
}
function matches(state: State, model: Model, row: RecordData, where: RecordData = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as RecordData[]).some(part => matches(state, model, row, part));
    if (key === "AND") return (Array.isArray(expected) ? expected : [expected]).every(part => matches(state, model, row, part));
    if (key.includes("_") && !(key in row)) return matches(state, model, row, expected as RecordData);
    const relation = related(state, model, row, key);
    if (relation) return relation.rows.some(item => matches(state, relation.target, item, expected as RecordData));
    const actual = row[key];
    if (expected === null || typeof expected !== "object" || expected instanceof Date) return compare(actual, expected) === 0;
    const condition = expected as RecordData;
    return Object.entries(condition).every(([op, value]) => {
      if (op === "mode") return true;
      if (op === "contains") return String(actual ?? "").toLocaleLowerCase("ru").includes(String(value).toLocaleLowerCase("ru"));
      if (op === "startsWith") return String(actual ?? "").startsWith(String(value));
      if (op === "in") return (value as unknown[]).includes(actual);
      if (op === "notIn") return !(value as unknown[]).includes(actual);
      if (op === "not") return actual !== value;
      if (op === "equals") return compare(actual, value) === 0;
      if (op === "gt") return compare(actual, value) > 0;
      if (op === "gte") return compare(actual, value) >= 0;
      if (op === "lt") return compare(actual, value) < 0;
      if (op === "lte") return compare(actual, value) <= 0;
      throw new Error(`Unsupported query operator: ${op}`);
    });
  });
}
function queryRows(state: State, model: Model, query: Query): RecordData[] {
  let rows = records(state, model).filter(row => matches(state, model, row, query.where));
  const sort = Array.isArray(query.orderBy) ? query.orderBy : query.orderBy ? [query.orderBy] : [];
  rows = rows.sort((a, b) => {
    for (const part of sort) for (const [key, direction] of Object.entries(part)) {
      let left = a[key], right = b[key], order = direction;
      if (typeof direction === "object" && direction) {
        const [field, nestedOrder] = Object.entries(direction)[0];
        left = related(state, model, a, key)?.rows[0]?.[field]; right = related(state, model, b, key)?.rows[0]?.[field]; order = nestedOrder;
      }
      const result = compare(left, right); if (result) return order === "desc" ? -result : result;
    }
    return 0;
  });
  return rows.slice(query.skip || 0, query.take === undefined ? undefined : (query.skip || 0) + query.take).map(row => {
    const result: RecordData = query.select ? {} : { ...row };
    for (const [key, config] of Object.entries(query.select || query.include || {})) {
      if (!config) continue;
      const relation = related(state, model, row, key);
      if (!relation) { result[key] = row[key]; continue; }
      const child = typeof config === "object" ? config as Query : {};
      const [ , local, foreign] = relations[model]![key];
      const values = queryRows(state, relation.target, { ...child, where: { AND: [{ [foreign]: row[local] }, child.where || {}] } });
      result[key] = relation.many ? values : values[0] || null;
    }
    return result;
  });
}
function defaults(model: Model): RecordData {
  const common = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date() };
  const values: Partial<Record<Model, RecordData>> = {
    user: { role: "CUSTOMER", externalId: null, phone: null, bonusBalance: 0, bonusUpdatedAt: null },
    product: { externalId: null, description: "", categoryId: null, barcode: null, stock: 0, country: null, manufacturer: null, alcohol: null, isActive: true, source: "manual", volume: "", unit: "pcs", beerColor: null, beerFiltration: null, price: 0, imageUrl: null, isNew: false, status: "DRAFT", sourceUpdatedAt: null, priceUpdatedAt: null, shelfLifeDays: null, expiryDate: null, batches: [], attributes: {} },
    warehouse: { externalId: null, address: "", pickupEnabled: false }, inventory: { quantity: 0, reserved: 0, sourceUpdatedAt: null },
    cart: { userId: null }, order: { externalId: null, status: "NEW", comment: "", sourceUpdatedAt: null, confirmedInOneCAt: null, receiptId: null, confirmedCatalogExportId: null },
    review: { status: "PENDING" }, document: { published: false }, subscription: { consentAt: new Date() }, auditLog: { targetId: null },
  };
  return { ...common, ...values[model] };
}
const unique: Partial<Record<Model, string[][]>> = { user: [["email"], ["externalId"]], session: [["tokenHash"]], cart: [["tokenHash"]], cartItem: [["cartId", "productId"]], product: [["sku"], ["slug"], ["externalId"]], inventory: [["productId", "warehouseId"]], order: [["number"], ["checkoutKey"]], document: [["slug"]], subscription: [["email"]], rateLimit: [["key"]] };
function checkUnique(state: State, model: Model, row: RecordData, old?: RecordData) {
  for (const keys of [["id"], ...unique[model] || []]) {
    if (keys.some(key => row[key] == null)) continue;
    if (records(state, model).some(other => other !== old && keys.every(key => other[key] === row[key]))) throw new LocalConflictError("Duplicate record");
  }
}
function applyData(row: RecordData, data: RecordData) {
  const next: RecordData = { ...row, updatedAt: new Date() };
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !(value instanceof Date) && ("increment" in value || "decrement" in value)) {
      const delta = value as { increment?: number; decrement?: number };
      next[key] = Number(row[key]) + (delta.increment || 0) - (delta.decrement || 0);
    } else next[key] = value;
  }
  return next;
}
export class Repository<K extends Model> {
  constructor(private model: K, private state?: State) {}
  private async read<T>(fn: (state: State) => T) { if (this.state) return fn(this.state); await syncSnapshots(); return fn(await readState()); }
  private async write<T>(fn: (state: State) => T | Promise<T>) { return this.state ? fn(this.state) : mutateState(fn); }
  findMany(query: Query = {}): Promise<Views[K][]> { return this.read(state => queryRows(state, this.model, query) as unknown as Views[K][]); }
  async findFirst(query: Query = {}) { return (await this.findMany({ ...query, take: 1 }))[0] || null; }
  findUnique(query: Query) { return this.findFirst(query); }
  async findUniqueOrThrow(query: Query) { const row = await this.findFirst(query); if (!row) throw new Error("Record not found"); return row; }
  findFirstOrThrow(query: Query) { return this.findUniqueOrThrow(query); }
  count(query: Query = {}) { return this.read(state => records(state, this.model).filter(row => matches(state, this.model, row, query.where)).length); }
  groupBy(query: Query & { by: string[]; _count: boolean }) { return this.read(state => {
    const counts = new Map<string, number>();
    for (const row of records(state, this.model).filter(row => matches(state, this.model, row, query.where))) counts.set(String(row.category), (counts.get(String(row.category)) || 0) + 1);
    return [...counts].map(([category, _count]) => ({ category, _count }));
  }); }
  create(query: { data: RecordData; include?: RecordData }): Promise<Views[K]> { return this.write(state => {
    const data = { ...defaults(this.model), ...query.data };
    if (this.model === "order") data.number = Math.max(0, ...state.tables.order.map(order => order.number)) + 1;
    const row = rowSchemas[this.model].parse(data) as unknown as RecordData;
    checkUnique(state, this.model, row); records(state, this.model).push(row);
    if (this.model === "order" && query.data.items) {
      const items = (query.data.items as { create: RecordData[] }).create;
      for (const item of items) records(state, "orderItem").push(rowSchemas.orderItem.parse({ ...defaults("orderItem"), ...item, orderId: row.id }));
    }
    return queryRows(state, this.model, { where: { id: row.id }, include: query.include })[0] as unknown as Views[K];
  }); }
  updateMany(query: { where?: RecordData; data: RecordData }) { return this.write(state => {
    let count = 0;
    for (const row of records(state, this.model)) if (matches(state, this.model, row, query.where)) {
      const next = rowSchemas[this.model].parse(applyData(row, query.data)) as unknown as RecordData;
      checkUnique(state, this.model, next, row); Object.assign(row, next); count++;
    }
    return { count };
  }); }
  update(query: { where: RecordData; data: RecordData }): Promise<Views[K]> { return this.write(async state => {
    const repository = new Repository(this.model, state);
    const row = await repository.findUniqueOrThrow({ where: query.where });
    await repository.updateMany({ where: { id: row.id }, data: query.data });
    return repository.findUniqueOrThrow({ where: { id: row.id } });
  }); }
  upsert(query: { where: RecordData; create: RecordData; update: RecordData }): Promise<Views[K]> { return this.write(async state => {
    const repository = new Repository(this.model, state);
    return await repository.findUnique({ where: query.where }) ? repository.update({ where: query.where, data: query.update }) : repository.create({ data: query.create });
  }); }
  deleteMany(query: Query = {}) { return this.write(state => {
    const rows = records(state, this.model); let count = 0;
    for (let i = rows.length - 1; i >= 0; i--) if (matches(state, this.model, rows[i], query.where)) { rows.splice(i, 1); count++; }
    return { count };
  }); }
  delete(query: Query) { return this.deleteMany(query); }
}
export type LocalDb = { [K in Model]: Repository<K> };
export function repositories(state?: State): LocalDb { return Object.fromEntries(Object.keys(rowSchemas).map(key => [key, new Repository(key as Model, state)])) as LocalDb; }
export const db = { ...repositories(), $transaction: <T>(fn: (tx: LocalDb) => Promise<T>) => mutateState(state => fn(repositories(state))), $disconnect: async () => {} };
