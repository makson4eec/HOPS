import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { db } from "@/lib/db";
import { CART_COOKIE, cookieOptions, getCurrentUser } from "@/lib/auth";
import { newToken, tokenHash } from "@/lib/security";

export const getSettings = cache(() => db.shopSettings.findUniqueOrThrow({ where: { id: "main" } }));
export const getCart = cache(async () => {
  const token = (await cookies()).get(CART_COOKIE)?.value;
  if (!token) return null;
  const cart = await db.cart.findUnique({ where: { tokenHash: tokenHash(token) }, include: {
    items: { orderBy: { id: "asc" }, include: { product: { include: { inventories: { include: { warehouse: true } } } } } },
  } });
  if (!cart || cart.expiresAt < new Date()) return null;
  if (cart.userId && cart.userId !== (await getCurrentUser())?.id) return null;
  return cart;
});
export async function ensureCart() {
  const existing = await getCart();
  if (existing) return existing;
  const token = newToken();
  const expiresAt = new Date(Date.now() + 30 * 86400_000);
  const cart = await db.cart.create({ data: { tokenHash: tokenHash(token), expiresAt, userId: (await getCurrentUser())?.id } });
  (await cookies()).set(CART_COOKIE, token, { ...cookieOptions, expires: expiresAt });
  return cart;
}
