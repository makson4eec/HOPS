import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { newToken, tokenHash, UserFacingError } from "@/lib/security";

export const SESSION_COOKIE = "hops_session";
export const CART_COOKIE = "hops_cart";
export const cookieOptions = { httpOnly: true, secure: process.env.COOKIE_SECURE === "true" || process.env.APP_URL?.startsWith("https://") === true, sameSite: "lax" as const, path: "/" };
export const getCurrentUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: {
    user: { select: { id: true, name: true, email: true, phone: true, role: true, externalId: true, bonusBalance: true, bonusUpdatedAt: true, createdAt: true } },
  } });
  return session && session.expiresAt > new Date() ? session.user : null;
});
export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/account");
  return user;
}
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) redirect("/account?next=/admin");
  if (user.role !== "ADMIN") redirect("/account");
  return user;
}
export async function actionUser(admin = false) {
  const user = await getCurrentUser();
  if (!user) throw new UserFacingError("Войдите в кабинет, чтобы продолжить.");
  if (admin && user.role !== "ADMIN") throw new UserFacingError("Недостаточно прав для этого действия.");
  return user;
}
export async function assertOrigin() {
  const origin = (await headers()).get("origin");
  const expected = process.env.APP_URL || "http://localhost:3000";
  if (!origin || new URL(expected).origin !== origin) throw new UserFacingError("Запрос отклонён. Обновите страницу и повторите действие.");
}
export async function rateLimit(scope: string, identifier: string, limit = 10, windowSeconds = 900) {
  const key = tokenHash(`${scope}:${identifier}`);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "count", "expiresAt") VALUES (${key}, 1, NOW() + ${windowSeconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."expiresAt" < NOW() THEN 1 ELSE "RateLimit"."count" + 1 END,
      "expiresAt" = CASE WHEN "RateLimit"."expiresAt" < NOW() THEN NOW() + ${windowSeconds} * INTERVAL '1 second' ELSE "RateLimit"."expiresAt" END
    RETURNING "count"`;
  if (rows[0].count > limit) throw new UserFacingError("Слишком много попыток. Повторите через 15 минут.");
}
export async function requestIdentifier() {
  if (process.env.TRUST_PROXY !== "true") return "shared";
  return (await headers()).get("x-real-ip")?.slice(0, 64) || "shared";
}
export async function createSession(userId: string, expectedPasswordHash: string) {
  const jar = await cookies();
  const old = jar.get(SESSION_COOKIE)?.value;
  const token = newToken();
  const expiresAt = new Date(Date.now() + 7 * 86400_000);
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    if (user.passwordHash !== expectedPasswordHash) throw new UserFacingError("Пароль изменился. Войдите снова.");
    if (old) await tx.session.deleteMany({ where: { tokenHash: tokenHash(old) } });
    await tx.session.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
    await tx.session.create({ data: { tokenHash: tokenHash(token), userId, expiresAt } });
  });
  jar.set(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
  const cartToken = jar.get(CART_COOKIE)?.value;
  if (cartToken) {
    const cart = await db.cart.findUnique({ where: { tokenHash: tokenHash(cartToken) } });
    if (cart && !cart.userId && cart.expiresAt > new Date()) {
      const claimed = await db.cart.updateMany({ where: { id: cart.id, userId: null, expiresAt: { gt: new Date() } }, data: { userId } });
      if (!claimed.count) jar.delete(CART_COOKIE);
    } else if (cart?.userId !== userId) jar.delete(CART_COOKIE);
  }
}
