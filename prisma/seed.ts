import { db } from "../lib/db";

async function main() {
  await db.shopSettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
  const settings = await db.shopSettings.findUniqueOrThrow({ where: { id: "main" } });
  await db.warehouse.upsert({ where: { id: "hops-store" }, update: {}, create: { id: "hops-store", name: "Магазин HOPS", address: settings.address, pickupEnabled: true } });
  console.log("Настройки и существующий магазин подготовлены. Товары и клиенты не добавлялись.");
}
main().catch(() => { console.error("Не удалось подготовить базу. Проверьте миграции и DATABASE_URL."); process.exitCode = 1; }).finally(() => db.$disconnect());
