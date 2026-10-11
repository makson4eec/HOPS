import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, dataDir, privatePath, decodeState, encodeState, loadState, persistState, withLock } from "./storage";

export async function backup(destination?: string) {
  return withLock(async () => {
    const state = await loadState();
    const folder = destination ? privatePath(destination) : path.join(/*turbopackIgnore: true*/ dataDir(), "backups");
    const file = path.resolve(folder, `hops-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await atomicWrite(file, encodeState(state));
    decodeState(JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ file, "utf8")));
    return file;
  });
}
export async function restore(file: string) {
  try {
    const owner = JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ path.join(dataDir(), "runtime/supervisor.json"), "utf8")) as { pid: number };
    try { process.kill(owner.pid, 0); throw new Error("Stop HOPS before restoring"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const source = path.resolve(file);
  const state = decodeState(JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ source, "utf8")));
  return withLock(async () => {
    let current;
    try { current = await loadState(); }
    catch {
      for (const name of ["state.json", "state.backup.json", "pending.json"]) {
        try { await fs.copyFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dataDir(), name), path.join(/*turbopackIgnore: true*/ dataDir(), `damaged-${Date.now()}-${name}`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      current = state;
    }
    await atomicWrite(path.join(/*turbopackIgnore: true*/ dataDir(), "backups", `before-restore-${Date.now()}.json`), encodeState(current));
    state.tables.session = [];
    state.revision = Math.max(state.revision, current.revision) + 1;
    await atomicWrite(path.join(dataDir(), "pending.json"), encodeState(state));
    // Keep abandoned outbox files out of the active exchange after rollback.
    for (const folder of ["orders", "outgoing/orders", "accepted"]) {
      const target = path.join(/*turbopackIgnore: true*/ dataDir(), folder);
      try { await fs.rename(target, path.join(/*turbopackIgnore: true*/ dataDir(), `restore-previous-${folder.replaceAll("/", "-")}-${Date.now()}`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await persistState(state);
  });
}

let backedUpDay = "";
export async function dailyBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (backedUpDay === today) return;
  const folder = path.join(/*turbopackIgnore: true*/ dataDir(), "backups");
  await fs.mkdir(folder, { recursive: true });
  const names = await fs.readdir(/*turbopackIgnore: true*/ folder);
  const existing = names.find(name => name.startsWith(`hops-${today}`) && name.endsWith(".json"));
  const local = existing ? path.join(folder, existing) : await backup();
  decodeState(JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ local, "utf8")));
  if (process.env.HOPS_BACKUP_DIR) {
    const copy = path.join(privatePath(process.env.HOPS_BACKUP_DIR), path.basename(local));
    await atomicWrite(copy, JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ local, "utf8")));
    decodeState(JSON.parse(await fs.readFile(/*turbopackIgnore: true*/ copy, "utf8")));
  }
  const retention = Math.max(7, Number(process.env.HOPS_BACKUP_RETENTION_DAYS) || 30) * 86400_000;
  for (const name of names) if (/^hops-[\dTZ.-]+\.json$/.test(name)) {
    const file = path.join(folder, name);
    if (Date.now() - (await fs.stat(/*turbopackIgnore: true*/ file)).mtimeMs > retention) await fs.unlink(file);
  }
  backedUpDay = today;
}
