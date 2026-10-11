import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, newToken, normalizePhone, parsePrice, safeNext, tokenHash } from "../lib/security";
import { parsePickup, transitions } from "../lib/orders";
import { passwordSchema } from "../lib/password";

test("customers choose password length and characters without truncation", async () => {
  for (const password of ["1", "абв", "   ", "a".repeat(256)]) {
    assert.equal(passwordSchema.parse(password), password);
    const hash = await hashPassword(password);
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword(`${password}x`, hash), false);
  }
  assert.throws(() => passwordSchema.parse(""));
  assert.throws(() => passwordSchema.parse(null));
});

test("Yekaterinburg pickup stays open until midnight every day", () => {
  const now = new Date("2026-09-17T05:00:00Z");
  for (const day of [17, 18, 19, 20, 21, 22, 23]) {
    assert.equal(parsePickup(`2026-09-${day}T23:45`, "Asia/Yekaterinburg", 11, 24, now).toISOString(), `2026-09-${day}T18:45:00.000Z`);
  }
  assert.equal(parsePickup("2026-09-17T11:00", "Asia/Yekaterinburg", 11, 24, now).toISOString(), "2026-09-17T06:00:00.000Z");
  for (const value of ["2026-09-18T00:00", "2026-09-18T10:59"]) {
    assert.throws(() => parsePickup(value, "Asia/Yekaterinburg", 11, 24, now), /11:00 до 00:00/);
  }
});

test("password hashes use unique salts and reject invalid credentials", async () => {
  const first = await hashPassword("a-long-test-passphrase");
  const second = await hashPassword("a-long-test-passphrase");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a-long-test-passphrase", first), true);
  assert.equal(await verifyPassword("incorrect", first), false);
  assert.equal(await verifyPassword("incorrect", "not-a-hash"), false);
  assert.equal(await verifyPassword("incorrect", "scrypt:salt:abcd"), false);
});
test("opaque tokens are unique, stored as hashes, and redirects stay local", () => {
  const a = newToken(); const b = newToken();
  assert.notEqual(a, b); assert.equal(tokenHash(a).length, 64); assert.notEqual(tokenHash(a), a);
  for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", "/admin\\evil.example", "javascript:alert(1)", "/administrator"]) assert.equal(safeNext(unsafe), "/account");
  assert.equal(safeNext("/checkout"), "/checkout");
  assert.equal(safeNext("/admin?tab=orders"), "/admin?tab=orders");
});
test("prices stay exact in integer kopecks and input bounds reject negatives", () => {
  assert.equal(parsePrice("123.45"), 12345);
  assert.equal(parsePrice("10,5"), 1050);
  assert.equal(parsePrice("0"), 0);
  for (const value of ["-1", "1.999", "Infinity", "1e6", "10000000", "NaN"]) assert.throws(() => parsePrice(value));
  assert.equal(normalizePhone("8 (999) 123-45-67"), "+79991234567");
  assert.throws(() => normalizePhone("123"));
});
test("pickup is interpreted in store timezone and bounded by hours and future window", () => {
  const now = new Date("2026-09-04T08:00:00Z");
  assert.equal(parsePickup("2026-09-04T12:00", "Europe/Moscow", 11, 21, now).toISOString(), "2026-09-04T09:00:00.000Z");
  for (const value of ["2026-09-04T11:10", "2026-09-04T21:00", "2026-09-12T12:00", "2026-02-30T12:00", "invalid"]) assert.throws(() => parsePickup(value, "Europe/Moscow", 11, 21, now));
  assert.deepEqual(transitions.COMPLETED, []);
  assert.deepEqual(transitions.CANCELLED, []);
  assert.equal(transitions.NEW.includes("COMPLETED"), false);
});
