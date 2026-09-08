import { setTimeout as delay } from "node:timers/promises";
import { db } from "../lib/db";
import { processNextJob } from "../lib/integration";
import { publicFailure } from "../lib/integration/errors";

let stopping = false;
const shutdown = new AbortController();
function stop() { stopping = true; shutdown.abort(); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function main() {
  console.info("HOPS synchronization worker started");
  while (!stopping) {
    try {
      const processed = await processNextJob();
      if (!processed) await delay(3000, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (stopping) break;
      console.error(`HOPS worker: ${publicFailure(error).code}`);
      await delay(5000, undefined, { signal: shutdown.signal }).catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`HOPS worker stopped: ${publicFailure(error).code}`);
  process.exitCode = 1;
}).finally(async () => { await db.$disconnect(); });
