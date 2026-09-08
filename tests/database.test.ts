import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CheckoutInput } from "../lib/checkout";

test("PostgreSQL protects inventory, checkout replay, prices, owner boundaries and reservations", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.equal(url.pathname, "/hops_test", "Database tests run only in a disposable hops_test database");
  process.env.DATABASE_URL = url.toString();
  const { db } = await import("../lib/db");
  const { placeOrder } = await import("../lib/checkout");
  const { serializable, transitionOrder } = await import("../lib/orders");
  const tag = `test-${randomUUID()}`;
  const users: string[] = [];
  let productId = ""; let warehouseId = "";
  try {
    for (let i = 0; i < 2; i++) users.push((await db.user.create({ data: { email: `${tag}-${i}@example.test`, name: "Automated test fixture", passwordHash: "unusable" } })).id);
    warehouseId = (await db.warehouse.create({ data: { name: tag, pickupEnabled: true } })).id;
    productId = (await db.product.create({ data: { name: "Automated invariant fixture", sku: tag, slug: tag, category: "snacks", price: 12345, status: "PUBLISHED" } })).id;
    await db.inventory.create({ data: { productId, warehouseId, quantity: 1 } });
    const inputs: CheckoutInput[] = [];
    for (const userId of users) {
      const cart = await db.cart.create({ data: { userId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000), items: { create: { productId, quantity: 1 } } } });
      inputs.push({ cartId: cart.id, userId, checkoutKey: randomUUID(), warehouseId, name: "Automated test", phone: "+79990000000", pickupAt: new Date(Date.now() + 3600000), comment: "" });
    }
    const results = await Promise.allSettled(inputs.map(input => placeOrder(input)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "Only one concurrent order can reserve the last unit");
    const losing = results.find(result => result.status === "rejected");
    assert.ok(losing && losing.status === "rejected" && /Недостаточно/.test(losing.reason.message), "Serialization conflicts retry into a useful stock error");
    const winnerIndex = results.findIndex(r => r.status === "fulfilled");
    const winning = results[winnerIndex];
    assert.equal(winning.status, "fulfilled");
    if (winning.status !== "fulfilled") throw new Error("No winning checkout");
    assert.equal(winning.value.total, 12345, "Prices come from PostgreSQL");
    const repeated = await placeOrder(inputs[winnerIndex]);
    assert.equal(repeated.id, winning.value.id, "Same checkout key cannot create a duplicate");
    await assert.rejects(() => placeOrder({ ...inputs[1 - winnerIndex], checkoutKey: inputs[winnerIndex].checkoutKey }), /Обновите/);
    let stock = await db.inventory.findUniqueOrThrow({ where: { productId_warehouseId: { productId, warehouseId } } });
    assert.equal(stock.quantity, 1); assert.equal(stock.reserved, 1);
    await serializable(tx => transitionOrder(tx, repeated.id, "CANCELLED"));
    await serializable(tx => transitionOrder(tx, repeated.id, "CANCELLED"));
    stock = await db.inventory.findUniqueOrThrow({ where: { id: stock.id } });
    assert.equal(stock.quantity, 1); assert.equal(stock.reserved, 0, "Repeated cancellation releases stock once");
    await assert.rejects(() => serializable(tx => transitionOrder(tx, repeated.id, "READY")));
    const second = await placeOrder(inputs[1 - winnerIndex]);
    for (const status of ["CONFIRMED", "PREPARING", "READY", "COMPLETED"] as const) await serializable(tx => transitionOrder(tx, second.id, status));
    await serializable(tx => transitionOrder(tx, second.id, "COMPLETED"));
    stock = await db.inventory.findUniqueOrThrow({ where: { id: stock.id } });
    assert.equal(stock.quantity, 0); assert.equal(stock.reserved, 0, "Fulfillment consumes inventory once");
    assert.equal(await db.order.count({ where: { userId: { in: users } } }), 2);
    assert.equal(await db.syncJob.count({ where: { kind: "ORDER_EXPORT", payload: { path: ["orderId"], equals: repeated.id } } }), 1);
    await assert.rejects(() => db.inventory.update({ where: { id: stock.id }, data: { quantity: -1 } }));
  } finally {
    const orders = await db.order.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await db.syncJob.deleteMany({ where: { dedupeKey: { in: orders.map(o => `order:${o.id}:NEW`) } } });
    await db.order.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    if (productId) await db.product.delete({ where: { id: productId } });
    if (warehouseId) await db.warehouse.delete({ where: { id: warehouseId } });
    await db.$disconnect();
  }
});
