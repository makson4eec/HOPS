import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
async function waitFor(fn, timeout = 70000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { const result = await fn(); if (result) return result; } catch { /* startup in progress */ } await delay(500); }
  throw new Error("Runtime condition timed out");
}
test("production supervisor: startup, duplicate prevention, crash restart, graceful stop", { timeout: 150000 }, async () => {
  await fs.mkdir(".test-data", { recursive: true });
  const data = await fs.mkdtemp(path.resolve(".test-data/runtime-"));
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  const env = { ...process.env, HOPS_DATA_DIR: data, PORT: String(port), APP_URL: `http://localhost:${port}`, COOKIE_SECURE: "false", NEXT_TELEMETRY_DISABLED: "1" };
  const supervisor = spawn(process.execPath, ["scripts/supervisor.mjs"], { env, windowsHide: true, stdio: "pipe" });
  let stderr = ""; supervisor.stderr.on("data", chunk => { stderr += chunk; });
  const healthy = async () => (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
  const childPid = async () => JSON.parse(await fs.readFile(path.join(data, "runtime/child.json"), "utf8")).pid;
  try {
    await waitFor(healthy);
    const initial = await childPid();
    const duplicate = spawn(process.execPath, ["scripts/supervisor.mjs"], { env, windowsHide: true, stdio: "pipe" });
    duplicate.stderr.resume(); duplicate.stdout.resume();
    assert.equal(await new Promise(resolve => duplicate.on("exit", resolve)), 1);
    assert.equal(await childPid(), initial);
    process.kill(initial);
    await waitFor(async () => await childPid() !== initial && await healthy());
    await fs.writeFile(path.join(data, "runtime/stop"), "stop");
    await waitFor(() => supervisor.exitCode !== null);
    assert.equal(supervisor.exitCode, 0, stderr);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (supervisor.exitCode === null) {
      await fs.mkdir(path.join(data, "runtime"), { recursive: true }); await fs.writeFile(path.join(data, "runtime/stop"), "stop");
      try { await waitFor(() => supervisor.exitCode !== null, 45000); } catch { supervisor.kill(); }
    }
    await fs.rm(data, { recursive: true, force: true });
  }
});
