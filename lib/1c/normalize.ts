import { z } from "zod";
import { OneCError } from "./errors";

// Adapt this block to the real JSON contract. Prices here are RUB, stock is
// physical whole units (before this website's reservations), feed is a FULL snapshot.
const fields = {
  externalId: ["externalId", "external_id", "id", "Ref_Key", "Ссылка"],
  name: ["name", "Наименование", "Description"],
  categoryId: ["categoryId", "category_id", "Parent_Key", "Категория"],
  sku: ["sku", "Артикул"], barcode: ["barcode", "Штрихкод"],
  price: ["price", "Цена"], stock: ["stock", "Остаток"],
  imageUrl: ["imageUrl", "image_url", "Изображение"],
  description: ["description", "Описание"], volume: ["volume", "Объем"],
  country: ["country", "Страна"], manufacturer: ["manufacturer", "Производитель"],
  alcohol: ["alcohol", "Крепость"],
} as const;

// Optional mapping of 1C IDs to the existing website's category IDs.
// Unmapped IDs remain visible under "Все товары"; allow-listing always uses the original ID.
const websiteCategories: Record<string, string> = {
  "mock-beer": "kvass", "mock-lemonade": "lemonade", "mock-snacks": "snacks",
};
export function websiteCategory(categoryId: string): string { return websiteCategories[categoryId] ?? categoryId; }

export function extractOneCProducts(payload: unknown): unknown[] {
  let records: unknown = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const data = payload as Record<string, unknown>;
    if (data.success === false || data.error || (Array.isArray(data.errors) && data.errors.length)) {
      throw new OneCError("ONE_C_INVALID_CATALOG");
    }
    // Never treat a known partial/page response as a complete catalog.
    if (data.hasMore || data.next || data.nextLink || data["@odata.nextLink"] || data["odata.nextLink"] || data.complete === false) {
      throw new OneCError("ONE_C_FULL_SNAPSHOT_REQUIRED");
    }
    records = data.products ?? data.items ?? data.value;
    const total = data.total ?? data["@odata.count"];
    if (total !== undefined && (!Array.isArray(records) || Number(total) !== records.length)) {
      throw new OneCError("ONE_C_FULL_SNAPSHOT_REQUIRED");
    }
  }
  if (!Array.isArray(records) || records.length > 5000) throw new OneCError("ONE_C_INVALID_CATALOG");
  return records;
}
// End of API-specific mapping.

function asText(value: unknown): unknown {
  if (value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" ? value.trim() : value;
}
function asNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cleaned = value.trim().replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? Number(cleaned) : value;
}
const text = (max: number) => z.preprocess(asText, z.string().min(1).max(max));
const optionalText = (max: number) => z.preprocess(asText, z.string().max(max).optional());
const imageUrl = optionalText(2048).refine(value => {
  if (!value) return true;
  if (/^\/images\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|avif)$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
});
const productSchema = z.object({
  externalId: text(200), name: text(250), categoryId: text(200),
  sku: optionalText(100), barcode: optionalText(100),
  price: z.preprocess(asNumber, z.number().finite().min(0).max(20_000_000)),
  stock: z.preprocess(asNumber, z.number().int().min(-1_000_000).max(1_000_000)).transform(value => Math.max(0, value)),
  imageUrl, description: optionalText(20_000), volume: optionalText(100),
  country: optionalText(200), manufacturer: optionalText(250), alcohol: optionalText(100),
});
export type OneCProduct = z.infer<typeof productSchema>;

export function normalizeOneCProduct(raw: unknown): OneCProduct {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OneCError("ONE_C_INVALID_PRODUCT");
  const row = raw as Record<string, unknown>;
  const mapped = Object.fromEntries(Object.entries(fields).map(([key, aliases]) => {
    const alias = aliases.find(name => Object.hasOwn(row, name));
    return [key, alias === undefined ? undefined : row[alias]];
  }));
  const parsed = productSchema.safeParse(mapped);
  if (!parsed.success) throw new OneCError("ONE_C_INVALID_PRODUCT");
  return parsed.data;
}
