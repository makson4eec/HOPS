import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { rowSchemas, validateState, type State } from "./models";

export function privatePath(value: string) {
  const dir = path.resolve(/*turbopackIgnore: true*/ value);
  for (const root of [path.resolve("public"), path.resolve(".next")]) {
    const rel = path.relative(root, dir);
    if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("Private files must be outside public and .next");
  }
  return dir;
}
export function dataDir() {
  const dir = privatePath(process.env.HOPS_DATA_DIR || "C:\\HOPS\\data");
  const rel = path.relative(dir, process.cwd());
  if (dir === path.parse(dir).root || !rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error("Use a dedicated private data folder");
  return dir;
}
export const digest = (data: string) => createHash("sha256").update(data).digest("hex");
export async function atomicWrite(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (error) { if (attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) throw error; await delay(50 * (attempt + 1)); }
    }
  } finally { await fs.rm(temp, { force: true }); }
}
export async function logError(scope: string, error: unknown) {
  const dir = path.join(/*turbopackIgnore: true*/ dataDir(), "logs");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${scope} ${JSON.stringify(error instanceof z.ZodError ? error.issues.map(issue => ({ code: issue.code, path: issue.path })) : { name: error instanceof Error ? error.name : "Error", code: (error as NodeJS.ErrnoException)?.code, reason: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : undefined })}\n`, { mode: 0o600 });
}
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const root = dataDir(); await fs.mkdir(root, { recursive: true });
  const release = await lockfile.lock(root, {
    realpath: true, lockfilePath: path.join(root, ".write-lock"),
    stale: 60_000, update: 10_000,
    retries: { retries: 350, factor: 1, minTimeout: 200, maxTimeout: 200, randomize: true },
  });
  try { return await fn(); } finally { await release(); }
}
function emptyState(): State {
  const now = new Date();
  const state = { version: 1, revision: 0, tables: Object.fromEntries(Object.keys(rowSchemas).map(key => [key, []])), sync: { catalog: {}, loyalty: {} }, catalog: null, loyalty: null } as unknown as State;
  state.tables.shopSettings.push({ id: "main", createdAt: now, updatedAt: now, address: "г. Екатеринбург, ул. Библиотечная, 43", shortAddress: "г. Екатеринбург, ул. Библиотечная, 43", phone: "", email: "", hoursWeek: "Пн–Пт: 11:00–00:00", hoursWeekend: "Сб–Вс: 11:00–00:00", announcement: "Самовывоз из магазина", pickupOpen: 11, pickupClose: 24, timezone: "Asia/Yekaterinburg", loyaltyRules: "", loyaltyRulesConfirmed: false });
  state.tables.warehouse.push({ id: "hops-store", createdAt: now, updatedAt: now, externalId: null, name: "HOPS", address: state.tables.shopSettings[0].address, pickupEnabled: true });
  return state;
}
export function encodeState(state: State) { const payload = JSON.stringify(validateState(state)); return { checksum: digest(payload), payload }; }
export function decodeState(value: unknown) {
  const envelope = value as { checksum?: string; payload?: string };
  if (typeof envelope?.payload !== "string" || digest(envelope.payload) !== envelope.checksum) throw new Error("Storage checksum mismatch");
  return validateState(JSON.parse(envelope.payload));
}
async function readEnvelope(name: string) { return decodeState(JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dataDir(), name), "utf8"))); }
async function materialize(state: State) {
  for (const order of state.tables.order) {
    const snapshot = { ...order, items: state.tables.orderItem.filter(item => item.orderId === order.id).map(item => ({ ...item, externalId: state.tables.product.find(product => product.id === item.productId)?.externalId })), exchangeStatus: order.confirmedInOneCAt ? "CONFIRMED_BY_STAFF_IN_1C" : "AWAITING_1C_CONFIRMATION" };
    for (const folder of ["orders", "outgoing/orders"]) {
      const file = path.join(/*turbopackIgnore: true*/ dataDir(), folder, `${order.id}.json`);
      const content = JSON.stringify(snapshot);
      let existing = ""; try { existing = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8"); } catch { /* first write */ }
      if (existing !== content) await atomicWrite(file, snapshot);
    }
  }
  for (const kind of ["catalog", "loyalty"] as const) {
    if (!state[kind]) continue;
    const file = path.join(/*turbopackIgnore: true*/ dataDir(), "accepted", `${kind}.json`);
    const content = JSON.stringify(state[kind]);
    let old = ""; try { old = await fs.readFile(/*turbopackIgnore: true*/ file, "utf8"); } catch { /* first import */ }
    if (old !== content) await atomicWrite(file, state[kind]);
  }
}
// Durable intent replays before any read, committing reservations and outbox together.
export async function loadState(): Promise<State> {
  let pending: State | undefined;
  try { pending = await readEnvelope("pending.json"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (pending) { await persistState(pending, false); return pending; }
  try { return await readEnvelope("state.json"); }
  catch (error) {
    try { const backup = await readEnvelope("state.backup.json"); await persistState(backup, false); await logError("state-recovered", error); return backup; }
    catch (backupError) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && (backupError as NodeJS.ErrnoException).code === "ENOENT") {
        try { await fs.access(path.join(dataDir(), "initialized.json")); }
        catch (markerError) { if ((markerError as NodeJS.ErrnoException).code === "ENOENT") return emptyState(); throw markerError; }
      }
      await logError("state-unrecoverable", error); throw new Error("Storage damaged; restore a verified backup");
    }
  }
}
export async function persistState(state: State, intent = true) {
  const envelope = encodeState(state);
  if (intent) await atomicWrite(path.join(/*turbopackIgnore: true*/ dataDir(), "pending.json"), envelope);
  await atomicWrite(path.join(dataDir(), "initialized.json"), { version: 1 });
  await atomicWrite(path.join(/*turbopackIgnore: true*/ dataDir(), "state.json"), envelope);
  await atomicWrite(path.join(/*turbopackIgnore: true*/ dataDir(), "state.backup.json"), envelope);
  await materialize(state);
  await fs.rm(path.join(/*turbopackIgnore: true*/ dataDir(), "pending.json"), { force: true });
}
export async function readState() { return withLock(loadState); }
export async function mutateState<T>(fn: (state: State) => Promise<T> | T) {
  return withLock(async () => {
    try {
      const state = await loadState();
      const now = Date.now();
      state.tables.session = state.tables.session.filter(row => row.expiresAt.getTime() > now);
      state.tables.rateLimit = state.tables.rateLimit.filter(row => row.expiresAt.getTime() > now);
      state.tables.cart = state.tables.cart.filter(row => row.expiresAt.getTime() > now);
      const carts = new Set(state.tables.cart.map(row => row.id));
      state.tables.cartItem = state.tables.cartItem.filter(row => carts.has(row.cartId));
      const result = await fn(state);
      state.revision++;
      await persistState(state);
      return result;
    } catch (error) { await logError("transaction-failed", error); throw error; }
  });
}
