import { randomUUID } from "node:crypto";
import { Prisma, type SyncJob } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { transitionOrder } from "../orders";
import { createAdapter } from "./adapter";
import {
  bonusReceiptSchema, bonusRequestSchema, catalogPageSchema, clientQuerySchema, clientResultSchema,
  exportOrderSchema, exportReceiptSchema, orderStatusSchema, statusPageSchema,
  type CatalogPage, type ClientQuery, type OneCAdapter, type StatusPage,
} from "./contracts";
import { IntegrationError, isNewer, LEASE_MS, MAX_ATTEMPTS, publicFailure, requestWithTimeout, retryDelayMs, shouldRetry } from "./errors";
import { incomingStatusPath } from "./statuses";

const txOptions = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000, maxWait: 10_000 };
const idSchema = z.string().min(1).max(200);
const orderPayload = z.object({ orderId: idSchema, snapshot: exportOrderSchema.optional() }).strict();
const userPayload = z.object({ userId: idSchema, query: clientQuerySchema }).strict();
const bonusPayload = z.object({ operationId: idSchema }).strict();

async function queueFeed(kind: "CATALOG_IMPORT" | "ORDER_STATUS_IMPORT", actorId?: string): Promise<SyncJob> {
  return db.$transaction(async (tx) => {
    // Serialize manual scheduling so double clicks reuse one active job.
    await tx.$queryRaw`SELECT true AS "locked" FROM pg_advisory_xact_lock(hashtext(${`hops:${kind}`}))`;
    const active = await tx.syncJob.findFirst({ where: { kind, status: { in: ["PENDING", "RUNNING"] } }, orderBy: { createdAt: "desc" } });
    if (active) return active;
    const job = await tx.syncJob.create({ data: { kind, dedupeKey: `${kind}:${randomUUID()}`, payload: {} } });
    await tx.syncLog.create({ data: { jobId: job.id, level: "INFO", message: "QUEUED" } });
    if (actorId) await tx.auditLog.create({ data: { actorId, action: `SYNC_${kind}`, targetId: job.id } });
    return job;
  });
}

export function queueCatalogSync(actorId?: string): Promise<SyncJob> { return queueFeed("CATALOG_IMPORT", actorId); }
export function queueOrderStatusSync(actorId?: string): Promise<SyncJob> { return queueFeed("ORDER_STATUS_IMPORT", actorId); }

export async function queueClientLookup(userId: string, expectedQuery?: ClientQuery): Promise<SyncJob> {
  idSchema.parse(userId);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, phone: true } });
  const query = clientQuerySchema.parse(user);
  if (expectedQuery && (expectedQuery.email !== query.email || expectedQuery.phone !== query.phone)) throw new IntegrationError("CLIENT_CONTACTS_CHANGED");
  return db.syncJob.create({ data: { kind: "CLIENT_LOOKUP", dedupeKey: `client:${userId}:${randomUUID()}`, payload: { userId, query } } });
}

export async function queueBonusOperation(operationId: string): Promise<SyncJob> {
  idSchema.parse(operationId);
  const operation = await db.bonusOperation.findUniqueOrThrow({ where: { id: operationId } });
  return db.syncJob.upsert({ where: { dedupeKey: `bonus:${operation.idempotencyKey}` }, create: {
    kind: "BONUS_OPERATION", dedupeKey: `bonus:${operation.idempotencyKey}`, payload: { operationId },
  }, update: {} });
}

export async function retrySyncJob(jobId: string): Promise<void> {
  idSchema.parse(jobId);
  await db.$transaction(async (tx) => {
    const changed = await tx.syncJob.updateMany({ where: { id: jobId, status: "FAILED" }, data: {
      status: "PENDING", attempts: 0, nextRunAt: new Date(), lockedAt: null, lockToken: null, error: null,
    } });
    if (!changed.count) throw new IntegrationError("JOB_NOT_RETRYABLE");
    await tx.syncLog.create({ data: { jobId, level: "INFO", message: "MANUAL_RETRY_QUEUED" } });
  });
}

