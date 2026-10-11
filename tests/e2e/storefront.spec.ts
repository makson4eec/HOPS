import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const publicRoutes = ["/", "/catalog", "/assortment", "/availability", "/pickup", "/about", "/contacts", "/reviews", "/legal", "/cart", "/account", "/orders", "/checkout", "/loyalty"];

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => sessionStorage.setItem("hops_age_confirmed", "true"));
});

for (const route of publicRoutes) {
  test(`public page ${route} renders and has a title`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page).toHaveTitle(/HOPS/i);
    await expect(page.locator('a[href^="tel:"], a[href^="mailto:"]')).toHaveCount(0);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /width=device-width/);
  });
}

test("empty catalog has no invented product cards", async ({ page }) => {
  await page.goto("/catalog");
  await expect(page.locator('main a[href^="/catalog/"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /в корзину/i })).toHaveCount(0);
  await expect(page.locator("main")).toContainText(/пока|пуст|нет товаров|готовится к открытию/i);
});

test("store location and daily opening hours replace store contact details", async ({ page }) => {
  await page.goto("/contacts");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Как нас найти");
  await expect(page.locator("main")).toContainText("г. Екатеринбург, ул. Библиотечная, 43");
  await expect(page.locator("main")).toContainText("Пн–Пт: 11:00–00:00");
  await expect(page.locator("main")).toContainText("Сб–Вс: 11:00–00:00");
  await expect(page.locator('main a[href^="https://yandex.ru/maps/"]')).toHaveAttribute("href", `https://yandex.ru/maps/?text=${encodeURIComponent("г. Екатеринбург, ул. Библиотечная, 43")}`);
  await expect(page.locator('a[href^="tel:"], a[href^="mailto:"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Складочная");
  await expect(page.locator("body")).not.toContainText("hallo@hops-store.ru");
});

test("unknown product has a missing-page state", async ({ page }) => {
  await page.goto("/catalog/missing-product-e2e");
  await expect(page.locator("main")).toContainText(/не найдена|не найден|404/i);
});

test("private routes and admin require authentication", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/account(?:\?|$)/);
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  await page.goto("/orders");
  await expect(page.locator("main")).toContainText("Войдите в личный кабинет");
  await page.goto("/checkout");
  await expect(page.getByRole("button", { name: "Подтвердить самовывоз", exact: true })).toHaveCount(0);
});

test("security headers and health endpoint", async ({ request }) => {
  const response = await request.get("/");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-powered-by"]).toBeUndefined();
  expect((await request.get("/api/health")).ok()).toBeTruthy();
  expect((await request.get("/robots.txt")).ok()).toBeTruthy();
  expect((await request.get("/sitemap.xml")).ok()).toBeTruthy();
});

for (const width of [320, 375, 768]) {
  test(`mobile pages fit ${width}px and navigation works`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ["/", "/catalog", "/cart", "/account", "/contacts", "/reviews", "/legal"]) {
      await page.goto(route);
      const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
      expect(layout.scrollWidth, `${route} must not overflow at ${width}px`).toBeLessThanOrEqual(layout.width);
    }
    await page.goto("/");
    const menu = page.locator('button[aria-controls="mobile-nav"]');
    if (await menu.isVisible()) {
      await menu.click();
      await expect(menu).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toBeFocused();
    }
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), fullPage: true });
  });
}

for (const route of ["/", "/catalog", "/account", "/reviews", "/contacts"]) {
  test(`accessibility ${route}`, async ({ page }) => {
    await page.goto(route);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
  });
}

test("rejected login preserves email and clears the password", async ({ page }) => {
  const email = `missing-${randomUUID()}@example.invalid`;
  await page.goto("/account");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(`Invalid-${randomUUID()}`);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Неверный email или пароль");
  await expect(page.locator("#login-email")).toHaveValue(email);
  await expect(page.locator("#login-password")).toHaveValue("");
});

test("customer registration, chosen password length, login and revocation", async ({ page, context }) => {
  test.skip(process.env.HOPS_E2E_LOCAL !== "true", "Write scenarios require the isolated local test server");
  test.setTimeout(60_000);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000").hostname);
  const email = `e2e-${randomUUID()}@example.invalid`;
  const password = "1";
  await page.goto("/account");
  const registration = page.locator("form").filter({ has: page.getByRole("button", { name: "Создать аккаунт", exact: true }) });
  await registration.getByLabel("Имя", { exact: true }).fill("Проверка E2E");
  await registration.locator("#register-email").fill(email);
  await registration.getByLabel("Придумайте пароль", { exact: true }).fill(password);
  await registration.locator('input[name="consent"]').check();
  await registration.getByRole("button", { name: "Создать аккаунт", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  const session = (await context.cookies()).find(({ name }) => name === "hops_session");
  expect(session).toBeDefined();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  expect(session?.value.length).toBeGreaterThan(30);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/account(?:\?|$)/);
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  expect((await context.cookies()).find(({ name }) => name === "hops_session")).toBeUndefined();
  // A copied cookie must stop working after server-side logout.
  if (session) await context.addCookies([session]);
  await page.goto("/account");
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  await page.locator("#login-email").fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  expect((await context.cookies()).find(({ name }) => name === "hops_session")?.value).not.toBe(session?.value);
  const longPassword = "я".repeat(256);
  await page.locator("#account-current-password").fill(password);
  await page.locator("#account-new-password").fill(longPassword);
  await page.getByRole("button", { name: "Сменить пароль", exact: true }).click();
  await expect(page.locator("main").getByRole("status")).toContainText("Пароль изменён");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(longPassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  await page.locator("#account-current-password").fill(longPassword);
  await page.locator("#account-new-password").fill(password);
  await page.getByRole("button", { name: "Сменить пароль", exact: true }).click();
  await expect(page.locator("main").getByRole("status")).toContainText("Пароль изменён");
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page.getByRole("button", { name: "Войти", exact: true })).toBeVisible();
});
