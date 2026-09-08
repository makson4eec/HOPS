import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export class UserFacingError extends Error {}
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, hash] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}
export function safeNext(value: FormDataEntryValue | null) {
  const next = typeof value === "string" ? value : "/account";
  return /^\/(?:account|admin|orders|checkout|cart|loyalty)(?:\/|\?|$)/.test(next) && !next.includes("\\") ? next : "/account";
}
export function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return `+7${digits.slice(1)}`;
  throw new UserFacingError("Введите российский номер телефона: +7 и ещё 10 цифр.");
}
export function parsePrice(value: string) {
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(value)) throw new UserFacingError("Укажите цену в рублях, не более двух знаков после запятой.");
  const [rubles, kopecks = ""] = value.replace(",", ".").split(".");
  return Number(rubles) * 100 + Number(kopecks.padEnd(2, "0"));
}
