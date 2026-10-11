import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
function fixture(mode: string) {
  execFileSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "tests/fixtures/commerce.ts", mode], { env: { ...process.env, HOPS_DATA_DIR: process.env.HOPS_DATA_DIR || path.resolve(".test-data/e2e") }, windowsHide: true });
}
test.beforeAll(() => { if (process.env.HOPS_E2E_LOCAL === "true") { fixture("reset"); fixture("setup"); } });
test.afterAll(() => { if (process.env.HOPS_E2E_LOCAL === "true") fixture("reset"); });
test("JSON catalog, pickup, reviews, admin and private loyalty work together", async ({ page, context, browser }) => {
  test.skip(process.env.HOPS_E2E_LOCAL !== "true", "Requires isolated local server");
  test.setTimeout(60000);
  await context.addInitScript(() => sessionStorage.setItem("hops_age_confirmed", "true"));
  await page.goto("/account");
  await page.locator("#login-email").fill("commerce@example.test");
  await page.locator("#login-password").fill("e2e-shop-passphrase");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  await page.goto("/loyalty");
  await expect(page.locator(".balance-card strong")).toHaveText("111 Б");
  await expect(page.locator("main")).toContainText("Только личная операция");
  await expect(page.locator("main")).not.toContainText("999");
  await page.goto("/catalog?q=e2e");
  await expect(page.getByRole("button", { name: "Покупка в магазине" })).toBeDisabled();
  await page.locator(".product-card").filter({ hasText: "e2e-snacks" }).getByRole("button", { name: "В корзину" }).click();
  await expect(page.getByRole("link", { name: "Корзина, товаров: 1", exact: true })).toBeVisible();
  await page.goto("/cart");
  await expect(page.locator("main")).toContainText("e2e-snacks");
  await page.getByRole("link", { name: "Оформить самовывоз" }).click();
  await page.locator("#checkout-phone").fill("+79991234567");
  const wall = new Date(Date.now() + 5 * 3600000 + 3600000);
  if (wall.getUTCHours() < 11) wall.setUTCHours(11, 0, 0, 0);
  if (wall.getUTCHours() >= 23) { wall.setUTCDate(wall.getUTCDate() + 1); wall.setUTCHours(11, 0, 0, 0); }
  wall.setUTCMinutes(Math.ceil(wall.getUTCMinutes() / 15) * 15, 0, 0);
  await page.locator("#checkout-time").fill(wall.toISOString().slice(0, 16));
  await page.locator('main input[name="consent"]').check();
  await page.getByRole("button", { name: "Подтвердить самовывоз" }).click();
  await expect(page).toHaveURL(/\/orders\?order=/);
  await expect(page.locator("main")).toContainText("e2e-snacks");
  await page.goto("/reviews");
  await page.locator("#review-text").fill("Отзыв о проверке локального JSON магазина");
  await page.locator('main input[name="consent"]').check();
  await page.getByRole("button", { name: "Отправить отзыв" }).click();
  await expect(page.locator("main").getByRole("status")).toContainText("отправлен");
  const staff = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000" });
  try {
    await staff.addInitScript(() => sessionStorage.setItem("hops_age_confirmed", "true"));
    const admin = await staff.newPage(); await admin.goto("/account");
    await admin.locator("#login-email").fill("commerce-admin@example.test");
    await admin.locator("#login-password").fill("e2e-shop-passphrase");
    await admin.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(admin.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
    await admin.goto("/admin?tab=orders");
    await expect(admin.locator("main")).toContainText("e2e-snacks");
    await admin.goto("/admin?tab=reviews");
    await admin.locator('main select[name="status"]').selectOption("APPROVED");
    await admin.getByRole("button", { name: "Сохранить решение" }).click();
    await expect(admin.locator("main").getByRole("status")).toContainText("сохранены");
    await page.goto("/reviews");
    await expect(page.locator(".review-card")).toContainText("Отзыв о проверке");
    await admin.goto("/admin?tab=sync");
    await expect(admin.locator("main")).toContainText("Локальная синхронизация");
    await admin.goto("/admin?tab=settings");
    await expect(admin.locator('textarea[name="loyaltyRules"]')).toBeVisible();
  } finally { await staff.close(); }
});
