import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => sessionStorage.setItem("hops_age_confirmed", "true"));
});

test("beer sections nest filtration under color and preserve search and sorting", async ({ page }) => {
  await page.goto("/catalog?category=kvass&q=beer&sort=price-desc");
  const colors = page.getByRole("navigation", { name: "Цвет пива" });
  const filtration = page.getByRole("navigation", { name: "Фильтрация пива" });
  await expect(colors).toBeVisible();
  await expect(filtration).toHaveCount(0);
  for (const color of ["Светлое", "Тёмное"]) {
    await colors.getByRole("link", { name: color, exact: true }).click();
    await expect(colors.getByRole("link", { name: color, exact: true })).toHaveAttribute("aria-current", "page");
    for (const type of ["Фильтрованное", "Нефильтрованное"]) {
      await filtration.getByRole("link", { name: type, exact: true }).click();
      await expect(filtration.getByRole("link", { name: type, exact: true })).toHaveAttribute("aria-current", "page");
      expect(new URL(page.url()).searchParams.get("q")).toBe("beer");
      expect(new URL(page.url()).searchParams.get("sort")).toBe("price-desc");
    }
  }
  await page.locator("#catalog-sort").selectOption("price-asc");
  await page.getByRole("button", { name: "Найти", exact: true }).click();
  await expect(page).toHaveURL(/sort=price-asc/);
  expect(new URL(page.url()).searchParams.get("color")).toBe("dark");
  expect(new URL(page.url()).searchParams.get("filtration")).toBe("unfiltered");
  await page.reload();
  await expect(filtration.getByRole("link", { name: "Нефильтрованное", exact: true })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  await colors.getByRole("link", { name: "Светлое", exact: true }).click();
  await expect(colors.getByRole("link", { name: "Светлое", exact: true })).toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).searchParams.has("filtration")).toBe(false);
  await page.getByRole("navigation", { name: "Категории каталога" }).getByRole("link", { name: "Газировки", exact: true }).click();
  await expect(page).toHaveURL(/category=lemonade/);
  expect(new URL(page.url()).searchParams.has("color")).toBe(false);
  expect(new URL(page.url()).searchParams.has("filtration")).toBe(false);
  await expect(colors).toHaveCount(0);
  await expect(filtration).toHaveCount(0);
  await page.goto("/catalog?category=kvass&color=invalid&filtration=filtered");
  await expect(colors.getByRole("link", { name: "Всё пиво", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(filtration).toHaveCount(0);
});

test("beer sections filter actual products and keep filters across pagination", async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires the disposable hops_test database");
  const url = new URL(process.env.TEST_DATABASE_URL!);
  expect(url.pathname).toBe("/hops_test");
  expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000").hostname);
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  const tag = `e2e-beer-${randomUUID()}`;
  const rows = [
    ...Array.from({ length: 25 }, (_, index) => ({ suffix: `light-filtered-${index}`, beerColor: "light", beerFiltration: "filtered" })),
    { suffix: "light-unfiltered", beerColor: "light", beerFiltration: "unfiltered" },
    { suffix: "dark-filtered", beerColor: "dark", beerFiltration: "filtered" },
    { suffix: "dark-unfiltered", beerColor: "dark", beerFiltration: "unfiltered" },
    { suffix: "unclassified", beerColor: null, beerFiltration: null },
  ];
  try {
    await db.product.createMany({ data: rows.map(({ suffix, ...fields }, index) => ({ ...fields, sku: `${tag}-${suffix}`, slug: `${tag}-${suffix}`, name: `${tag}-${suffix}`, category: "kvass", price: 10000 + index, status: "PUBLISHED" })) });
    await db.product.createMany({ data: [
      { sku: `${tag}-draft`, slug: `${tag}-draft`, name: `${tag}-draft`, category: "kvass", beerColor: "dark", beerFiltration: "filtered", status: "DRAFT" },
      { sku: `${tag}-inactive`, slug: `${tag}-inactive`, name: `${tag}-inactive`, category: "kvass", beerColor: "dark", beerFiltration: "filtered", status: "PUBLISHED", isActive: false },
      { sku: `${tag}-snack`, slug: `${tag}-snack`, name: `${tag}-snack`, category: "snacks", beerColor: "dark", beerFiltration: "filtered", status: "PUBLISHED" },
    ] });
    await page.goto(`/catalog?category=kvass&q=${tag}&sort=price-asc&color=light&filtration=filtered`);
    await expect(page.locator(".product-card")).toHaveCount(24);
    await expect(page.locator("main")).toContainText("Найдено товаров: 25");
    await page.getByRole("link", { name: "Далее →", exact: true }).click();
    await expect(page.locator(".product-card")).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("color")).toBe("light");
    expect(new URL(page.url()).searchParams.get("filtration")).toBe("filtered");
    expect(new URL(page.url()).searchParams.get("q")).toBe(tag);
    await expect(page.locator(".product-card")).toContainText(`${tag}-light-filtered-24`);
    for (const [color, filtration] of [["light", "unfiltered"], ["dark", "filtered"], ["dark", "unfiltered"]]) {
      await page.goto(`/catalog?category=kvass&q=${tag}&color=${color}&filtration=${filtration}`);
      await expect(page.locator(".product-card")).toHaveCount(1);
      await expect(page.locator(".product-card")).toContainText(`${tag}-${color}-${filtration}`);
    }
    await page.goto(`/catalog?category=kvass&q=${tag}-unclassified`);
    await expect(page.locator(".product-card")).toHaveCount(1);
    await page.getByRole("navigation", { name: "Цвет пива" }).getByRole("link", { name: "Светлое", exact: true }).click();
    await expect(page.locator(".product-card")).toHaveCount(0);
  } finally {
    await db.product.deleteMany({ where: { sku: { startsWith: tag } } });
    await db.$disconnect();
  }
});
