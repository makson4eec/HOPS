import path from "node:path";
import { db } from "../../lib/db";
import { bindCustomer, syncSnapshots } from "../../lib/snapshots";
import { hashPassword } from "../../lib/security";
import { atomicWrite, mutateState, readState } from "../../lib/storage";
const folder = path.resolve(process.env.HOPS_DATA_DIR || "");
if (!folder.startsWith(path.resolve(".test-data") + path.sep)) throw new Error("Fixture requires isolated .test-data folder");
if (process.argv[2] === "reset") {
  await mutateState(state => {
    state.tables.order = []; state.tables.orderItem = []; state.tables.cart = []; state.tables.cartItem = [];
    state.tables.inventory = []; state.tables.arrival = []; state.tables.product = []; state.tables.review = [];
    state.tables.document = []; delete state.tables.shopSettings[0].legalDetails;
    state.catalog = null; state.loyalty = null; state.sync = { catalog: {}, loyalty: {} };
    for (const user of state.tables.user) { user.externalId = null; user.bonusBalance = 0; user.bonusUpdatedAt = null; }
  });
} else {
  process.env.ONE_C_ALLOWED_CATEGORY_IDS = "e2e";
  process.env.HOPS_CATALOG_FILE = path.join(folder, "incoming", "catalog1.json");
  process.env.HOPS_LOYALTY_FILE = path.join(folder, "incoming", "bonuska.json");
  const passwordHash = await hashPassword("e2e-shop-passphrase");
  const customer = await db.user.upsert({ where: { email: "commerce@example.test" }, create: { email: "commerce@example.test", name: "Тест покупателя", passwordHash }, update: { passwordHash } });
  const admin = await db.user.upsert({ where: { email: "commerce-admin@example.test" }, create: { email: "commerce-admin@example.test", name: "Тест администратора", passwordHash, role: "ADMIN" }, update: { passwordHash } });
  const at = new Date(Date.now() - 1000).toISOString();
  const meta = { schema_version: "1.0", generated_at: new Date().toISOString(), complete: true };
  const catalogId = crypto.randomUUID();
  const loyaltyId = crypto.randomUUID();
  const historyAvailable = process.argv[2] !== "balance-only";
  await atomicWrite(process.env.HOPS_CATALOG_FILE, { ...meta, export_id: catalogId, products: ["snacks", "beer"].map(category => ({ externalId: `e2e-${category}`, categoryId: "e2e", siteCategory: category, sku: `e2e-${category}`, name: `e2e-${category}`, price: 42.5, stock: category === "beer" ? 7.5 : 10, unit: category === "beer" ? "л" : "pcs", manufacturer: "Тестовый производитель", alcohol: category === "beer" ? 4.5 : 0, isActive: true, isNew: true, updatedAt: at })) });
  const operations = historyAvailable ? [{ operationId: "e2e-operation", receiptId: "e2e-receipt", kind: "ACCRUAL", amount: 111, status: "SUCCESS", createdAt: at, description: "Только личная операция" }] : [];
  await atomicWrite(process.env.HOPS_LOYALTY_FILE, { ...meta, export_id: loyaltyId, customers: [{ customerId: "e2e-customer", cardId: "e2e-card", balance: 111, updatedAt: at, historyAvailable, operations }, { customerId: "private-other", cardId: "private-card", balance: 999, updatedAt: at, operations: [] }] });
  await syncSnapshots(true);
  const { sync } = await readState();
  if (sync.catalog.exportId !== catalogId || sync.loyalty.exportId !== loyaltyId) throw new Error("Fixture snapshots were not accepted");
  await bindCustomer(customer.id, "e2e-customer", admin.id);
}
