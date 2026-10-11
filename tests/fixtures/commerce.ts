import path from "node:path";
import { db } from "../../lib/db";
import { importSnapshot, bindCustomer } from "../../lib/snapshots";
import { hashPassword } from "../../lib/security";
import { mutateState } from "../../lib/storage";
const folder = path.resolve(process.env.HOPS_DATA_DIR || "");
if (!folder.startsWith(path.resolve(".test-data") + path.sep)) throw new Error("Fixture requires isolated .test-data folder");
if (process.argv[2] === "reset") {
  await mutateState(state => {
    state.tables.order = []; state.tables.orderItem = []; state.tables.cart = []; state.tables.cartItem = [];
    state.tables.inventory = []; state.tables.arrival = []; state.tables.product = []; state.tables.review = [];
    state.catalog = null; state.loyalty = null; state.sync = { catalog: {}, loyalty: {} };
    for (const user of state.tables.user) { user.externalId = null; user.bonusBalance = 0; user.bonusUpdatedAt = null; }
  });
} else {
  process.env.ONE_C_ALLOWED_CATEGORY_IDS = "e2e";
  const passwordHash = await hashPassword("e2e-shop-passphrase");
  const customer = await db.user.upsert({ where: { email: "commerce@example.test" }, create: { email: "commerce@example.test", name: "Тест покупателя", passwordHash }, update: { passwordHash } });
  const admin = await db.user.upsert({ where: { email: "commerce-admin@example.test" }, create: { email: "commerce-admin@example.test", name: "Тест администратора", passwordHash, role: "ADMIN" }, update: { passwordHash } });
  const at = new Date(Date.now() - 1000).toISOString();
  await importSnapshot("catalog", { schema_version: "1.0", export_id: crypto.randomUUID(), generated_at: new Date().toISOString(), complete: true, products: ["snacks", "beer"].map(category => ({ externalId: `e2e-${category}`, categoryId: "e2e", siteCategory: category, sku: `e2e-${category}`, name: `e2e-${category}`, price: 42.5, stock: 10, unit: "pcs", isActive: true, isNew: true, updatedAt: at })) });
  await importSnapshot("loyalty", { schema_version: "1.0", export_id: crypto.randomUUID(), generated_at: new Date().toISOString(), complete: true, customers: [{ customerId: "e2e-customer", cardId: "e2e-card", balance: 111, updatedAt: at, operations: [{ operationId: "e2e-operation", receiptId: "e2e-receipt", kind: "ACCRUAL", amount: 111, status: "SUCCESS", createdAt: at, description: "Только личная операция" }] }, { customerId: "private-other", cardId: "private-card", balance: 999, updatedAt: at, operations: [] }] });
  await bindCustomer(customer.id, "e2e-customer", admin.id);
}
