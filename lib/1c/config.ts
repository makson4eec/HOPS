import "server-only";
import { OneCError } from "./errors";

export function parseIds(value = ""): string[] {
  const ids = [...new Set(value.split(",").map(id => id.trim()).filter(Boolean))];
  if (ids.length > 5000 || ids.some(id => id.length > 200 || /[\u0000-\u001f]/.test(id))) {
    throw new OneCError("INVALID_ALLOWED_IDS", 503);
  }
  return ids;
}

export function getOneCConfig(env: Record<string, string | undefined> = process.env) {
  return {
    apiUrl: env.ONE_C_API_URL?.trim() || "",
    apiKey: env.ONE_C_API_KEY?.trim() || "",
    login: env.ONE_C_LOGIN || "",
    password: env.ONE_C_PASSWORD || "",
    allowedCategoryIds: parseIds(env.ONE_C_ALLOWED_CATEGORY_IDS),
    allowedProductIds: parseIds(env.ONE_C_ALLOWED_PRODUCT_IDS),
    syncSecret: env.ONE_C_SYNC_SECRET || "",
    useMock: env.ONE_C_USE_MOCK === "true",
  };
}
export type OneCConfig = ReturnType<typeof getOneCConfig>;

export function validateOneCConfig(config: OneCConfig): void {
  if (config.useMock) return;
  let url: URL;
  try { url = new URL(config.apiUrl); } catch { throw new OneCError("API_URL_NOT_CONFIGURED", 503); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new OneCError("INVALID_API_URL", 503);
  }
  if (!config.apiKey && (Boolean(config.login) !== Boolean(config.password) || config.login.includes(":"))) {
    throw new OneCError("INCOMPLETE_BASIC_AUTH", 503);
  }
  if (/[\r\n]/.test(config.apiKey)) throw new OneCError("INVALID_API_KEY", 503);
}

export function isAllowed(product: { externalId: string; categoryId: string }, config: OneCConfig): boolean {
  return config.allowedCategoryIds.includes(product.categoryId) || config.allowedProductIds.includes(product.externalId);
}