async function claimJob(): Promise<SyncJob | null> {
  const now = new Date();
  const expired = new Date(now.getTime() - LEASE_MS);
  // DateTime columns use timestamptz; explicit ISO-Z binds keep lease comparisons
  // independent of the PostgreSQL session or VPS local timezone.
  const nowSql = now.toISOString();
  const expiredSql = expired.toISOString();
  return db.$transaction(async (tx) => {
    const abandoned = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "SyncJob" SET "status" = 'FAILED', "error" = 'LEASE_EXPIRED_MAX_ATTEMPTS',
        "lockedAt" = NULL, "lockToken" = NULL, "updatedAt" = ${nowSql}::timestamptz
      WHERE "status" = 'RUNNING' AND "attempts" >= ${MAX_ATTEMPTS}
        AND ("lockedAt" IS NULL OR "lockedAt" <= ${expiredSql}::timestamptz) RETURNING "id"`;
    if (abandoned.length) await tx.syncLog.createMany({ data: abandoned.map((job) => ({ jobId: job.id, level: "ERROR", message: "LEASE_EXPIRED_MAX_ATTEMPTS" })) });
    const token = randomUUID();
    const jobs = await tx.$queryRaw<SyncJob[]>`
      UPDATE "SyncJob" SET "status" = 'RUNNING', "attempts" = "attempts" + 1,
        "lockedAt" = ${nowSql}::timestamptz, "lockToken" = ${token}, "updatedAt" = ${nowSql}::timestamptz, "error" = NULL
      WHERE "id" = (
        SELECT "id" FROM "SyncJob"
        WHERE "attempts" < ${MAX_ATTEMPTS} AND (
          ("status" = 'PENDING' AND "nextRunAt" <= ${nowSql}::timestamptz) OR
          ("status" = 'RUNNING' AND ("lockedAt" IS NULL OR "lockedAt" <= ${expiredSql}::timestamptz))
        ) ORDER BY "nextRunAt", "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING *`;
    const job = jobs[0];
    if (!job) return null;
    if (job.kind === "ORDER_EXPORT") {
      const payload = orderPayload.safeParse(job.payload);
      if (payload.success) {
        // The separate advisory-lock statement makes the following READ COMMITTED
        // check see another claimant's commit, even when both initially chose rows.
        await tx.$queryRaw`SELECT true AS "locked" FROM pg_advisory_xact_lock(hashtext(${`hops:order:${payload.data.orderId}`}))`;
        const other = await tx.syncJob.findFirst({ where: {
          id: { not: job.id }, kind: "ORDER_EXPORT", status: "RUNNING", lockedAt: { gt: expired },
          payload: { path: ["orderId"], equals: payload.data.orderId },
        }, select: { id: true } });
        if (other) {
          await tx.syncJob.update({ where: { id: job.id }, data: {
            status: "PENDING", attempts: { decrement: 1 }, lockToken: null, lockedAt: null,
            nextRunAt: new Date(now.getTime() + 3000),
          } });
          return null;
        }
      }
    }
    await tx.syncLog.create({ data: { jobId: job.id, level: "INFO", message: "STARTED" } });
    return job;
  });
}

async function requireLease(tx: Prisma.TransactionClient, job: SyncJob): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "SyncJob" WHERE "id" = ${job.id} AND "lockToken" = ${job.lockToken}
      AND "status" = 'RUNNING' FOR UPDATE`;
  if (!rows.length) throw new IntegrationError("LEASE_LOST", true);
  await tx.syncJob.update({ where: { id: job.id }, data: { lockedAt: new Date() } });
}

async function advanceCursor(tx: Prisma.TransactionClient, key: string, cursor: string | null): Promise<void> {
  await tx.syncCursor.upsert({ where: { id: key }, create: { id: key, cursor }, update: { cursor } });
}

async function applyCatalog(tx: Prisma.TransactionClient, page: CatalogPage): Promise<void> {
  for (const entry of page.warehouses) {
    const existing = await tx.warehouse.findUnique({ where: { externalId: entry.externalId } });
    if (existing && !isNewer(entry.updatedAt, existing.sourceUpdatedAt)) continue;
    const { updatedAt, ...data } = entry;
    await tx.warehouse.upsert({ where: { externalId: entry.externalId }, create: { ...data, sourceUpdatedAt: new Date(updatedAt) }, update: { ...data, sourceUpdatedAt: new Date(updatedAt) } });
  }
  for (const entry of page.products) {
    const existing = await tx.product.findUnique({ where: { externalId: entry.externalId } });
    if (existing && !isNewer(entry.updatedAt, existing.sourceUpdatedAt)) continue;
    const { updatedAt, ...data } = entry;
    await tx.product.upsert({ where: { externalId: entry.externalId }, create: { ...data, sourceUpdatedAt: new Date(updatedAt) }, update: { ...data, sourceUpdatedAt: new Date(updatedAt) } });
  }
  for (const entry of page.prices) {
    const product = await tx.product.findUnique({ where: { externalId: entry.productExternalId } });
    if (!product) throw new IntegrationError("PRICE_PRODUCT_NOT_FOUND");
    if (isNewer(entry.updatedAt, product.priceUpdatedAt)) await tx.product.update({ where: { id: product.id }, data: { price: entry.amount, priceUpdatedAt: new Date(entry.updatedAt) } });
  }
  for (const entry of page.stock) {
    const product = await tx.product.findUnique({ where: { externalId: entry.productExternalId }, select: { id: true } });
    const warehouse = await tx.warehouse.findUnique({ where: { externalId: entry.warehouseExternalId }, select: { id: true } });
    if (!product || !warehouse) throw new IntegrationError("STOCK_REFERENCE_NOT_FOUND");
    const key = { productId: product.id, warehouseId: warehouse.id };
    const existing = await tx.inventory.findUnique({ where: { productId_warehouseId: key } });
    if (existing && !isNewer(entry.updatedAt, existing.sourceUpdatedAt)) continue;
    if (existing && entry.quantity < existing.reserved) throw new IntegrationError("STOCK_BELOW_RESERVED");
    const data = { quantity: entry.quantity, sourceUpdatedAt: new Date(entry.updatedAt) };
    await tx.inventory.upsert({ where: { productId_warehouseId: key }, create: { ...key, ...data }, update: data });
  }
  for (const entry of page.arrivals) {
    const existing = await tx.arrival.findUnique({ where: { externalId: entry.externalId } });
    if (existing && !isNewer(entry.updatedAt, existing.sourceUpdatedAt)) continue;
    const product = await tx.product.findUnique({ where: { externalId: entry.productExternalId }, select: { id: true } });
    const warehouse = await tx.warehouse.findUnique({ where: { externalId: entry.warehouseExternalId }, select: { id: true } });
    if (!product || !warehouse) throw new IntegrationError("ARRIVAL_REFERENCE_NOT_FOUND");
    if (existing && (existing.productId !== product.id || existing.warehouseId !== warehouse.id)) throw new IntegrationError("ARRIVAL_IDENTITY_CHANGED");
    const data = { productId: product.id, warehouseId: warehouse.id, quantity: entry.quantity, received: entry.received, expectedAt: new Date(entry.expectedAt), sourceUpdatedAt: new Date(entry.updatedAt) };
    await tx.arrival.upsert({ where: { externalId: entry.externalId }, create: { externalId: entry.externalId, ...data }, update: data });
  }
}

async function applyStatuses(tx: Prisma.TransactionClient, page: StatusPage): Promise<void> {
  for (const entry of page.orders) {
    const order = await tx.order.findUnique({ where: { externalId: entry.externalId } });
    if (!order) throw new IntegrationError("STATUS_ORDER_NOT_FOUND");
    if (!isNewer(entry.updatedAt, order.sourceUpdatedAt)) continue;
    if (order.status !== "COMPLETED" && entry.status === "COMPLETED") {
      // A stock snapshot at/after fulfillment may already include its physical deduction.
      // Until the real 1C causal ordering contract exists, stop rather than deduct twice.
      const overlappingStock = await tx.inventory.count({ where: {
        warehouseId: order.warehouseId, product: { orderItems: { some: { orderId: order.id } } },
        sourceUpdatedAt: { gte: new Date(entry.updatedAt) },
      } });
      if (overlappingStock) throw new IntegrationError("COMPLETION_STOCK_RECONCILIATION_REQUIRED");
    }
    for (const next of incomingStatusPath(order.status, entry.status)) await transitionOrder(tx, order.id, next);
    await tx.order.update({ where: { id: order.id }, data: { sourceUpdatedAt: new Date(entry.updatedAt) } });
  }
}

async function importFeed(job: SyncJob, adapter: OneCAdapter, kind: "catalog" | "statuses"): Promise<Prisma.InputJsonObject> {
  z.object({}).strict().parse(job.payload);
  const cursorKey = `1c:${adapter.mode}:${kind}`;
  let cursor = (await db.syncCursor.findUnique({ where: { id: cursorKey } }))?.cursor ?? null;
  let records = 0;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    // Renewal occurs before each bounded transport call and inside its import transaction.
    const renewed = await db.syncJob.updateMany({ where: { id: job.id, lockToken: job.lockToken, status: "RUNNING" }, data: { lockedAt: new Date() } });
    if (!renewed.count) throw new IntegrationError("LEASE_LOST", true);
    if (kind === "catalog") {
      const page = catalogPageSchema.parse(await requestWithTimeout((signal) => adapter.fetchCatalog(cursor, signal)));
      if (page.hasMore && page.cursor === cursor) throw new IntegrationError("CURSOR_NOT_ADVANCING");
      await db.$transaction(async (tx) => {
        await requireLease(tx, job);
        await applyCatalog(tx, page);
        await advanceCursor(tx, cursorKey, page.cursor);
      }, txOptions);
      records += page.products.length + page.warehouses.length + page.prices.length + page.stock.length + page.arrivals.length;
      cursor = page.cursor;
      if (!page.hasMore) return { mode: adapter.mode, records, pages: pageNumber + 1 };
    } else {
      const page = statusPageSchema.parse(await requestWithTimeout((signal) => adapter.fetchOrderStatuses(cursor, signal)));
      if (page.hasMore && page.cursor === cursor) throw new IntegrationError("CURSOR_NOT_ADVANCING");
      await db.$transaction(async (tx) => {
        await requireLease(tx, job);
        await applyStatuses(tx, page);
        await advanceCursor(tx, cursorKey, page.cursor);
      }, txOptions);
      records += page.orders.length;
      cursor = page.cursor;
      if (!page.hasMore) return { mode: adapter.mode, records, pages: pageNumber + 1 };
    }
  }
  throw new IntegrationError("PAGE_LIMIT_REACHED", true);
}

async function exportOrder(job: SyncJob, adapter: OneCAdapter): Promise<Prisma.InputJsonObject> {
  const payload = orderPayload.parse(job.payload);
  const order = await db.order.findUniqueOrThrow({ where: { id: payload.orderId }, include: { items: { include: { product: true } }, warehouse: true, user: true } });
  let snapshot = payload.snapshot;
  if (snapshot && snapshot.status !== order.status) {
    await db.$transaction(async (tx) => {
      await requireLease(tx, job);
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      const dedupeKey = `order:${current.id}:${current.status}`;
      await tx.syncJob.upsert({ where: { dedupeKey }, create: { kind: "ORDER_EXPORT", dedupeKey, payload: { orderId: current.id } }, update: {} });
    }, txOptions);
    return { mode: adapter.mode, superseded: true, reason: "CURRENT_STATUS_CHANGED" };
  }
  if (!snapshot) {
    if (!order.warehouse.externalId || order.items.some((item) => !item.product.externalId)) throw new IntegrationError("ORDER_EXTERNAL_REFERENCES_MISSING");
    snapshot = exportOrderSchema.parse({
      idempotencyKey: job.dedupeKey, localId: order.id, externalId: order.externalId, number: order.number,
      customer: { externalId: order.user.externalId, name: order.name, email: order.user.email, phone: order.phone },
      warehouseExternalId: order.warehouse.externalId, pickupAt: order.pickupAt.toISOString(), comment: order.comment,
      status: order.status, total: order.total, currency: "RUB", updatedAt: order.updatedAt.toISOString(),
      items: order.items.map((item) => ({ productExternalId: item.product.externalId, sku: item.sku, name: item.name, price: item.price, quantity: item.quantity })),
    });
    const persisted = await db.syncJob.updateMany({ where: { id: job.id, lockToken: job.lockToken, status: "RUNNING" }, data: { payload: { orderId: payload.orderId, snapshot } } });
    if (!persisted.count) throw new IntegrationError("LEASE_LOST", true);
  }
  const completed = await db.syncJob.findMany({ where: {
    kind: "ORDER_EXPORT", status: "SUCCESS", payload: { path: ["orderId"], equals: order.id },
  }, select: { result: true } });
  const confirmedSchema = z.object({ exported: z.literal(true), version: z.iso.datetime({ offset: true }), status: orderStatusSchema });
  if (completed.some((previous) => {
    const confirmed = confirmedSchema.safeParse(previous.result);
    return confirmed.success && confirmed.data.status === snapshot!.status && new Date(confirmed.data.version) >= new Date(snapshot!.updatedAt);
  })) return { mode: adapter.mode, superseded: true, reason: "REVISION_ALREADY_CONFIRMED" };
  const receipt = exportReceiptSchema.parse(await requestWithTimeout((signal) => adapter.exportOrder(snapshot!, signal)));
  await db.$transaction(async (tx) => {
    await requireLease(tx, job);
    const order = await tx.order.findUniqueOrThrow({ where: { id: payload.orderId } });
    if (order.externalId && order.externalId !== receipt.externalId) throw new IntegrationError("ORDER_EXTERNAL_ID_CHANGED");
    await tx.order.update({ where: { id: order.id }, data: { externalId: receipt.externalId } });
  }, txOptions);
  return { mode: adapter.mode, exported: true, version: snapshot.updatedAt, status: snapshot.status };
}

async function lookupClient(job: SyncJob, adapter: OneCAdapter): Promise<Prisma.InputJsonObject> {
  const payload = userPayload.parse(job.payload);
  const user = await db.user.findUniqueOrThrow({ where: { id: payload.userId } });
  const query = payload.query;
  if (user.email !== query.email || user.phone !== query.phone) throw new IntegrationError("CLIENT_CONTACTS_CHANGED");
  const result = clientResultSchema.parse(await requestWithTimeout((signal) => adapter.findClient(query, signal)));
  if (result.client) {
    const client = result.client;
    await db.$transaction(async (tx) => {
      await requireLease(tx, job);
      const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (current.email !== query.email || current.phone !== query.phone) throw new IntegrationError("CLIENT_CONTACTS_CHANGED");
      if (current.externalId && current.externalId !== client.externalId) throw new IntegrationError("CLIENT_EXTERNAL_ID_CHANGED");
      await tx.user.update({ where: { id: user.id }, data: {
        externalId: client.externalId,
        ...(isNewer(client.updatedAt, current.bonusUpdatedAt) ? { bonusBalance: client.bonusBalance, bonusUpdatedAt: new Date(client.updatedAt) } : {}),
      } });
    }, txOptions);
  }
  return { mode: adapter.mode, matched: Boolean(result.client) };
}

async function applyBonus(job: SyncJob, adapter: OneCAdapter): Promise<Prisma.InputJsonObject> {
  const { operationId } = bonusPayload.parse(job.payload);
  const operation = await db.bonusOperation.findUniqueOrThrow({ where: { id: operationId }, include: { user: true } });
  if (operation.status === "SUCCESS") return { mode: adapter.mode, alreadyApplied: true };
  if (!operation.user.externalId) throw new IntegrationError("BONUS_CLIENT_NOT_LINKED");
  const request = bonusRequestSchema.parse({ idempotencyKey: operation.idempotencyKey, clientExternalId: operation.user.externalId, kind: operation.kind, amount: operation.amount, description: operation.description });
  const receipt = bonusReceiptSchema.parse(await requestWithTimeout((signal) => adapter.operateBonus(request, signal)));
  await db.$transaction(async (tx) => {
    await requireLease(tx, job);
    const current = await tx.bonusOperation.findUniqueOrThrow({ where: { id: operation.id } });
    if (current.status === "SUCCESS") return;
    if (current.externalId && current.externalId !== receipt.externalId) throw new IntegrationError("BONUS_EXTERNAL_ID_CHANGED");
    await tx.bonusOperation.update({ where: { id: operation.id }, data: { externalId: receipt.externalId, status: "SUCCESS" } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: operation.userId } });
    if (isNewer(receipt.updatedAt, user.bonusUpdatedAt)) await tx.user.update({ where: { id: user.id }, data: { bonusBalance: receipt.balance, bonusUpdatedAt: new Date(receipt.updatedAt) } });
  }, txOptions);
  return { mode: adapter.mode, applied: true };
}

/** The worker owns execution; HTTP/admin actions only add jobs to the durable queue. */
export async function processNextJob(adapterOverride?: OneCAdapter): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  try {
    const adapter = adapterOverride ?? createAdapter();
    let result: Prisma.InputJsonObject;
    switch (job.kind) {
      case "CATALOG_IMPORT": result = await importFeed(job, adapter, "catalog"); break;
      case "ORDER_STATUS_IMPORT": result = await importFeed(job, adapter, "statuses"); break;
      case "ORDER_EXPORT": result = await exportOrder(job, adapter); break;
      case "CLIENT_LOOKUP": result = await lookupClient(job, adapter); break;
      case "BONUS_OPERATION": result = await applyBonus(job, adapter); break;
      default: throw new IntegrationError("UNKNOWN_JOB_KIND");
    }
    await db.$transaction(async (tx) => {
      const changed = await tx.syncJob.updateMany({ where: { id: job.id, lockToken: job.lockToken, status: "RUNNING" }, data: { status: "SUCCESS", result, error: null, lockedAt: null, lockToken: null } });
      if (changed.count) await tx.syncLog.create({ data: { jobId: job.id, level: "INFO", message: result.mode === "test" ? "TEST_COMPLETED_NO_EXTERNAL_WRITES" : "COMPLETED" } });
    });
  } catch (error) {
    const failure = publicFailure(error);
    const retry = shouldRetry(job.attempts, failure.retryable);
    await db.$transaction(async (tx) => {
      const changed = await tx.syncJob.updateMany({ where: { id: job.id, lockToken: job.lockToken, status: "RUNNING" }, data: {
        status: retry ? "PENDING" : "FAILED", error: failure.code, lockedAt: null, lockToken: null,
        nextRunAt: new Date(Date.now() + retryDelayMs(job.attempts)),
      } });
      if (changed.count) {
        await tx.syncLog.create({ data: { jobId: job.id, level: "ERROR", message: failure.code } });
        if (job.kind === "BONUS_OPERATION") {
          const payload = bonusPayload.safeParse(job.payload);
          if (payload.success) await tx.bonusOperation.updateMany({ where: { id: payload.data.operationId, status: { not: "SUCCESS" } }, data: { status: retry ? "PENDING" : "FAILED" } });
        }
      }
    });
  }
  return true;
}
