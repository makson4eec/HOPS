import type { MetadataRoute } from "next";
import { db } from "@/lib/db";
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const products = await db.product.findMany({ where: { status: "PUBLISHED", isActive: true }, select: { slug: true, updatedAt: true }, orderBy: { id: "asc" }, take: 49000 });
  const routes = ["", "/catalog", "/assortment", "/availability", "/pickup", "/about", "/contacts", "/reviews", "/legal"];
  return [...routes.map((route) => ({ url: `${base}${route}`, changeFrequency: "weekly" as const, priority: route === "" ? 1 : .7 })), ...products.map((product) => ({ url: `${base}/catalog/${product.slug}`, lastModified: product.updatedAt, changeFrequency: "daily" as const, priority: .6 }))];
}
