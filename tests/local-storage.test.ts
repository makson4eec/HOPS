import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { db } from "../lib/db";
import { importSnapshot, bindCustomer, ownLoyalty, syncSnapshots } from "../lib/snapshots";
import { atomicWrite, dataDir, encodeState, mutateState, readState } from "../lib/storage";
import { placeOrder } from "../lib/checkout";
import { transitionOrder, confirmOrderInOneC } from "../lib/orders";
import { hashPassword, tokenHash } from "../lib/security";
import { backup, restore } from "../lib/backup";

const at = (offset = 0) => new Date(Date.now() - 60_000 + offset).toISOString();
const product = (externalId = "p1", stock = 5) => ({ externalId, categoryId: "allowed", siteCategory: "snacks", sku: externalId, name: "Снеки", price: 10.99, stock, unit: "pcs", isNew: true, isActive: true, updatedAt: at(-1000) });
const catalog = (products = [product()], time = at()) => ({ schema_version: "1.0", export_id: randomUUID(), generated_at: time, complete: true, products });
const customer = (customerId: string, balance: number) => ({ customerId, cardId: `card-${customerId}`, balance, updatedAt: at(-1000), operations: [{ operationId: `op-${customerId}`, receiptId: "receipt", kind: "ACCRUAL", amount: balance || 1, status: "SUCCESS", createdAt: at(-2000) }] });
const loyalty = () => ({ schema_version: "1.0", export_id: randomUUID(), generated_at: at(), complete: true, customers: [customer("c1", 10), customer("c2", 99)] });

