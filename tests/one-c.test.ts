import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fetchOneCProducts } from "../lib/1c/client";
import { getOneCConfig, isAllowed, parseIds, validateOneCConfig } from "../lib/1c/config";
import { extractOneCProducts, normalizeOneCProduct } from "../lib/1c/normalize";
import { POST } from "../app/api/1c/sync/route";

test("1C allow lists use category/product IDs with OR and deny empty lists", () => {
  assert.deepEqual(parseIds(" 12, 15,,12, 027 "), ["12", "15", "027"]);
  const config = getOneCConfig({ ONE_C_ALLOWED_CATEGORY_IDS: "12", ONE_C_ALLOWED_PRODUCT_IDS: "special" });
  assert.equal(isAllowed({ externalId: "other", categoryId: "12" }, config), true);
  assert.equal(isAllowed({ externalId: "special", categoryId: "private" }, config), true);
  assert.equal(isAllowed({ externalId: "other", categoryId: "Пиво" }, config), false);
  assert.equal(isAllowed({ externalId: "special", categoryId: "12" }, getOneCConfig({})), false);
  assert.equal(isAllowed({ externalId: "other", categoryId: "12" }, { ...config, allowedProductIds: [] }), true);
});

test("1C normalization validates required fields, decimal RUB, aliases and stock", () => {
  const row = { Ref_Key: "001", Наименование: "Лимонад", Parent_Key: 12, Цена: "1 299,95", Остаток: -2, Штрихкод: "000123", Крепость: 0 };
  const product = normalizeOneCProduct(row);
  assert.equal(product.externalId, "001"); assert.equal(product.categoryId, "12");
  assert.equal(product.price, 1299.95); assert.equal(product.stock, 0);
  assert.equal(product.barcode, "000123"); assert.equal(product.alcohol, "0");
  for (const override of [{ Цена: "" }, { Цена: null }, { Цена: true }, { Цена: -1 }, { Цена: "NaN" }, { Остаток: 1.5 }, { Наименование: " " }, { Parent_Key: null }]) {
    assert.throws(() => normalizeOneCProduct({ ...row, ...override }), /ONE_C_INVALID_PRODUCT/);
  }
  assert.throws(() => normalizeOneCProduct({ ...row, imageUrl: "javascript:alert(1)" }));
  assert.throws(() => normalizeOneCProduct({ ...row, imageUrl: "https://user:password@example.test/img.jpg" }));
  assert.equal(normalizeOneCProduct({ ...row, imageUrl: "https://cdn.example.test/img.jpg" }).imageUrl, "https://cdn.example.test/img.jpg");
});

test("1C malformed and partial feeds cannot be interpreted as an empty snapshot", () => {
  for (const body of [{}, { error: "upstream failure" }, { products: [], success: false }, { products: [], error: "failed" }, { products: null }, { products: [], hasMore: true }, { value: [], "@odata.nextLink": "next" }, { items: [], total: 20 }, { products: [], complete: false }]) {
    assert.throws(() => extractOneCProducts(body));
  }
  assert.deepEqual(extractOneCProducts({ products: [] }), []);
  assert.deepEqual(extractOneCProducts({ value: [], "@odata.count": 0 }), []);
});

test("1C HTTP transport selects one auth method and rejects redirects/errors", async () => {
  let authorization: string | undefined;
  let status = 200;
  let body = '{"products":[]}';
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(status, { "Content-Type": "application/json", Location: "/elsewhere" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const config = getOneCConfig({ ONE_C_API_URL: `http://127.0.0.1:${address.port}/catalog` });
  try {
    await fetchOneCProducts({ ...config, apiKey: "test-key", login: "user", password: "pass" });
    assert.equal(authorization, "Bearer test-key");
    await fetchOneCProducts({ ...config, login: "user", password: "pass" });
    assert.equal(authorization, `Basic ${Buffer.from("user:pass").toString("base64")}`);
    await fetchOneCProducts(config); assert.equal(authorization, undefined);
    assert.throws(() => validateOneCConfig({ ...config, login: "user" }), /INCOMPLETE_BASIC_AUTH/);
    status = 302; await assert.rejects(fetchOneCProducts(config), /ONE_C_CONNECTION_FAILED/);
    status = 500; body = "PRIVATE_UPSTREAM_BODY";
    await assert.rejects(fetchOneCProducts(config), error => error instanceof Error && error.message === "ONE_C_HTTP_ERROR");
    status = 206; await assert.rejects(fetchOneCProducts(config), /ONE_C_HTTP_ERROR/);
    status = 200; body = "invalid json"; await assert.rejects(fetchOneCProducts(config), /ONE_C_INVALID_JSON/);
    body = "x".repeat(10 * 1024 * 1024 + 1); await assert.rejects(fetchOneCProducts(config), /ONE_C_RESPONSE_TOO_LARGE/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("1C mock passes through the real normalizer without network or credentials", async () => {
  const products = extractOneCProducts(await fetchOneCProducts(getOneCConfig({ ONE_C_USE_MOCK: "true" }))).map(normalizeOneCProduct);
  assert.equal(products.length, 4);
  assert.equal(products.filter(product => product.stock === 0).length, 2);
});

test("1C endpoint rejects missing/wrong auth and an unconfigured secret before any DB operation", async () => {
  const saved = process.env.ONE_C_SYNC_SECRET;
  try {
    process.env.ONE_C_SYNC_SECRET = "unit-test-only-secret";
    for (const authorization of ["", "Bearer wrong", "Basic unit-test-only-secret", "Bearer unit-test-only-secret-extra"]) {
      assert.equal((await POST(new Request("http://localhost/api/1c/sync", { method: "POST", headers: { authorization } }))).status, 401);
    }
    delete process.env.ONE_C_SYNC_SECRET;
    assert.equal((await POST(new Request("http://localhost/api/1c/sync", { method: "POST", headers: { authorization: "Bearer " } }))).status, 401);
  } finally {
    if (saved === undefined) delete process.env.ONE_C_SYNC_SECRET; else process.env.ONE_C_SYNC_SECRET = saved;
  }
});
