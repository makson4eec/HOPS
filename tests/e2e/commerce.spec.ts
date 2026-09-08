import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "../../lib/security";

test("admin publication, pickup checkout, moderation, fulfillment and manual exchange", async ({ browser, page }) => {
  test.setTimeout(120_000);
  test.skip(!process.env.TEST_DATABASE_URL, "Commerce fixtures require a disposable hops_test database");
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  const appUrl = new URL(process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000");
  expect(testUrl.pathname, "Never create technical products in a real store database").toBe("/hops_test");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(appUrl.hostname);
  expect(process.env.DATABASE_URL, "The browser server must use the same disposable test database").toBe(process.env.TEST_DATABASE_URL);

  const db = new PrismaClient({ datasourceUrl: testUrl.toString() });
  const tag = `e2e-commerce-${randomUUID()}`;
  const password = `Only-for-test-${randomUUID()}!`;
  const userIds: string[] = [];
  const manualJobIds: string[] = [];
  let warehouseId = "";
  const adminContext = await browser.newContext({ baseURL: appUrl.origin, locale: "ru-RU", timezoneId: "Europe/Moscow" });
  const adminPage = await adminContext.newPage();

  async function login(target: Page, email: string) {
    await target.goto("/account");
    await target.locator("#login-email").fill(email);
    await target.locator("#login-password").fill(password);
    await target.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(target.getByRole("button", { name: "Выйти", exact: true })).toBeVisible();
  }

  try {
    const passwordHash = await hashPassword(password);
    const admin = await db.user.create({ data: { email: `${tag}-admin@example.invalid`, name: "Техническая проверка администратора", role: "ADMIN", passwordHash } });
    userIds.push(admin.id);
    const customer = await db.user.create({ data: { email: `${tag}-customer@example.invalid`, name: "Техническая проверка покупателя", passwordHash } });
    userIds.push(customer.id);
    warehouseId = (await db.warehouse.create({ data: { name: `${tag} — тестовый пункт`, address: "Технический адрес изолированной проверки", pickupEnabled: true } })).id;

    await test.step("Admin creates and publishes a technical product through the real form", async () => {
      await login(adminPage, admin.email);
      await adminPage.goto("/admin?tab=products&edit=new");
      const form = adminPage.locator("form").filter({ has: adminPage.getByRole("button", { name: "Сохранить товар", exact: true }) });
      await form.getByLabel("Название", { exact: true }).fill(tag);
      await form.getByLabel("Артикул", { exact: true }).fill(tag);
      await form.getByLabel("Адрес страницы (латиница)", { exact: true }).fill(tag);
      await form.getByRole("combobox", { name: "Категория", exact: true }).selectOption("snacks");
      await form.getByLabel("Цена, ₽", { exact: true }).fill("123.45");
      await form.getByLabel("Описание", { exact: true }).fill("Техническая запись для проверки магазина. Удаляется после теста.");
      await form.getByRole("combobox", { name: "Склад для изменения остатка", exact: true }).selectOption(warehouseId);
      await form.getByLabel("Физический остаток, шт.", { exact: true }).fill("5");
      await form.getByRole("combobox", { name: "Публикация", exact: true }).selectOption("PUBLISHED");
      await form.getByRole("button", { name: "Сохранить товар", exact: true }).click();
      await expect(form.getByRole("status")).toHaveText("Изменения сохранены.");
      await expect.poll(() => db.product.count({ where: { sku: tag, status: "PUBLISHED", price: 12345 } })).toBe(1);
    });

    const product = await db.product.findUniqueOrThrow({ where: { sku: tag } });
    await test.step("Customer orders two units for pickup at the selected warehouse", async () => {
      await login(page, customer.email);
      await page.goto(`/catalog/${product.slug}`);
      await expect(page.getByRole("heading", { name: tag, exact: true })).toBeVisible();
      await page.locator("#product-quantity").fill("2");
      await page.getByRole("button", { name: "Добавить в корзину", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Товар добавлен в корзину." })).toBeVisible();
      await page.goto("/cart");
      await expect(page.locator('main input[name="quantity"]:not([type="hidden"])')).toHaveValue("2");
      await page.getByRole("link", { name: "Оформить самовывоз", exact: true }).click();
      await page.locator("#checkout-phone").fill("+79990000111");
      await page.locator("#checkout-warehouse").selectOption(warehouseId);
      const settings = await db.shopSettings.findUniqueOrThrow({ where: { id: "main" } });
      const tomorrow = new Intl.DateTimeFormat("sv-SE", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86400_000));
      const hour = Math.min(settings.pickupOpen + 1, settings.pickupClose - 1);
      await page.locator("#checkout-time").fill(`${tomorrow}T${String(hour).padStart(2, "0")}:00`);
      await page.locator('main input[name="consent"]').check();
      await page.getByRole("button", { name: "Подтвердить самовывоз", exact: true }).click();
      await expect(page).toHaveURL(/\/orders(?:\?|$)/);
      await expect.poll(() => db.order.count({ where: { userId: customer.id } })).toBe(1);
    });

    const order = await db.order.findFirstOrThrow({ where: { userId: customer.id }, include: { items: true } });
    expect(order.total).toBe(24690);
    expect(order.warehouseId).toBe(warehouseId);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(2);
    expect((await db.inventory.findUniqueOrThrow({ where: { productId_warehouseId: { productId: product.id, warehouseId } } })).reserved).toBe(2);
    await expect(page.locator(`#order-${order.number}`)).toContainText("Новый");

    const reviewText = `Техническая проверка модерации ${tag}. Запись будет удалена после теста.`;
    await test.step("Review is private until an administrator publishes it", async () => {
      await page.goto("/reviews");
      await page.locator("#review-text").fill(reviewText);
      await page.locator('main input[name="consent"]').check();
      await page.getByRole("button", { name: "Отправить отзыв", exact: true }).click();
      await expect.poll(() => db.review.count({ where: { userId: customer.id, text: reviewText, status: "PENDING" } })).toBe(1);
      await page.reload();
      await expect(page.locator(".review-card").filter({ hasText: reviewText })).toHaveCount(0);
      await adminPage.goto("/admin?tab=reviews");
      const review = adminPage.locator("article").filter({ hasText: reviewText });
      await review.getByRole("combobox", { name: "Модерация", exact: true }).selectOption("APPROVED");
      await review.getByRole("button", { name: "Сохранить решение", exact: true }).click();
      await expect.poll(() => db.review.count({ where: { userId: customer.id, status: "APPROVED" } })).toBe(1);
      await page.reload();
      await expect(page.locator(".review-card").filter({ hasText: reviewText })).toBeVisible();
    });

    await test.step("Administrator fulfills the order and the customer sees the new status", async () => {
      for (const status of ["CONFIRMED", "PREPARING", "READY", "COMPLETED"] as const) {
        await adminPage.goto("/admin?tab=orders");
        const orderCard = adminPage.locator("article").filter({ has: adminPage.getByRole("heading", { name: `Заказ H-${order.number}`, exact: true }) });
        await orderCard.locator('select[name="status"]').selectOption(status);
        await orderCard.getByRole("button", { name: "Обновить статус", exact: true }).click();
        await expect.poll(async () => (await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(status);
      }
      await page.goto("/orders");
      await expect(page.locator(`#order-${order.number}`)).toContainText("Выдан");
      const inventory = await db.inventory.findUniqueOrThrow({ where: { productId_warehouseId: { productId: product.id, warehouseId } } });
      expect(inventory.quantity).toBe(3);
      expect(inventory.reserved).toBe(0);
      expect(await db.syncJob.count({ where: { kind: "ORDER_EXPORT", dedupeKey: { startsWith: `order:${order.id}:` } } })).toBe(5);
    });

    await test.step("Administrator queues exchange and retries a failed job", async () => {
      const priorIds = (await db.syncJob.findMany({ where: { kind: "CATALOG_IMPORT" }, select: { id: true } })).map((job) => job.id);
      await adminPage.goto("/admin?tab=sync");
      await adminPage.getByRole("button", { name: "Загрузить каталог и остатки", exact: true }).click();
      await expect.poll(() => db.auditLog.count({ where: { actorId: admin.id, action: "SYNC_MANUAL" } })).toBeGreaterThan(0);
      const newJobs = await db.syncJob.findMany({ where: { kind: "CATALOG_IMPORT", id: { notIn: priorIds } }, select: { id: true } });
      manualJobIds.push(...newJobs.map((job) => job.id));
      await expect(adminPage.getByRole("heading", { name: "CATALOG_IMPORT", exact: true }).first()).toBeVisible();
      const failed = await db.syncJob.create({ data: { kind: "CATALOG_IMPORT", dedupeKey: `test:${tag}`, status: "FAILED", attempts: 1, payload: {}, error: tag } });
      manualJobIds.push(failed.id);
      await adminPage.reload();
      const failedCard = adminPage.locator("article").filter({ hasText: tag });
      await failedCard.getByRole("button", { name: "Повторить обмен", exact: true }).click();
      await expect.poll(() => db.syncLog.count({ where: { jobId: failed.id, message: "MANUAL_RETRY_QUEUED" } })).toBe(1);
      expect(await db.product.count({ where: { sku: tag } })).toBe(1);
    });
  } finally {
    await adminContext.close();
    const orders = await db.order.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    await db.syncJob.deleteMany({ where: { OR: [{ id: { in: manualJobIds } }, ...orders.map((order) => ({ dedupeKey: { startsWith: `order:${order.id}:` } }))] } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.order.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.product.deleteMany({ where: { sku: tag } });
    if (warehouseId) await db.warehouse.delete({ where: { id: warehouseId } });
    await db.$disconnect();
  }
});
