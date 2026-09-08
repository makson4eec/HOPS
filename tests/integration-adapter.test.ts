import assert from "node:assert/strict";
import test from "node:test";
import { createAdapter, EmptyTestAdapter } from "../lib/integration/adapter";
import { catalogPageSchema, exportReceiptSchema, statusPageSchema, type OneCAdapter } from "../lib/integration/contracts";
import { IntegrationError, isNewer, MAX_ATTEMPTS, publicFailure, retryDelayMs, shouldRetry } from "../lib/integration/errors";
import { incomingStatusPath } from "../lib/integration/statuses";

const empty = { cursor: null, hasMore: false, products: [], warehouses: [], prices: [], stock: [], arrivals: [] };

test("test adapter has no merchandise and does not advance a live cursor", async () => {
  const adapter: OneCAdapter = new EmptyTestAdapter();
  const signal = new AbortController().signal;
  assert.deepEqual(catalogPageSchema.parse(await adapter.fetchCatalog(null, signal)), empty);
  assert.deepEqual(catalogPageSchema.parse(await adapter.fetchCatalog("existing", signal)), { ...empty, cursor: "existing" });
  assert.deepEqual(statusPageSchema.parse(await adapter.fetchOrderStatuses(null, signal)), { cursor: null, hasMore: false, orders: [] });
  assert.deepEqual(await adapter.findClient({ email: "test@example.org", phone: null }, signal), { client: null });
});

test("test mode refuses external writes and live mode requires a real contract", async () => {
  const adapter = new EmptyTestAdapter();
  // Runtime write prohibition does not depend on whether callers constructed a valid payload.
  await assert.rejects(adapter.exportOrder({} as never), (error: unknown) => error instanceof IntegrationError && error.code === "TEST_MODE_EXPORT_DISABLED");
  await assert.rejects(adapter.operateBonus({} as never), (error: unknown) => error instanceof IntegrationError && error.code === "TEST_MODE_BONUS_DISABLED");
  assert.throws(() => createAdapter("live"), (error: unknown) => error instanceof IntegrationError && error.code === "LIVE_ADAPTER_NOT_CONFIGURED");
  assert.throws(() => createAdapter("typo"), (error: unknown) => error instanceof IntegrationError && error.code === "INVALID_ONE_C_MODE");
  assert.equal(exportReceiptSchema.safeParse({ externalId: "actual-id", accepted: false }).success, false);
});

test("feed validation rejects malformed money, negative stock and duplicate external IDs", () => {
  const updatedAt = "2026-09-04T00:00:00Z";
  const price = { productExternalId: "p-1", amount: 12500, currency: "RUB", updatedAt };
  assert.equal(catalogPageSchema.safeParse({ ...empty, prices: [price, price] }).success, false);
  assert.equal(catalogPageSchema.safeParse({ ...empty, prices: [{ ...price, amount: 12.5 }] }).success, false);
  assert.equal(catalogPageSchema.safeParse({ ...empty, prices: [{ ...price, currency: "USD" }] }).success, false);
  assert.equal(catalogPageSchema.safeParse({ ...empty, stock: [{ productExternalId: "p", warehouseExternalId: "w", quantity: -1, updatedAt }] }).success, false);
  assert.equal(catalogPageSchema.safeParse({ ...empty, prices: [{ ...price, updatedAt: "yesterday" }] }).success, false);
  assert.equal(catalogPageSchema.safeParse({ ...empty, hasMore: true }).success, false);
  assert.equal(catalogPageSchema.safeParse({ ...empty, unexpected: "data" }).success, false);
});

test("timestamps ignore duplicate/stale events and accept a newer revision", () => {
  const current = new Date("2026-09-04T10:00:00Z");
  assert.equal(isNewer("2026-09-04T10:00:00Z", current), false);
  assert.equal(isNewer("2026-09-04T09:59:59Z", current), false);
  assert.equal(isNewer("2026-09-04T10:00:01Z", current), true);
  assert.equal(isNewer("2026-09-04T10:00:00Z", null), true);
});

test("bounded retries increase delay and permanent failures stop immediately", () => {
  assert.equal(retryDelayMs(1), 15_000);
  assert.equal(retryDelayMs(2), 30_000);
  assert.equal(retryDelayMs(3), 60_000);
  assert.equal(retryDelayMs(100), 900_000);
  assert.equal(shouldRetry(MAX_ATTEMPTS - 1, true), true);
  assert.equal(shouldRetry(MAX_ATTEMPTS, true), false);
  assert.equal(shouldRetry(1, false), false);
});

test("polled statuses can advance across missed stages without regressing terminal orders", () => {
  assert.deepEqual(incomingStatusPath("NEW", "READY"), ["CONFIRMED", "PREPARING", "READY"]);
  assert.deepEqual(incomingStatusPath("READY", "COMPLETED"), ["COMPLETED"]);
  assert.deepEqual(incomingStatusPath("CONFIRMED", "CANCELLED"), ["CANCELLED"]);
  assert.deepEqual(incomingStatusPath("COMPLETED", "COMPLETED"), []);
  assert.throws(() => incomingStatusPath("COMPLETED", "CANCELLED"));
  assert.throws(() => incomingStatusPath("CANCELLED", "READY"));
  assert.throws(() => incomingStatusPath("READY", "NEW"));
});

test("logs never copy raw errors, private payloads, tokens or validation inputs", () => {
  const sensitive = "postgres://admin:secret@db/private customer@example.org";
  assert.deepEqual(publicFailure(new Error(sensitive)), { code: "EXCHANGE_FAILED", retryable: true });
  assert.deepEqual(publicFailure(new IntegrationError(sensitive)), { code: "INTEGRATION_ERROR", retryable: false });
  assert.deepEqual(publicFailure({ code: "P2034", message: sensitive }), { code: "CONCURRENT_UPDATE", retryable: true });
  assert.deepEqual(publicFailure({ code: "P2010", meta: { code: "40001", message: sensitive } }), { code: "CONCURRENT_UPDATE", retryable: true });
  const invalid = catalogPageSchema.safeParse({ secret: sensitive });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.deepEqual(publicFailure(invalid.error), { code: "INVALID_ADAPTER_DATA", retryable: false });
});
