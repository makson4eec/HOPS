import type { OrderStatus } from "./models";
import type { LocalDb } from "./db";
import { db } from "@/lib/db";
import { mutateState } from "./storage";
import { UserFacingError } from "@/lib/security";

export const transitions: Record<OrderStatus, OrderStatus[]> = {
  NEW: ["CONFIRMED", "CANCELLED"], CONFIRMED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"], READY: ["COMPLETED", "CANCELLED"], COMPLETED: [], CANCELLED: [],
};
export async function serializable<T>(fn: (tx: LocalDb) => Promise<T>): Promise<T> {
  return db.$transaction(fn);
}
export async function transitionOrder(tx: LocalDb, orderId: string, nextStatus: OrderStatus) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
  if (order.status === nextStatus) return order;
  if (!transitions[order.status].includes(nextStatus)) throw new UserFacingError("Этот переход статуса недоступен. Обновите страницу.");
  if (nextStatus === "CANCELLED") {
    for (const item of order.items) {
      const updated = await tx.inventory.updateMany({
        where: { productId: item.productId, warehouseId: order.warehouseId, reserved: { gte: item.quantity } },
        data: { reserved: { decrement: item.quantity } },
      });
      if (updated.count !== 1) throw new UserFacingError("Остатки изменились. Сначала проверьте их в учётной системе.");
    }
  }
  return tx.order.update({ where: { id: orderId }, data: { status: nextStatus } });
}

// Interpret pickup in the shop timezone, independent of the Windows timezone.
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
  if (formatter.format(result).replace(" ", "T") !== value || hour < open || hour >= close) throw new UserFacingError(`Самовывоз доступен с ${open}:00 до ${String(close % 24).padStart(2, "0")}:00 по времени магазина.`);
  if (result.getTime() < now.getTime() + 30 * 60_000 || result.getTime() > now.getTime() + 7 * 86400_000) throw new UserFacingError("Выберите время не раньше чем через 30 минут и не позже чем через 7 дней.");
  return result;
}

// Until future automatic acknowledgements, staff can confirm a receipt already
// present in 1C together with an authoritative snapshot that includes that sale.
export async function confirmOrderInOneC(orderId: string, receiptId: string, catalogExportId: string, actorId: string) {
  return mutateState(state => {
    if (!state.tables.user.some(user => user.id === actorId && user.role === "ADMIN")) throw new UserFacingError("Недостаточно прав.");
    const order = state.tables.order.find(row => row.id === orderId);
    if (!order || order.status !== "COMPLETED") throw new UserFacingError("Сначала завершите выдачу заказа.");
    if (order.confirmedInOneCAt) {
      if (order.receiptId !== receiptId) throw new UserFacingError("Заказ уже подтверждён другим чеком.");
      return;
    }
    if (!receiptId.trim() || receiptId.length > 200) throw new UserFacingError("Укажите номер чека 1С.");
    if (state.tables.order.some(row => row.id !== orderId && row.receiptId === receiptId)) throw new UserFacingError("Этот чек уже использован.");
    if (state.sync.catalog.exportId !== catalogExportId || !state.sync.catalog.generatedAt || Date.parse(state.sync.catalog.generatedAt) < order.updatedAt.getTime() || state.sync.catalog.error) throw new UserFacingError("Загрузите исправную выгрузку остатков после проведения продажи в 1С и обновите страницу.");
    const items = state.tables.orderItem.filter(item => item.orderId === orderId);
    for (const item of items) {
      const inventory = state.tables.inventory.find(row => row.productId === item.productId && row.warehouseId === order.warehouseId);
      if (!inventory || inventory.reserved < item.quantity) throw new UserFacingError("Резерв требует проверки сотрудником.");
      inventory.reserved -= item.quantity;
    }
    order.confirmedInOneCAt = new Date(); order.receiptId = receiptId; order.confirmedCatalogExportId = catalogExportId;
    state.tables.auditLog.push({ id: crypto.randomUUID(), actorId, action: "ORDER_CONFIRMED_IN_1C_BY_STAFF", targetId: orderId, createdAt: new Date(), updatedAt: new Date() });
  });
}
