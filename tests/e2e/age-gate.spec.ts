import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("age confirmation blocks direct entry and survives navigation and reload", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  await page.goto("/catalog?category=vapes");
  const dialog = page.getByRole("dialog", { name: "Вам уже исполнилось 18 лет?" });
  const confirm = dialog.getByRole("button", { name: "Мне есть 18 лет — войти" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("main")).toBeHidden();
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("main")).toBeVisible();
  const category = page.getByRole("navigation", { name: "Категории каталога" }).getByRole("link", { name: "Электронные сигареты и вейпы" });
  await expect(category).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("main")).toBeVisible();
  await page.goto("/assortment");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator('main a[href="/catalog?category=vapes"]').click();
  await expect(category).toHaveAttribute("aria-current", "page");
  expect(browserErrors).toEqual([]);
});

test("age confirmation fits a small screen and is accessible", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
});

test("confirmation works when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("Storage blocked", "SecurityError"); } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Мне есть 18 лет — войти" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("main")).toBeVisible();
});
