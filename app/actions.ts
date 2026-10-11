"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { actionUser, assertOrigin, CART_COOKIE, createSession, rateLimit, requestIdentifier, SESSION_COOKIE } from "@/lib/auth";
import { ensureCart, getCart, getSettings } from "@/lib/data";
import { findOwnedOrder, placeOrder } from "@/lib/checkout";
import { parsePickup, serializable } from "@/lib/orders";
import { hashPassword, normalizePhone, safeNext, tokenHash, UserFacingError, verifyPassword } from "@/lib/security";
import type { ActionState } from "@/lib/types";
import { passwordSchema } from "@/lib/password";

const emailSchema = z.string().trim().toLowerCase().email("Введите корректный email.").max(254);
function consent(form: FormData) {
  if (form.get("consent") !== "on") throw new UserFacingError("Подтвердите согласие на обработку данных.");
}
async function run(fn: () => Promise<ActionState>): Promise<ActionState> {
  let result: ActionState;
  try { await assertOrigin(); result = await fn(); }
  catch (error) {
    if (error instanceof UserFacingError) return { success: false, message: error.message };
    if (error instanceof z.ZodError) return { success: false, message: error.issues[0]?.message || "Проверьте поля формы." };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { success: false, message: "Эти данные уже используются. Проверьте введённые значения." };
    console.error("Action failed", error instanceof Prisma.PrismaClientKnownRequestError ? error.code : error instanceof Error ? error.name : "UnknownError");
    return { success: false, message: "Не удалось выполнить действие. Повторите немного позже." };
  }
  // Revalidation can unmount the submitting form; navigate before returning its state.
  // Keep redirect outside catch because Next.js implements it by throwing.
  if (result.success && result.redirectTo) redirect(result.redirectTo);
  return result;
}
export async function registerAction(_state: ActionState, form: FormData) {
  return run(async () => {
    await rateLimit("register", await requestIdentifier(), 10);
    consent(form);
    const email = emailSchema.parse(form.get("email"));
    const password = passwordSchema.parse(form.get("password"));
    const name = z.string().trim().min(2, "Укажите имя.").max(80).parse(form.get("name"));
    const user = await db.user.create({ data: { name, email, passwordHash: await hashPassword(password) } });
    await createSession(user.id, user.passwordHash);
    revalidatePath("/", "layout");
    return { success: true, message: "Кабинет создан.", redirectTo: safeNext(form.get("next")) };
  });
}
export async function loginAction(_state: ActionState, form: FormData) {
  return run(async () => {
    const email = emailSchema.parse(form.get("email"));
    const password = passwordSchema.parse(form.get("password"));
    await rateLimit("login-account", email);
    await rateLimit("login-network", await requestIdentifier(), 100);
    const user = await db.user.findUnique({ where: { email } });
    // Keep the expensive operation for unknown accounts too.
    const encoded = user?.passwordHash || `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`;
    const valid = await verifyPassword(password, encoded);
    if (!user || !valid) throw new UserFacingError("Неверный email или пароль.");
    await createSession(user.id, user.passwordHash);
    revalidatePath("/", "layout");
    return { success: true, message: "Вы вошли в кабинет.", redirectTo: safeNext(form.get("next")) };
  });
}
export async function logoutAction(_state: ActionState, _form: FormData) {
  void _form;
  return run(async () => {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) await db.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
    jar.delete(SESSION_COOKIE);
    jar.delete(CART_COOKIE);
    revalidatePath("/", "layout");
    return { success: true, message: "Вы вышли из кабинета.", redirectTo: "/account" };
  });
}
export async function changePasswordAction(_state: ActionState, form: FormData) {
  return run(async () => {
    const user = await actionUser();
    await rateLimit("change-password", user.id, 5);
    const currentPassword = passwordSchema.parse(form.get("currentPassword"));
    const password = passwordSchema.parse(form.get("password"));
    const record = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!await verifyPassword(currentPassword, record.passwordHash)) throw new UserFacingError("Текущий пароль неверен.");
    const passwordHash = await hashPassword(password);
    await db.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: user.id, passwordHash: record.passwordHash }, data: { passwordHash } });
      if (!changed.count) throw new UserFacingError("Пароль уже изменился. Войдите снова.");
      await tx.session.deleteMany({ where: { userId: user.id } });
    });
    await createSession(user.id, passwordHash);
    return { success: true, message: "Пароль изменён. Остальные сеансы завершены." };
  });
}
export async function addToCartAction(_state: ActionState, form: FormData) {
  return run(async () => {
    const productId = z.string().max(100).parse(form.get("productId"));
    const quantity = z.coerce.number().int().min(1).max(99).parse(form.get("quantity") ?? 1);
    await rateLimit("cart", await requestIdentifier(), 200);
    const cart = await ensureCart();
    await serializable(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${cart.id} FOR UPDATE`;
      const product = await tx.product.findUnique({ where: { id: productId }, include: { inventories: { where: { warehouse: { pickupEnabled: true } } } } });
      if (!product || !product.isActive || product.status !== "PUBLISHED" || product.price <= 0) throw new UserFacingError("Товар недоступен для заказа.");
      const current = await tx.cartItem.findUnique({ where: { cartId_productId: { cartId: cart.id, productId } } });
      const nextQuantity = (current?.quantity || 0) + quantity;
      const max = Math.max(0, ...product.inventories.map(stock => stock.quantity - stock.reserved));
      if (nextQuantity > max || nextQuantity > 99) throw new UserFacingError("Такого количества нет в наличии в одном магазине.");
      const count = await tx.cartItem.count({ where: { cartId: cart.id } });
      if (!current && count >= 100) throw new UserFacingError("В корзине можно разместить не более 100 позиций.");
      await tx.cartItem.upsert({ where: { cartId_productId: { cartId: cart.id, productId } }, create: { cartId: cart.id, productId, quantity: nextQuantity }, update: { quantity: nextQuantity } });
    });
    revalidatePath("/", "layout");
    return { success: true, message: "Товар добавлен в корзину." };
  });
}
export async function updateCartAction(_state: ActionState, form: FormData) {
  return run(async () => {
    const cart = await getCart();
    if (!cart) throw new UserFacingError("Корзина недоступна. Обновите страницу.");
    const productId = z.string().max(100).parse(form.get("productId"));
    const quantity = z.coerce.number().int().min(0).max(99).parse(form.get("quantity"));
    await serializable(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Cart" WHERE "id" = ${cart.id} FOR UPDATE`;
      if (quantity === 0) await tx.cartItem.deleteMany({ where: { cartId: cart.id, productId } });
      else {
        const stocks = await tx.inventory.findMany({ where: { productId, warehouse: { pickupEnabled: true }, product: { status: "PUBLISHED", isActive: true } } });
        if (!stocks.some(stock => stock.quantity - stock.reserved >= quantity)) throw new UserFacingError("Запрошенное количество недоступно.");
        await tx.cartItem.updateMany({ where: { cartId: cart.id, productId }, data: { quantity } });
      }
    });
    revalidatePath("/", "layout");
    return { success: true, message: quantity ? "Количество обновлено." : "Товар удалён из корзины." };
  });
}
export async function checkoutAction(_state: ActionState, form: FormData) {
  return run(async () => {
    const user = await actionUser();
    await rateLimit("checkout", user.id, 20);
    consent(form);
    const checkoutKey = z.string().uuid("Обновите страницу оформления.").parse(form.get("checkoutKey"));
    const duplicate = await findOwnedOrder(checkoutKey, user.id);
    if (duplicate) return { success: true, message: "Заказ уже оформлен.", redirectTo: `/orders?order=${duplicate.id}` };
    const cart = await getCart();
    if (!cart?.items.length) throw new UserFacingError("Корзина пуста.");
    const settings = await getSettings();
    const pickupAt = parsePickup(z.string().parse(form.get("pickupAt")), settings.timezone, settings.pickupOpen, settings.pickupClose);
    const order = await placeOrder({
      userId: user.id, cartId: cart.id, checkoutKey, pickupAt,
      expectedTotal: z.coerce.number().int().min(0).max(2_000_000_000).parse(form.get("expectedTotal")),
      warehouseId: z.string().min(1).max(100).parse(form.get("warehouseId")),
      name: z.string().trim().min(2, "Укажите имя.").max(80).parse(form.get("name")),
      phone: normalizePhone(z.string().max(30).parse(form.get("phone"))),
      comment: z.string().trim().max(1000).parse(form.get("comment") || ""),
    });
    revalidatePath("/", "layout");
    return { success: true, message: "Заказ на самовывоз оформлен.", redirectTo: `/orders?order=${order.id}` };
  });
}
export async function reviewAction(_state: ActionState, form: FormData) {
  return run(async () => {
    const user = await actionUser();
    await rateLimit("review", user.id, 3);
    consent(form);
    const text = z.string().trim().min(10, "Напишите не менее 10 символов.").max(2000).parse(form.get("text"));
    const rating = z.coerce.number().int().min(1).max(5).parse(form.get("rating"));
    await db.review.create({ data: { name: user.name, userId: user.id, text, rating } });
    return { success: true, message: "Спасибо! Отзыв отправлен на проверку." };
  });
}
export async function subscribeAction(_state: ActionState, form: FormData) {
  return run(async () => {
    await rateLimit("subscription", await requestIdentifier(), 10);
    consent(form);
    const email = emailSchema.parse(form.get("email"));
    await db.subscription.upsert({ where: { email }, create: { email }, update: {} });
    return { success: true, message: "Ваш адрес сохранён для уведомлений о поступлениях." };
  });
}
