import { db } from "../lib/db";
import { hashPassword } from "../lib/security";
import { z } from "zod";

async function main() {
  const email = z.email().max(254).parse(process.env.ADMIN_EMAIL?.trim().toLowerCase());
  const password = z.string().min(16).max(128).parse(process.env.ADMIN_PASSWORD);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw new Error("Пользователь уже существует. Изменение прав через создание запрещено.");
  await db.user.create({ data: { email, passwordHash: await hashPassword(password), role: "ADMIN", name: "Администратор" } });
  console.log("Администратор создан. Удалите ADMIN_PASSWORD из окружения.");
}
main().catch(() => { console.error("Не удалось создать администратора. Нужны новый ADMIN_EMAIL и ADMIN_PASSWORD от 16 символов; проверьте базу и отсутствие дубликата."); process.exitCode = 1; }).finally(() => db.$disconnect());
