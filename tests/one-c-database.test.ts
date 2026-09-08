import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";
import { getOneCConfig } from "../lib/1c/config";
import mock from "../lib/1c/mock.json";

test("1C snapshot sync preserves manual products, reservations and atomicity in PostgreSQL", { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 }, async context => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.equal(url.pathname, "/hops_test");
  const schema = `hops_one_c_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^hops_one_c_test_[a-f0-9]{32}$/);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  const { db } = await import("../lib/db");
  const { syncOneCCatalog, OneCSyncError } = await import("../lib/1c/sync");
  const config = getOneCConfig({ ONE_C_USE_MOCK: "true", ONE_C_ALLOWED_CATEGORY_IDS: "mock-beer,mock-lemonade", ONE_C_ALLOWED_PRODUCT_IDS: "mock-103" });
  let payload: unknown = mock;
  let gate: Promise<void> | undefined;
  const server = createServer(async (_request, response) => {
    if (gate) await gate;
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const live = { ...config, useMock: false, apiUrl: `http://127.0.0.1:${address.port}` };
  try {
    await promisify(execFile)(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, timeout: 60_000 });
    await db.warehouse.create({ data: { id: "hops-store", name: "Test store", pickupEnabled: true } });
    const manual = await db.product.create({ data: { name: "Manual", sku: "manual", slug: "manual", category: "snacks", status: "PUBLISHED", externalId: "manual-external" } });

    await context.test("mock creates allowed products with kopecks, stock and unique IDs; replay updates", async () => {
      assert.deepEqual(await syncOneCCatalog(config), { received: 4, allowed: 3, created: 3, updated: 0, disabled: 0, errors: [] });
      const product = await db.product.findUniqueOrThrow({ where: { externalId: "mock-101" }, include: { inventories: true } });
      assert.equal(product.price, 19990); assert.equal(product.categoryId, "mock-beer");
      assert.equal(product.stock, 12); assert.equal(product.inventories[0].quantity, 12);
      assert.equal(product.source, "1c"); assert.equal(product.isActive, true);
      assert.deepEqual(await syncOneCCatalog(config), { received: 4, allowed: 3, created: 0, updated: 3, disabled: 0, errors: [] });
      assert.equal(await db.product.count(), 4);
      assert.equal((await db.product.findUniqueOrThrow({ where: { externalId: "mock-103" } })).stock, 0);
    });

    await context.test("changed data updates in place, retains editorial status/slug and reservations at zero stock", async () => {
      const product = await db.product.update({ where: { externalId: "mock-101" }, data: { slug: "edited-slug", status: "DRAFT" } });
      await db.inventory.updateMany({ where: { productId: product.id }, data: { reserved: 2 } });
      payload = { products: [{ ...mock.products[0], name: "Updated", price: 205.25, stock: -10 }] };
      const result = await syncOneCCatalog(live);
      assert.equal(result.disabled, 2); assert.equal(result.updated, 1);
      const updated = await db.product.findUniqueOrThrow({ where: { id: product.id }, include: { inventories: true } });
      assert.equal(updated.slug, "edited-slug"); assert.equal(updated.status, "DRAFT");
      assert.equal(updated.name, "Updated"); assert.equal(updated.price, 20525); assert.equal(updated.stock, 0);
      assert.equal(updated.inventories[0].quantity, 2); assert.equal(updated.inventories[0].reserved, 2);
      assert.deepEqual(await db.product.findUniqueOrThrow({ where: { id: manual.id } }), manual);
      await syncOneCCatalog(config);
      assert.equal(await db.product.count({ where: { source: "1c", isActive: true } }), 3);
    });

    await context.test("missing product, changed allow lists and empty lists deactivate without deletion", async () => {
      assert.equal((await syncOneCCatalog({ ...config, allowedProductIds: [] })).disabled, 1);
      assert.equal((await syncOneCCatalog({ ...config, allowedCategoryIds: [], allowedProductIds: [] })).disabled, 2);
      assert.equal(await db.product.count(), 4);
      assert.equal((await db.product.findUniqueOrThrow({ where: { id: manual.id } })).isActive, true);
      await syncOneCCatalog(config);
    });

    await context.test("invalid, duplicate, partial and conflicting snapshots roll back every write", async () => {
      const before = await db.product.findMany({ orderBy: { id: "asc" } });
      for (const body of [
        { products: [{ ...mock.products[0], stock: 90 }, { id: "broken" }] },
        { products: [mock.products[0], mock.products[0]] },
        { products: [], hasMore: true },
        { products: [{ ...mock.products[0], stock: 90 }, { ...mock.products[1], id: "manual-external" }] },
        { products: [{ ...mock.products[0], stock: 90 }, { ...mock.products[1], sku: "manual" }] },
      ]) {
        payload = body;
        await assert.rejects(syncOneCCatalog(live), error => error instanceof OneCSyncError && error.stats.created === 0 && error.stats.updated === 0 && error.stats.disabled === 0 && error.stats.errors.length === 1);
        assert.deepEqual(await db.product.findMany({ orderBy: { id: "asc" } }), before);
      }
    });

    await context.test("concurrent sync rejects before fetching; empty successful snapshot disables only 1c", async () => {
      payload = { products: [] };
      let release!: () => void;
      gate = new Promise<void>(resolve => { release = resolve; });
      const requested = once(server, "request");
      const first = syncOneCCatalog(live);
      await requested;
      try { await assert.rejects(syncOneCCatalog(config), error => error instanceof OneCSyncError && error.status === 409); }
      finally { release(); gate = undefined; }
      assert.equal((await first).disabled, 3);
      assert.equal(await db.product.count(), 4);
      assert.equal(await db.product.count({ where: { isActive: true } }), 1);
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    // Schema is generated above and restricted to this isolated test database.
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
