import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => sessionStorage.setItem("hops_age_confirmed", "true"));
});

test("beer sections nest filtration under color and preserve search and sorting", async ({ page }) => {
  await page.goto("/catalog?category=beer&q=beer&sort=price-desc");
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
  await page.goto("/catalog?category=beer&color=invalid&filtration=filtered");
  await expect(colors.getByRole("link", { name: "Всё пиво", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(filtration).toHaveCount(0);
});
