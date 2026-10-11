"use server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { actionUser, assertOrigin } from "@/lib/auth";
import { categories } from "@/lib/constants";
import { parsePrice, UserFacingError } from "@/lib/security";
import { serializable, transitionOrder } from "@/lib/orders";
import { queueCatalogSync, queueClientLookup, queueOrderStatusSync, retrySyncJob } from "@/lib/integration";
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { success: false, message: "Такой артикул, адрес страницы или внешний ID уже используется." };
    console.error("Admin action failed", error instanceof Error ? error.name : "UnknownError");
    return { success: false, message: "Не удалось сохранить изменения. Обновите страницу и проверьте данные." };
  }
}
export async function saveProductAction(_state: ActionState, form: FormData) {
  const productId = String(form.get("id") || "");
  return run("PRODUCT_SAVE", productId || null, async () => {
    const existing = productId ? await db.product.findUniqueOrThrow({ where: { id: productId } }) : null;
    const status = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).parse(form.get("status"));
    const category = existing?.externalId ? existing.category : z.string().refine(value => categories.some(c => c.id === value && c.id !== "new"), "Выберите категорию.").parse(form.get("category"));
    const beerColor = category === "kvass" ? z.enum(["light", "dark", ""]).parse(form.get("beerColor") || "") || null : null;
    const beerFiltration = beerColor ? z.enum(["filtered", "unfiltered", ""]).parse(form.get("beerFiltration") || "") || null : null;
    if (existing?.externalId) {
      await db.product.update({ where: { id: existing.id }, data: { status, beerColor, beerFiltration } });
      return;
    }
    const data = {
      name: z.string().trim().min(2).max(250).parse(form.get("name")),
      sku: z.string().trim().min(1).max(100).parse(form.get("sku")),
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Адрес страницы: латинские буквы, цифры и дефис.").max(180).parse(form.get("slug")),
      category, beerColor, beerFiltration,
      price: parsePrice(String(form.get("price") || "")),
      description: z.string().trim().max(20000).parse(form.get("description") || ""),
      volume: z.string().trim().max(100).parse(form.get("volume") || ""),
      imageUrl: z.string().max(300).regex(/^$|^\/images\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|avif)$/, "Укажите путь /images/имя.webp к файлу из public/images.").parse(form.get("imageUrl") || "") || null,
      isNew: form.get("isNew") === "on", status,
    };
    if (status === "PUBLISHED" && data.price <= 0) throw new UserFacingError("Перед публикацией укажите цену больше нуля.");
    const quantity = z.coerce.number().int().min(0).max(1_000_000).parse(form.get("quantity"));
    const warehouseId = id.parse(form.get("warehouseId"));
    await serializable(async tx => {
      const product = existing ? await tx.product.update({ where: { id: existing.id }, data }) : await tx.product.create({ data });
      const stock = await tx.inventory.findUnique({ where: { productId_warehouseId: { productId: product.id, warehouseId } } });
      if (stock && stock.reserved > quantity) throw new UserFacingError(`Нельзя установить остаток меньше резерва (${stock.reserved}).`);
      await tx.inventory.upsert({ where: { productId_warehouseId: { productId: product.id, warehouseId } }, create: { productId: product.id, warehouseId, quantity }, update: { quantity } });
    });
  });
}
export async function orderStatusAction(_state: ActionState, form: FormData) {
  const orderId = String(form.get("id") || "");
  return run("ORDER_STATUS", orderId, async () => {
    const status = z.enum(["NEW", "CONFIRMED", "PREPARING", "READY", "COMPLETED", "CANCELLED"]).parse(form.get("status"));
    await serializable(async tx => {
      const order = await transitionOrder(tx, id.parse(orderId), status);
      await tx.syncJob.upsert({ where: { dedupeKey: `order:${order.id}:${status}` }, create: { kind: "ORDER_EXPORT", dedupeKey: `order:${order.id}:${status}`, payload: { orderId: order.id } }, update: {} });
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
      timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("ru", { timeZone: value }); return true; } catch { return false; } }),
    }).parse(Object.fromEntries(form));
    if (data.pickupClose <= data.pickupOpen) throw new UserFacingError("Время закрытия должно быть позже времени открытия.");
    await db.shopSettings.update({ where: { id: "main" }, data });
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
export async function syncAction(_state: ActionState, form: FormData) {
  return run("SYNC_MANUAL", null, async actorId => {
    if (form.get("kind") === "statuses") await queueOrderStatusSync(actorId);
    else await queueCatalogSync(actorId);
  });
}
export async function retrySyncAction(_state: ActionState, form: FormData) {
  return run("SYNC_RETRY", String(form.get("id") || ""), async () => { await retrySyncJob(id.parse(form.get("id"))); });
}
export async function lookupClientAction(_state: ActionState, form: FormData) {
  return run("CLIENT_LOOKUP", String(form.get("id") || ""), async () => {
    if (form.get("verified") !== "on") throw new UserFacingError("Подтвердите проверку личности клиента в магазине.");
    await queueClientLookup(id.parse(form.get("id")), {
      email: z.email().parse(form.get("verifiedEmail")),
      phone: z.string().max(40).parse(form.get("verifiedPhone") || "") || null,
    });
  });
}
export async function bonusOperationAction(_state: ActionState, form: FormData) {
  return run("BONUS_QUEUE", String(form.get("userId") || ""), async () => {
    const userId = id.parse(form.get("userId"));
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.externalId) throw new UserFacingError("Сначала свяжите клиента с 1С после проверки его личности.");
    const data = {
      userId, idempotencyKey: z.string().uuid().parse(form.get("idempotencyKey")),
      amount: z.coerce.number().int().min(1).max(1000000).parse(form.get("amount")),
      kind: z.enum(["ACCRUAL", "REDEMPTION", "REVERSAL"]).parse(form.get("kind")),
      description: z.string().trim().min(5).max(500).parse(form.get("description")),
    };
    await db.$transaction(async tx => {
      const operation = await tx.bonusOperation.upsert({ where: { idempotencyKey: data.idempotencyKey }, create: data, update: {} });
      if (operation.userId !== userId) throw new UserFacingError("Обновите форму операции.");
      await tx.syncJob.upsert({ where: { dedupeKey: `bonus:${operation.idempotencyKey}` }, create: { kind: "BONUS_OPERATION", dedupeKey: `bonus:${operation.idempotencyKey}`, payload: { operationId: operation.id } }, update: {} });
    });
  });
}
