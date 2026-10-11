export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { syncSnapshots } = await import("./lib/snapshots");
    const { dailyBackup } = await import("./lib/backup");
    const tick = () => syncSnapshots().then(() => dailyBackup()).catch(error => console.error("Local maintenance failed", error instanceof Error ? error.name : "Error"));
    void tick(); setInterval(tick, 60_000).unref();
  }
}
