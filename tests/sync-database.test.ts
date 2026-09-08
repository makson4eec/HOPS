import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { EmptyTestAdapter } from "../lib/integration/adapter";
import type { CatalogPage, ExportOrder, OneCAdapter } from "../lib/integration/contracts";
import { IntegrationError, LEASE_MS, MAX_ATTEMPTS } from "../lib/integration/errors";

const execFileAsync = promisify(execFile);
const empty = { cursor: null, hasMore: false, products: [], warehouses: [], prices: [], stock: [], arrivals: [] } satisfies CatalogPage;
function adapterWith(overrides: Partial<OneCAdapter>): OneCAdapter {
  const base = new EmptyTestAdapter();
  return {
    mode: "test", fetchCatalog: (cursor) => base.fetchCatalog(cursor),
    fetchOrderStatuses: (cursor) => base.fetchOrderStatuses(cursor),
    exportOrder: (order) => base.exportOrder(order), findClient: (query) => base.findClient(query),
    operateBonus: (operation) => base.operateBonus(operation), ...overrides,
  };
}

test("PostgreSQL synchronization queue, imports and immutable exports", { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 }, async (context) => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  assert.equal(url.pathname, "/hops_test", "Synchronization tests only run in disposable hops_test");
  const schema = `hops_sync_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^hops_sync_test_[a-f0-9]{32}$/);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.ONE_C_MODE = "test";
  const { db } = await import("../lib/db");
  const { processNextJob, queueCatalogSync, queueClientLookup, queueBonusOperation, retrySyncJob } = await import("../lib/integration");
  try {
    await execFileAsync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 60_000 });

    await context.test("double scheduling deduplicates; test mode imports zero products", async () => {
      const [first, second] = await Promise.all([queueCatalogSync(), queueCatalogSync()]);
      assert.equal(first.id, second.id);
      assert.equal(await processNextJob(), true);
      assert.equal(await processNextJob(), false);
      assert.equal(await db.product.count(), 0);
      const job = await db.syncJob.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(job.status, "SUCCESS");
      assert.deepEqual(job.result, { mode: "test", records: 0, pages: 1 });
      assert.equal(await db.syncLog.count({ where: { jobId: first.id, message: "TEST_COMPLETED_NO_EXTERNAL_WRITES" } }), 1);
    });

    await context.test("expired leases recover and exhausted leases are logged as failed", async () => {
      const data = { kind: "CATALOG_IMPORT", payload: {}, status: "RUNNING" as const, lockedAt: new Date(Date.now() - LEASE_MS - 1000), lockToken: "abandoned" };
      const recoverable = await db.syncJob.create({ data: { ...data, dedupeKey: randomUUID(), attempts: 1 } });
      const exhausted = await db.syncJob.create({ data: { ...data, dedupeKey: randomUUID(), attempts: MAX_ATTEMPTS } });
      assert.equal(await processNextJob(), true);
      const recovered = await db.syncJob.findUniqueOrThrow({ where: { id: recoverable.id } });
      assert.equal(recovered.status, "SUCCESS");
      assert.equal(recovered.attempts, 2);
      assert.equal(recovered.lockToken, null);
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: exhausted.id } })).error, "LEASE_EXPIRED_MAX_ATTEMPTS");
      assert.equal(await db.syncLog.count({ where: { jobId: exhausted.id, message: "LEASE_EXPIRED_MAX_ATTEMPTS" } }), 1);
    });

    await context.test("permanent configuration errors stop and explicit retry recovers", async () => {
      const job = await queueCatalogSync();
      process.env.ONE_C_MODE = "live";
      try { await processNextJob(); } finally { process.env.ONE_C_MODE = "test"; }
      const failed = await db.syncJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(failed.status, "FAILED");
      assert.equal(failed.error, "LIVE_ADAPTER_NOT_CONFIGURED");
      assert.equal(failed.attempts, 1);
      await retrySyncJob(job.id);
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: job.id } })).attempts, 0);
      await processNextJob();
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status, "SUCCESS");
      await assert.rejects(() => retrySyncJob(job.id));
    });

    await context.test("transient failures persist bounded retries without private errors", async () => {
      const job = await queueCatalogSync();
      const failing = adapterWith({ fetchCatalog: async () => { throw new IntegrationError("TRANSPORT_UNAVAILABLE", true); } });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await processNextJob(failing);
        const current = await db.syncJob.findUniqueOrThrow({ where: { id: job.id } });
        assert.equal(current.attempts, attempt);
        assert.equal(current.error, "TRANSPORT_UNAVAILABLE");
        assert.equal(current.status, attempt < MAX_ATTEMPTS ? "PENDING" : "FAILED");
        assert.equal(await processNextJob(failing), false, `Backoff prevents an immediate retry (attempt=${attempt}, now=${new Date().toISOString()}, nextRunAt=${current.nextRunAt.toISOString()})`);
        if (attempt < MAX_ATTEMPTS) await db.syncJob.update({ where: { id: job.id }, data: { nextRunAt: new Date() } });
      }
    });

    // These synthetic records exist exclusively in the private disposable test schema.
    const sourceTime = "2026-09-04T10:00:00Z";
    let productId = "";
    let warehouseId = "";
    await context.test("imports preserve reservations, reject stale data, and roll back a bad whole page", async () => {
      const fixture: CatalogPage = {
        ...empty, cursor: "revision-1",
        products: [{ externalId: "test-product", sku: "test-product", slug: "test-product", name: "Private automated test fixture", description: "", category: "snacks", volume: "", imageUrl: null, isNew: false, status: "PUBLISHED", updatedAt: sourceTime }],
        warehouses: [{ externalId: "test-warehouse", name: "Private automated test warehouse", address: "Test schema only", pickupEnabled: true, updatedAt: sourceTime }],
        prices: [{ productExternalId: "test-product", amount: 100, currency: "RUB", updatedAt: sourceTime }],
        stock: [{ productExternalId: "test-product", warehouseExternalId: "test-warehouse", quantity: 10, updatedAt: sourceTime }],
      };
      await queueCatalogSync();
      await processNextJob(adapterWith({ mode: "live", fetchCatalog: async () => fixture }));
      productId = (await db.product.findUniqueOrThrow({ where: { externalId: "test-product" } })).id;
      warehouseId = (await db.warehouse.findUniqueOrThrow({ where: { externalId: "test-warehouse" } })).id;
      await db.inventory.updateMany({ data: { reserved: 3 } });
      await queueCatalogSync();
      await processNextJob(adapterWith({ mode: "live", fetchCatalog: async () => ({ ...empty, cursor: "revision-2", stock: [{ ...fixture.stock[0], quantity: 8, updatedAt: "2026-09-04T10:01:00Z" }] }) }));
      assert.equal((await db.inventory.findFirstOrThrow()).reserved, 3);
      assert.equal((await db.inventory.findFirstOrThrow()).quantity, 8);
      await queueCatalogSync();
      await processNextJob(adapterWith({ mode: "live", fetchCatalog: async () => ({ ...empty, cursor: "revision-3", stock: [{ ...fixture.stock[0], quantity: 999 }] }) }));
      assert.equal((await db.inventory.findFirstOrThrow()).quantity, 8, "Stale physical stock cannot overwrite a newer count");
      const bad = await queueCatalogSync();
      await processNextJob(adapterWith({ mode: "live", fetchCatalog: async () => ({ ...empty, cursor: "must-not-commit", products: [{ ...fixture.products[0], name: "Must roll back", updatedAt: "2026-09-04T10:02:00Z" }], stock: [{ ...fixture.stock[0], quantity: 2, updatedAt: "2026-09-04T10:02:00Z" }] }) }));
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: bad.id } })).error, "STOCK_BELOW_RESERVED");
      assert.equal((await db.product.findUniqueOrThrow({ where: { id: productId } })).name, fixture.products[0].name);
      assert.equal((await db.syncCursor.findUniqueOrThrow({ where: { id: "1c:live:catalog" } })).cursor, "revision-3");
      assert.equal(await db.product.count(), 1, "Replayed external identities never create duplicates");
    });

    const user = await db.user.create({ data: { email: "private-sync-test@example.test", name: "Private sync test", phone: "+79990000000", passwordHash: "unusable" } });
    const order = await db.order.create({ data: {
      checkoutKey: randomUUID(), userId: user.id, warehouseId, name: user.name, phone: user.phone!,
      pickupAt: new Date(Date.now() + 3600_000), total: 100, status: "CONFIRMED",
      items: { create: { productId, sku: "test-product", name: "Private automated test fixture", price: 100, quantity: 1 } },
    } });
    async function queueOrder(status: string) {
      return db.syncJob.create({ data: { kind: "ORDER_EXPORT", dedupeKey: `order:${order.id}:${status}`, payload: { orderId: order.id } } });
    }
    await context.test("two workers never dispatch the same order concurrently", async () => {
      const first = await queueOrder("NEW");
      const second = await queueOrder("CONFIRMED");
      let announceStart!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { announceStart = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      const adapter = adapterWith({ mode: "live", exportOrder: async () => { calls++; announceStart(); await gate; return { externalId: "test-external-order", accepted: true }; } });
      const processing = processNextJob(adapter);
      try {
        await started;
        assert.equal(await processNextJob(adapter), false);
        assert.equal(calls, 1);
        assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: second.id } })).attempts, 0);
      } finally { release(); await processing; }
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: first.id } })).status, "SUCCESS");
      await db.syncJob.update({ where: { id: second.id }, data: { nextRunAt: new Date() } });
      await processNextJob(adapter);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).externalId, "test-external-order");
    });

    await context.test("retry keeps the same request and idempotency key despite profile changes", async () => {
      await db.order.update({ where: { id: order.id }, data: { status: "PREPARING" } });
      const job = await queueOrder("PREPARING");
      const requests: ExportOrder[] = [];
      await processNextJob(adapterWith({ mode: "live", exportOrder: async (request) => { requests.push(structuredClone(request)); throw new IntegrationError("TRANSPORT_UNAVAILABLE", true); } }));
      await db.user.update({ where: { id: user.id }, data: { email: "changed-private-test@example.test" } });
      await db.syncJob.update({ where: { id: job.id }, data: { nextRunAt: new Date() } });
      await processNextJob(adapterWith({ mode: "live", exportOrder: async (request) => { requests.push(structuredClone(request)); return { externalId: "test-external-order", accepted: true }; } }));
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0], requests[1]);
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: job.id } })).status, "SUCCESS");
    });

    await context.test("an old failed snapshot never replays after the local order advances", async () => {
      await db.order.update({ where: { id: order.id }, data: { status: "READY" } });
      const stale = await queueOrder("READY");
      await processNextJob(adapterWith({ mode: "live", exportOrder: async () => { throw new IntegrationError("TRANSPORT_UNAVAILABLE", true); } }));
      await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
      await db.syncJob.update({ where: { id: stale.id }, data: { nextRunAt: new Date(0) } });
      let called = false;
      await processNextJob(adapterWith({ mode: "live", exportOrder: async () => { called = true; throw new Error("Must not send stale state"); } }));
      assert.equal(called, false);
      assert.deepEqual((await db.syncJob.findUniqueOrThrow({ where: { id: stale.id } })).result, { mode: "live", superseded: true, reason: "CURRENT_STATUS_CHANGED" });
      assert.equal(await db.syncJob.count({ where: { dedupeKey: `order:${order.id}:CANCELLED`, status: "PENDING" } }), 1);
      await processNextJob(adapterWith({ mode: "live", exportOrder: async (request) => {
        assert.equal(request.status, "CANCELLED");
        return { externalId: "test-external-order", accepted: true };
      } }));
    });

    await context.test("client contact changes before or during exchange prevent identity linking", async () => {
      const job = await queueClientLookup(user.id);
      await db.user.update({ where: { id: user.id }, data: { phone: "+79990000001" } });
      let called = false;
      await processNextJob(adapterWith({ mode: "live", findClient: async () => { called = true; return { client: null }; } }));
      assert.equal(called, false);
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: job.id } })).error, "CLIENT_CONTACTS_CHANGED");
      const second = await queueClientLookup(user.id);
      await processNextJob(adapterWith({ mode: "live", findClient: async () => {
        await db.user.update({ where: { id: user.id }, data: { phone: "+79990000002" } });
        return { client: { externalId: "must-not-link", bonusBalance: 999, updatedAt: sourceTime } };
      } }));
      assert.equal((await db.syncJob.findUniqueOrThrow({ where: { id: second.id } })).error, "CLIENT_CONTACTS_CHANGED");
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).externalId, null);
      await assert.rejects(() => queueClientLookup(user.id, { email: user.email, phone: user.phone }));
    });

    await context.test("confirmed bonus operations apply once and preserve a newer balance", async () => {
      await queueClientLookup(user.id);
      await processNextJob(adapterWith({ mode: "live", findClient: async () => ({ client: { externalId: "test-client", bonusBalance: 10, updatedAt: sourceTime } }) }));
      const operation = await db.bonusOperation.create({ data: { userId: user.id, idempotencyKey: randomUUID(), kind: "ACCRUAL", amount: 5, description: "Private automated test" } });
      const job = await queueBonusOperation(operation.id);
      let calls = 0;
      const bonusAdapter = adapterWith({ mode: "live", operateBonus: async (request) => {
        calls++;
        assert.equal(request.idempotencyKey, operation.idempotencyKey);
        return { externalId: "test-bonus-operation", balance: 15, updatedAt: "2026-09-04T10:01:00Z", accepted: true };
      } });
      await processNextJob(bonusAdapter);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).bonusBalance, 15);
      assert.equal((await db.bonusOperation.findUniqueOrThrow({ where: { id: operation.id } })).status, "SUCCESS");
      assert.equal((await queueBonusOperation(operation.id)).id, job.id);
      assert.equal(await processNextJob(bonusAdapter), false);
      // A worker crash after committing the receipt but before completing the job
      // must not replay the external bonus write or roll back a fresher balance.
      await db.user.update({ where: { id: user.id }, data: { bonusBalance: 20, bonusUpdatedAt: new Date("2026-09-04T10:02:00Z") } });
      await db.syncJob.update({ where: { id: job.id }, data: { status: "FAILED" } });
      await retrySyncJob(job.id);
      await processNextJob(bonusAdapter);
      assert.equal(calls, 1);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).bonusBalance, 20);
    });
  } finally {
    // The validated random schema belongs only to this test, never to the app or another test.
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
