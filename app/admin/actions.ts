"use server";
import { revalidatePath } from "next/cache";
import { LocalConflictError } from "@/lib/db";
import { readState } from "@/lib/storage";
import { bindCustomer, syncSnapshots } from "@/lib/snapshots";
import { z } from "zod";
import { db } from "@/lib/db";
import { actionUser, assertOrigin } from "@/lib/auth";
import { UserFacingError } from "@/lib/security";
import { serializable, transitionOrder, confirmOrderInOneC } from "@/lib/orders";
import type { ActionState } from "@/lib/types";

const id = z.string().min(1).max(100);
async function run(action: string, targetId: string | null, fn: (actorId: string) => Promise<void>): Promise<ActionState> {
  try {
    await assertOrigin();
    const actor = await actionUser(true);
    await fn(actor.id);
    await db.auditLog.create({ data: { actorId: actor.id, action, targetId } });
    revalidatePath("/", "layout");
    return { success: true, message: "Изменения сохранены." };
  } catch (error) {
    if (error instanceof UserFacingError) return { success: false, message: error.message };
    if (error instanceof z.ZodError) return { success: false, message: error.issues[0]?.message || "Проверьте поля формы." };
    if (error instanceof LocalConflictError) return { success: false, message: "Такой артикул, адрес страницы или внешний ID уже используется." };
    console.error("Admin action failed", error instanceof Error ? error.name : "UnknownError");
    return { success: false, message: "Не удалось сохранить изменения. Обновите страницу и проверьте данные." };
  }
}
export async function orderStatusAction(_state: ActionState, form: FormData) {
  const orderId = String(form.get("id") || "");
  return run("ORDER_STATUS", orderId, async () => {
    const status = z.enum(["NEW", "CONFIRMED", "PREPARING", "READY", "COMPLETED", "CANCELLED"]).parse(form.get("status"));
    await serializable(async tx => {
      await transitionOrder(tx, id.parse(orderId), status);
    });
  });
}
export async function reviewStatusAction(_state: ActionState, form: FormData) {
  const reviewId = String(form.get("id") || "");
  return run("REVIEW_MODERATE", reviewId, async () => {
    await db.review.update({ where: { id: id.parse(reviewId) }, data: { status: z.enum(["PENDING", "APPROVED", "REJECTED"]).parse(form.get("status")) } });
  });
}
export async function saveSettingsAction(_state: ActionState, form: FormData) {
  return run("SETTINGS_SAVE", "main", async () => {
    const data = z.object({
      address: z.string().trim().min(5).max(300), shortAddress: z.string().trim().min(3).max(100),
      hoursWeek: z.string().min(3).max(100),
      hoursWeekend: z.string().min(3).max(100), announcement: z.string().max(200),
      pickupOpen: z.coerce.number().int().min(0).max(23), pickupClose: z.coerce.number().int().min(1).max(24),
      loyaltyRules: z.string().max(20000),
      timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("ru", { timeZone: value }); return true; } catch { return false; } }),
    }).parse({ ...Object.fromEntries(form), loyaltyRules: form.get("loyaltyRules") || "" });
    if (data.pickupClose <= data.pickupOpen) throw new UserFacingError("Время закрытия должно быть позже времени открытия.");
    await db.shopSettings.update({ where: { id: "main" }, data: { ...data, loyaltyRulesConfirmed: form.get("loyaltyRulesConfirmed") === "on" } });
  });
}
export async function saveWarehouseAction(_state: ActionState, form: FormData) {
  const warehouseId = String(form.get("id") || "");
  return run("WAREHOUSE_SAVE", warehouseId, async () => {
    await db.warehouse.update({ where: { id: id.parse(warehouseId) }, data: {
      name: z.string().trim().min(2).max(200).parse(form.get("name")),
      address: z.string().trim().min(5).max(500).parse(form.get("address")),
      externalId: z.string().trim().max(200).parse(form.get("externalId") || "") || null,
      pickupEnabled: form.get("pickupEnabled") === "on",
    } });
  });
}
export async function saveDocumentAction(_state: ActionState, form: FormData) {
  return run("DOCUMENT_SAVE", String(form.get("slug") || ""), async () => {
    const data = {
      slug: z.enum(["offer", "privacy", "returns", "loyalty"]).parse(form.get("slug")),
      title: z.string().trim().min(3).max(200).parse(form.get("title")),
      content: z.string().trim().min(30, "Укажите полный текст документа.").max(100000).parse(form.get("content")),
      published: form.get("published") === "on",
    };
    await db.document.upsert({ where: { slug: data.slug }, create: data, update: data });
  });
}
export async function syncAction(_state: ActionState, _form: FormData) {
  void _form;
  return run("SYNC_MANUAL", null, async () => { await syncSnapshots(true); const sync = (await readState()).sync; if (sync.catalog.error || sync.loyalty.error) throw new UserFacingError("Проверка завершена с ошибками. Подробности указаны в статусе синхронизации."); });
}
export async function lookupClientAction(_state: ActionState, form: FormData) {
  return run("CLIENT_BIND", String(form.get("id") || ""), async actorId => {
    if (form.get("verified") !== "on") throw new UserFacingError("Подтвердите проверку личности клиента и карты в магазине.");
    await bindCustomer(id.parse(form.get("id")), id.parse(form.get("customerId")), actorId);
  });
}

export async function confirmOrderAction(_state: ActionState, form: FormData) {
  return run("ORDER_1C_CONFIRM", String(form.get("id") || ""), async actorId => {
    if (form.get("verified") !== "on") throw new UserFacingError("Подтвердите проверку чека и остатков в 1С.");
    await confirmOrderInOneC(id.parse(form.get("id")), id.parse(form.get("receiptId")), id.parse(form.get("catalogExportId")), actorId);
  });
}
