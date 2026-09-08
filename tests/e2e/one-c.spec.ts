import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

test("1C authenticated mock sync populates the existing catalog and hides inactive products", async ({ page, request }) => {
  test.skip(process.env.ONE_C_USE_MOCK !== "true" || !process.env.TEST_DATABASE_URL || !process.env.ONE_C_SYNC_SECRET, "Requires a mock-configured server and an isolated hops_test schema");
  const url = new URL(process.env.TEST_DATABASE_URL!);
  expect(url.pathname).toBe("/hops_test");
  expect(url.searchParams.get("schema")).toMatch(/^hops_one_c_e2e_[a-f0-9]{32}$/);
  expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  const db = new PrismaClient();
  const headers = { Authorization: `Bearer ${process.env.ONE_C_SYNC_SECRET}` };
  try {
    const health = await request.get("/api/1c/sync");
    expect(health.status()).toBe(200);
    const readiness = await health.json();
    expect(readiness).toMatchObject({ ready: true, mock: true, databaseAvailable: true });
    expect(Object.values(readiness).every(value => typeof value === "boolean")).toBe(true);
    expect((await request.post("/api/1c/sync")).status()).toBe(401);
    expect((await request.post("/api/1c/sync", { headers: { Authorization: "Bearer incorrect" } })).status()).toBe(401);
    const first = await request.post("/api/1c/sync", { headers });
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ received: 4, allowed: 3, created: 3, updated: 0, disabled: 0, errors: [] });
    const second = await request.post("/api/1c/sync", { headers });
    expect(second.status()).toBe(200);
    expect(await second.json()).toEqual({ received: 4, allowed: 3, created: 0, updated: 3, disabled: 0, errors: [] });

    await page.goto("/catalog");
    await expect(page.locator(".product-card")).toHaveCount(3);
    await expect(page.locator(".product-card .status.out")).toHaveCount(2);
    await expect(page.getByText("Товар из закрытой категории", { exact: true })).toHaveCount(0);
    const beer = page.locator(".product-card").filter({ hasText: "Тестовое пиво HOPS" });
    await expect(beer.getByText("В наличии", { exact: true })).toBeVisible();
    await expect(beer.getByRole("button", { name: "В корзину", exact: true })).toBeEnabled();
    await expect(beer.locator(".price")).toContainText("199,90");
    const product = await db.product.findUniqueOrThrow({ where: { externalId: "mock-101" } });
    await page.goto(`/catalog/${product.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: product.name })).toBeVisible();
    await db.product.update({ where: { id: product.id }, data: { isActive: false } });
    await page.goto("/catalog");
    await expect(page.locator(".product-card")).toHaveCount(2);
    // Next streams the layout with HTTP 200 before notFound resolves the product.
    await page.goto(`/catalog/${product.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: "Страница не найдена" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: product.name })).toHaveCount(0);
    expect(await (await request.get("/sitemap.xml")).text()).not.toContain(product.slug);
    await page.goto("/catalog");
    await expect(page.locator("body")).not.toContainText(process.env.ONE_C_SYNC_SECRET!);
    await page.setViewportSize({ width: 375, height: 812 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await db.$disconnect(); }
});
