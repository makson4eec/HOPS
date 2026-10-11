import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const data = path.resolve(process.env.HOPS_DATA_DIR || "C:\\HOPS\\data");
const runtime = path.join(data, "runtime"), stopFile = path.join(runtime, "stop");
await fs.mkdir(runtime, { recursive: true });
await fs.mkdir(path.join(data, "logs"), { recursive: true });
const port = Number(process.env.PORT || 3000);
const lock = path.join(runtime, "supervisor.json");
const execute = promisify(execFile);
async function processCreation(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform !== "win32") return undefined;
  const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 10000 });
  return result.stdout.trim();
}
const creation = await processCreation(process.pid);
try {
  const owner = JSON.parse(await fs.readFile(lock, "utf8"));
  let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
  if (alive && owner.creation && process.platform === "win32") {
    try { alive = await processCreation(owner.pid) === owner.creation; } catch { alive = false; }
  }
  if (alive) throw new Error("HOPS supervisor already running");
  await fs.unlink(lock);
} catch (error) { if (error.code !== "ENOENT") throw error; }
await fs.writeFile(lock, JSON.stringify({ pid: process.pid, root, creation }), { flag: "wx", mode: 0o600 });
await fs.rm(stopFile, { force: true });
let stopping = false, child;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
const record = async message => fs.appendFile(path.join(data, "logs", `supervisor-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${message}\n`);
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send("shutdown"); else child.kill();
  for (let i = 0; i < 35 && child.exitCode === null && child.signalCode === null; i++) await delay(1000);
  if (child.exitCode === null && child.signalCode === null) { await record("Graceful shutdown timed out; terminating child"); child.kill(); }
}
async function freePort() {
  return new Promise(resolve => { const probe = net.createServer(); probe.once("error", () => resolve(false)); probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true))); });
}
try {
  await delay(15_000);
  while (!stopping) {
    try { await fs.access(stopFile); stopping = true; break; } catch { /* no stop request */ }
    if (!await freePort()) { await record("Port occupied; refusing to start a second server"); await delay(10_000); continue; }
    const log = createWriteStream(path.join(data, "logs", `server-${new Date().toISOString().slice(0, 10)}.log`), { flags: "a", mode: 0o600 });
    child = spawn(process.execPath, ["--env-file-if-exists=.env", "scripts/server.mjs"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_ENV: "production" } });
    await fs.writeFile(path.join(runtime, "child.json"), JSON.stringify({ pid: child.pid }));
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on("error", error => { void record(`Spawn failed: ${error.code}`); });
    let failures = 0, elapsed = 0;
    while (!stopping && child.exitCode === null && child.signalCode === null) {
      await delay(1000); elapsed++;
      try { await fs.access(stopFile); stopping = true; break; } catch { /* no stop request */ }
      if (elapsed < 90 || elapsed % 20 !== 0) continue;
      try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error("Health check failed"); failures = 0; }
      catch { if (++failures >= 3) { await record("Three failed health checks; restarting"); break; } }
    }
    await stopChild(); await fs.rm(path.join(runtime, "child.json"), { force: true }); log.end(); await record(`Server stopped: ${child.exitCode ?? child.signalCode}`);
    if (!stopping) await delay(10_000);
  }
} finally { await stopChild(); await fs.rm(lock, { force: true }); await fs.rm(path.join(runtime, "child.json"), { force: true }); await fs.rm(stopFile, { force: true }); }
