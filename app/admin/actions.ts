"use server";
import { revalidatePath } from "next/cache";
import { db, LocalConflictError } from "@/lib/db";
import { readState } from "@/lib/storage";
import { bindCustomer, catalogProductSchema, fallbackCatalogSource, syncSnapshots } from "@/lib/snapshots";
import { z } from "zod";
import { actionUser, assertOrigin } from "@/lib/auth";
import { UserFacingError } from "@/lib/security";
import { canOrder } from "@/lib/purchase-policy";
import { documentVersion } from "@/lib/legal";
import { legalDocumentSlugs, legalFields, legalTemplateFields, renderLegalTemplate } from "@/lib/legal-templates";
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

const manualProductSchema = catalogProductSchema.omit({ externalId: true, categoryId: true, sku: true, updatedAt: true });

function parseJsonField(value: FormDataEntryValue | null, label: string, empty: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return empty;
  try { return JSON.parse(value); }
  catch { throw new UserFacingError(`Проверьте формат JSON в поле «${label}».`); }
}

export async function saveProductAction(_state: ActionState, form: FormData) {
  const productId = String(form.get("id") || "");
  const creating = form.get("mode") === "create";
  const result = await run(creating ? "PRODUCT_CREATE_FALLBACK" : "PRODUCT_EDIT_FALLBACK", productId, async () => {
    (creating ? z.uuid() : id).parse(productId);
    const fields = Object.fromEntries(form);
    const data = manualProductSchema.parse({
      name: fields.name,
      siteCategory: fields.siteCategory,
      description: fields.description,
      price: z.string().trim().regex(/^\d+(?:[.,]\d{1,2})?$/, "Введите цену в рублях с точностью до копеек.").transform(value => Number(value.replace(",", "."))).parse(fields.price),
      stock: z.string().trim().regex(/^\d+(?:[.,]\d+)?$/, "Введите неотрицательный остаток.").transform(value => Number(value.replace(",", "."))).parse(fields.stock),
      unit: z.string().trim().min(1, "Укажите единицу учёта.").parse(fields.unit),
      volume: fields.volume,
      alcohol: fields.alcohol || null,
      barcode: fields.barcode || null,
      country: fields.country || null,
      manufacturer: fields.manufacturer || null,
      imageUrl: fields.imageUrl || null,
      beerColor: fields.beerColor || null,
      beerFiltration: fields.beerFiltration || null,
      expiryDate: fields.expiryDate || null,
      shelfLifeDays: fields.shelfLifeDays ? z.coerce.number().parse(fields.shelfLifeDays) : null,
      batches: parseJsonField(form.get("batches"), "Партии", []),
      attributes: parseJsonField(form.get("attributes"), "Характеристики", {}),
      isActive: fields.isActive === "on",
      isNew: fields.isNew === "on",
    });
    if (new Set(data.batches.map(batch => batch.batchId)).size !== data.batches.length) throw new UserFacingError("У каждой партии должен быть свой ID.");

    await db.$transaction(async tx => {
      const current = await tx.product.findUnique({ where: { id: productId } });
      if (creating && current?.source === fallbackCatalogSource) return;
      if (creating ? current : !current || current.updatedAt.toISOString() !== fields.updatedAt) {
        throw new UserFacingError("Карточка изменилась. Обновите страницу и проверьте данные.");
      }
      const { siteCategory, ...attributes } = data;
      const row = {
        ...attributes,
        category: siteCategory,
        price: Math.round(data.price * 100),
        status: data.isActive ? "PUBLISHED" : "ARCHIVED",
        manualOverride: true,
        manualOrderBlocked: !current || (current.manualOverride ? current.manualOrderBlocked : !current.isActive || !canOrder(current)),
      };
      if (current) await tx.product.update({ where: { id: productId }, data: row });
      else await tx.product.create({ data: { ...row, id: productId, sku: `HOPS-${productId}`, slug: `p-${productId}`, source: fallbackCatalogSource } });

      const warehouseId = "hops-store";
      const quantity = data.isActive ? data.stock : 0;
      await tx.inventory.upsert({
        where: { productId_warehouseId: { productId, warehouseId } },
        create: { productId, warehouseId, quantity },
        update: { quantity },
      });
    });
  });
  return creating && result.success ? { ...result, redirectTo: `/admin?tab=products&edit=${productId}` } : result;
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
    const status = z.enum(["PENDING", "APPROVED", "REJECTED"]).parse(form.get("status"));
    if (status === "APPROVED" && form.get("reviewChecked") !== "on") {
      throw new UserFacingError("Подтвердите, что в тексте отзыва нет персональных данных.");
    }
    await db.review.update({ where: { id: id.parse(reviewId) }, data: { status } });
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
export async function saveLegalDetailsAction(_state: ActionState, form: FormData) {
  return run("LEGAL_DETAILS_SAVE", "main", async () => {
    const legalDetails = Object.fromEntries(Object.keys(legalFields).map(key => [
      key, z.string().trim().max(1600).parse(form.get(key) ?? ""),
    ]));
    if (legalDetails.inn && !/^(?:\d{10}|\d{12})$/.test(legalDetails.inn)) throw new UserFacingError("ИНН должен содержать 10 или 12 цифр.");
    if (legalDetails.ogrn && !/^(?:\d{13}|\d{15})$/.test(legalDetails.ogrn)) throw new UserFacingError("ОГРН должен содержать 13 цифр, ОГРНИП — 15.");
    for (const email of [legalDetails.claimsEmail, legalDetails.privacyEmail]) {
      if (email && !z.email().safeParse(email).success) throw new UserFacingError("Проверьте адреса электронной почты.");
    }
    if (legalDetails.siteUrl) {
      const url = z.url({ protocol: /^https$/ }).safeParse(legalDetails.siteUrl);
      if (!url.success) throw new UserFacingError("Укажите публичный HTTPS-адрес сайта.");
    }
    await db.shopSettings.update({ where: { id: "main" }, data: { legalDetails } });
  });
}

export async function saveDocumentAction(_state: ActionState, form: FormData) {
  return run("DOCUMENT_SAVE", String(form.get("slug") || ""), async () => {
    const slug = z.enum(legalDocumentSlugs).parse(form.get("slug"));
    const title = z.string().trim().min(3).max(200).parse(form.get("title"));
    const draft = z.string().trim().min(30, "Укажите полный текст документа.").max(100000).parse(form.get("content"));
    const published = form.get("published") === "on";
    await db.$transaction(async tx => {
      const settings = await tx.shopSettings.findUniqueOrThrow({ where: { id: "main" } });
      const content = published ? renderLegalTemplate(draft, settings.legalDetails ?? {}) : draft;
      const missing = legalTemplateFields(content);
      if (published && missing.length) {
        throw new UserFacingError(`Заполните поля перед публикацией. ${missing.map(key => Object.hasOwn(legalFields, key) ? legalFields[key] : key).join(", ")}.`);
      }
      const previous = await tx.document.findUnique({ where: { slug } });
      const versions = previous?.versions ?? [];
      if (previous?.published) {
        const version = documentVersion(previous);
        if ((!published || version !== documentVersion({ slug, title, content })) && !versions.some(item => item.version === version)) {
          versions.push({ version, title: previous.title, content: previous.content });
        }
      }
      const data = { slug, title, draft, content, published, versions };
      await tx.document.upsert({ where: { slug }, create: data, update: data });
    });
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
