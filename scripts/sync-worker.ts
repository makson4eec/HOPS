import { syncSnapshots } from "../lib/snapshots";
async function main() {
  await syncSnapshots(true);
  setInterval(() => { void syncSnapshots().catch(() => { console.error("Local sync failed"); }); }, 60_000);
}
main().catch(() => { console.error("Local sync failed"); process.exitCode = 1; });
