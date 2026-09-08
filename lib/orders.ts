import { Prisma, type OrderStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/security";

export const transitions: Record<OrderStatus, OrderStatus[]> = {
  NEW: ["CONFIRMED", "CANCELLED"], CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"], READY: ["COMPLETED", "CANCELLED"], COMPLETED: [], CANCELLED: [],
};
export async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && attempt < 3 && (
        error.code === "P2034" || (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)))
      )) continue;
      throw error;
    }
  }
}
export async function transitionOrder(tx: Prisma.TransactionClient, orderId: string, nextStatus: OrderStatus) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  if (order.status === nextStatus) return order;
  if (!transitions[order.status].includes(nextStatus)) throw new UserFacingError("Этот переход статуса недоступен. Обновите страницу.");
  if (nextStatus === "CANCELLED" || nextStatus === "COMPLETED") {
    for (const item of order.items) {
      const updated = await tx.inventory.updateMany({
        where: { productId: item.productId, warehouseId: order.warehouseId, reserved: { gte: item.quantity }, ...(nextStatus === "COMPLETED" ? { quantity: { gte: item.quantity } } : {}) },
        data: { reserved: { decrement: item.quantity }, ...(nextStatus === "COMPLETED" ? { quantity: { decrement: item.quantity } } : {}) },
      });
      if (updated.count !== 1) throw new UserFacingError("Остатки изменились. Сначала проверьте их в учётной системе.");
    }
  }
  return tx.order.update({ where: { id: orderId }, data: { status: nextStatus } });
}

// Parse a shop-local datetime explicitly; never depend on the VPS timezone.
export function parsePickup(value: string, timezone: string, open: number, close: number, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new UserFacingError("Выберите дату и время самовывоза.");
  const wall = new Date(`${value}:00Z`);
  if (!Number.isFinite(wall.getTime())) throw new UserFacingError("Некорректная дата самовывоза.");
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let result = wall;
  for (let i = 0; i < 3; i++) {
    const displayed = formatter.format(result).replace(" ", "T");
    result = new Date(result.getTime() + wall.getTime() - new Date(`${displayed}:00Z`).getTime());
  }
  const hour = Number(value.slice(11, 13));
  if (formatter.format(result).replace(" ", "T") !== value || hour < open || hour >= close) throw new UserFacingError(`Самовывоз доступен с ${open}:00 до ${close}:00 по времени магазина.`);
  if (result.getTime() < now.getTime() + 30 * 60_000 || result.getTime() > now.getTime() + 7 * 86400_000) throw new UserFacingError("Выберите время не раньше чем через 30 минут и не позже чем через 7 дней.");
  return result;
}