test("local JSON store, catalog, checkout, recovery and isolation", async t => {
  await fs.mkdir(".test-data", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".test-data/unit-"));
  process.env.HOPS_DATA_DIR = root;
  process.env.ONE_C_ALLOWED_CATEGORY_IDS = "allowed";
  delete process.env.ONE_C_ALLOWED_PRODUCT_IDS;
  const passwordHash = await hashPassword("test-passphrase");
  try {
    await t.test("empty installation has no demo products", async () => {
      assert.equal((await readState()).tables.product.length, 0);
    });
    await t.test("snapshots reject duplicates, stale, incomplete and unknown categories", async () => {
      const snapshot = catalog(); await importSnapshot("catalog", snapshot);
      assert.equal(await importSnapshot("catalog", snapshot), false);
      await assert.rejects(importSnapshot("catalog", { ...catalog(), productCount: 100 }));
      await assert.rejects(importSnapshot("catalog", { ...catalog(), snapshotType: "delta" }));
      await assert.rejects(importSnapshot("catalog", { ...catalog(), hasMore: true }));
      const original = (await readState()).tables.product[0];
      assert.equal(original.price, 1099);
      await assert.rejects(importSnapshot("catalog", { ...catalog(), complete: false }));
      await assert.rejects(importSnapshot("catalog", catalog([product(), product()])));
      await assert.rejects(importSnapshot("catalog", catalog([{ ...product(), siteCategory: "secret" }])));
      await assert.rejects(importSnapshot("catalog", catalog([product()], at(-10000))));
      await assert.rejects(importSnapshot("catalog", { ...snapshot, products: [product("p1", 500)] }));
      assert.equal((await readState()).tables.product[0].stock, 5);
      process.env.ONE_C_ALLOWED_CATEGORY_IDS = "";
      await assert.rejects(importSnapshot("catalog", catalog()));
      process.env.ONE_C_ALLOWED_CATEGORY_IDS = "allowed";
    });
    await t.test("damaged incoming JSON preserves the accepted catalog and reports error", async () => {
      await fs.mkdir(path.join(root, "incoming"), { recursive: true });
      await fs.writeFile(path.join(root, "incoming/catalog.json"), '{"products":');
      await syncSnapshots(true);
      const state = await readState(); assert.equal(state.tables.product[0].stock, 5); assert.ok(state.sync.catalog.error);
    });
    const user = await db.user.create({ data: { email: "one@example.test", name: "One", passwordHash } });
    const other = await db.user.create({ data: { email: "two@example.test", name: "Two", passwordHash } });
    const admin = await db.user.create({ data: { email: "admin@example.test", name: "Admin", passwordHash, role: "ADMIN" } });
    await t.test("parallel writes preserve all updates and uniqueness", async () => {
      await Promise.all(Array.from({ length: 12 }, (_, i) => db.subscription.create({ data: { email: `parallel${i}@example.test` } })));
      assert.equal(await db.subscription.count(), 12);
      const results = await Promise.allSettled([db.user.create({ data: { email: user.email, name: "Duplicate", passwordHash } }), db.user.create({ data: { email: user.email, name: "Duplicate", passwordHash } })]);
      assert.ok(results.every(result => result.status === "rejected"));
      const session = await db.session.create({ data: { userId: user.id, tokenHash: tokenHash("opaque-session"), expiresAt: new Date(Date.now() + 60000) } });
      const selected = await db.session.findUniqueOrThrow({ where: { id: session.id }, include: { user: { select: { id: true, email: true } } } });
      assert.equal(selected.user.email, user.email); assert.equal("passwordHash" in selected.user, false);
      await db.session.deleteMany({ where: { userId: user.id } });
      assert.equal(await db.session.count({ where: { userId: user.id } }), 0);
    });
    await t.test("filesystem lock serializes independent Node processes", async () => {
      const script = path.join(root, "writer.ts");
      const storageModule = pathToFileURL(path.resolve("lib/storage.ts")).href;
      await fs.writeFile(script, `import { mutateState } from ${JSON.stringify(storageModule)}; for(let i=0;i<5;i++) await mutateState(s=>{s.tables.shopSettings[0].phone=String(Number(s.tables.shopSettings[0].phone||0)+1)});`);
      const writer = () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", script], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: "pipe" });
        let error = ""; child.stderr.on("data", data => { error += data; }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
      });
      await Promise.all([writer(), writer(), writer()]);
      assert.equal((await readState()).tables.shopSettings[0].phone, "15");
    });
    await t.test("loyalty binding requires staff, is unique, and isolates history", async () => {
      await importSnapshot("loyalty", loyalty());
      assert.equal(await ownLoyalty(user.id), null);
      await assert.rejects(bindCustomer(user.id, "c1", other.id));
      await bindCustomer(user.id, "c1", admin.id);
      await assert.rejects(bindCustomer(other.id, "c1", admin.id));
      await bindCustomer(other.id, "c2", admin.id);
      assert.equal((await ownLoyalty(user.id))?.balance, 10); assert.equal((await ownLoyalty(other.id))?.balance, 99);
      assert.deepEqual((await ownLoyalty(user.id))?.operations.map(op => op.operationId), ["op-c1"]);
    });
    const cart = await db.cart.create({ data: { userId: user.id, tokenHash: tokenHash("cart"), expiresAt: new Date(Date.now() + 60000) } });
    const productId = (await readState()).tables.product[0].id;
    await db.cartItem.create({ data: { cartId: cart.id, productId, quantity: 3 } });
    const input = { userId: user.id, cartId: cart.id, checkoutKey: randomUUID(), warehouseId: "hops-store", name: "One", phone: "+79991234567", pickupAt: new Date(Date.now() + 3600000), comment: "", expectedTotal: 3297 };
    let orderId = "";
    await t.test("parallel retries create one order and one reservation, outbox is unconfirmed", async () => {
      const orders = await Promise.all(Array.from({ length: 10 }, () => placeOrder(input)));
      orderId = orders[0].id; assert.equal(new Set(orders.map(order => order.id)).size, 1);
      assert.equal((await readState()).tables.inventory[0].reserved, 3);
      const outbox = JSON.parse(await fs.readFile(path.join(root, "outgoing/orders", `${orderId}.json`), "utf8"));
      assert.equal(outbox.exchangeStatus, "AWAITING_1C_CONFIRMATION"); assert.equal(outbox.items.length, 1);
      await assert.rejects(placeOrder({ ...input, userId: other.id }));
    });
    await t.test("competing orders cannot oversell and rollback is atomic", async () => {
      const carts = await Promise.all([user, other].map(person => db.cart.create({ data: { userId: person.id, tokenHash: tokenHash(randomUUID()), expiresAt: new Date(Date.now() + 60000) } })));
      for (const row of carts) await db.cartItem.create({ data: { cartId: row.id, productId, quantity: 2 } });
      const outcomes = await Promise.allSettled(carts.map(row => placeOrder({ ...input, userId: row.userId!, cartId: row.id, checkoutKey: randomUUID(), expectedTotal: 2198 })));
      assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
      assert.equal((await readState()).tables.inventory[0].reserved, 5);
      await db.$transaction(tx => transitionOrder(tx, orderId, "CANCELLED"));
      await db.$transaction(tx => transitionOrder(tx, orderId, "CANCELLED"));
      assert.equal((await readState()).tables.inventory[0].reserved, 2);
      await assert.rejects(placeOrder({ ...input, cartId: carts[1].id, userId: other.id, checkoutKey: randomUUID(), expectedTotal: 1 }));
      assert.equal((await readState()).tables.inventory[0].reserved, 2);
    });
    await t.test("regulated goods are rejected even by direct checkout calls", async () => {
      await db.product.update({ where: { id: productId }, data: { category: "beer" } });
      await db.cartItem.upsert({ where: { cartId_productId: { cartId: cart.id, productId } }, create: { cartId: cart.id, productId, quantity: 1 }, update: { quantity: 1 } });
      await assert.rejects(placeOrder({ ...input, checkoutKey: randomUUID(), expectedTotal: 1099 }));
      await db.product.update({ where: { id: productId }, data: { category: "snacks" } });
    });
    await t.test("new snapshots archive prior catalog and retain local reservations", async () => {
      await importSnapshot("catalog", catalog([product("p1", 1), product("not-allowed")].map(row => row.externalId === "not-allowed" ? { ...row, categoryId: "private" } : row), at(5000)));
      const state = await readState(); assert.equal(state.tables.product.length, 1); assert.equal(state.tables.inventory[0].reserved, 2); assert.equal(state.tables.inventory[0].quantity, 1);
      assert.ok((await fs.readdir(path.join(root, "archive/catalog"))).length);
    });
    await t.test("staff confirmation needs a new 1C stock snapshot and releases reserves once", async () => {
      const completed = (await readState()).tables.order.find(row => row.status !== "CANCELLED")!;
      for (const status of ["CONFIRMED", "PREPARING", "READY", "COMPLETED"] as const) await db.$transaction(tx => transitionOrder(tx, completed.id, status));
      await assert.rejects(confirmOrderInOneC(completed.id, "receipt-1", (await readState()).sync.catalog.exportId!, user.id));
      await assert.rejects(confirmOrderInOneC(completed.id, "receipt-1", (await readState()).sync.catalog.exportId!, admin.id));
      const snapshot = catalog([{ ...product("p1", 3), updatedAt: at(80000) }], at(90000));
      await importSnapshot("catalog", snapshot);
      await confirmOrderInOneC(completed.id, "receipt-1", snapshot.export_id, admin.id);
      await confirmOrderInOneC(completed.id, "receipt-1", snapshot.export_id, admin.id);
      assert.equal((await readState()).tables.inventory[0].reserved, 0);
      await assert.rejects(confirmOrderInOneC(completed.id, "another-receipt", snapshot.export_id, admin.id));
    });
    await t.test("abandoned cross-process lock is recovered", async () => {
      const lock = path.join(root, ".write-lock"); await fs.mkdir(lock);
      const stale = new Date(Date.now() - 120000); await fs.utimes(lock, stale, stale);
      assert.ok((await readState()).revision > 0);
    });
    await t.test("checksum recovery, durable intent replay, verified backups and restore", async () => {
      const state = await readState();
      await fs.writeFile(path.join(root, "state.json"), "broken");
      assert.equal((await readState()).revision, state.revision);
      state.tables.shopSettings[0].announcement = "Recovered intent"; state.revision++;
      await atomicWrite(path.join(root, "pending.json"), encodeState(state));
      assert.equal((await readState()).tables.shopSettings[0].announcement, "Recovered intent");
      const saved = await backup(path.join(root, "external-drive"));
      await mutateState(next => { next.tables.shopSettings[0].announcement = "Changed"; });
      await restore(saved);
      assert.equal((await readState()).tables.shopSettings[0].announcement, "Recovered intent");
      await fs.writeFile(path.join(root, "pending.json"), "broken");
      await assert.rejects(readState()); await fs.unlink(path.join(root, "pending.json"));
      await fs.writeFile(path.join(root, "state.json"), "broken");
      await fs.writeFile(path.join(root, "state.backup.json"), "broken");
      await assert.rejects(readState());
      await restore(saved);
      assert.equal((await readState()).tables.shopSettings[0].announcement, "Recovered intent");
      await fs.unlink(path.join(root, "state.json")); await fs.unlink(path.join(root, "state.backup.json"));
      await assert.rejects(readState());
      await restore(saved);
      assert.equal(dataDir(), root);
    });
  } finally {
    process.env.HOPS_DATA_DIR = root;
    await fs.rm(root, { recursive: true, force: true });
  }
});
