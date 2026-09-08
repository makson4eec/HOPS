import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getOneCConfig, validateOneCConfig } from "@/lib/1c/config";
import { OneCSyncError, syncOneCCatalog } from "@/lib/1c/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const secret = process.env.ONE_C_SYNC_SECRET;
  const expected = createHash("sha256").update(`Bearer ${secret ?? ""}`).digest();
  const supplied = createHash("sha256").update(request.headers.get("authorization") ?? "").digest();
  if (!secret || !timingSafeEqual(expected, supplied)) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
  try {
    const stats = await syncOneCCatalog();
    revalidatePath("/", "layout");
    return Response.json(stats, { headers });
  } catch (error) {
    if (error instanceof OneCSyncError) return Response.json(error.stats, { status: error.status, headers });
    return Response.json({ error: "SYNC_FAILED" }, { status: 503, headers });
  }
}

// Configuration readiness only; never contacts 1C or exposes URL/auth values.
export async function GET() {
  let configurationValid = false;
  let allowListConfigured = false;
  try {
    const config = getOneCConfig();
    validateOneCConfig(config);
    configurationValid = true;
    allowListConfigured = config.allowedCategoryIds.length + config.allowedProductIds.length > 0;
  } catch { /* Public health includes booleans only. */ }
  let databaseAvailable = false;
  let storeConfigured = false;
  try {
    await db.product.findFirst({ select: { externalId: true, categoryId: true, stock: true, isActive: true, source: true, barcode: true, country: true, manufacturer: true, alcohol: true } });
    storeConfigured = Boolean(await db.warehouse.findUnique({ where: { id: "hops-store" }, select: { id: true } }));
    databaseAvailable = true;
  } catch { /* Includes missing migrations. */ }
  const syncSecretConfigured = Boolean(process.env.ONE_C_SYNC_SECRET);
  const ready = configurationValid && databaseAvailable && storeConfigured && syncSecretConfigured && allowListConfigured;
  return Response.json({
    apiUrlConfigured: Boolean(process.env.ONE_C_API_URL?.trim()),
    mock: process.env.ONE_C_USE_MOCK === "true", databaseAvailable,
    storeConfigured, configurationValid, allowListConfigured, syncSecretConfigured, ready,
  }, { status: ready ? 200 : 503, headers });
}
