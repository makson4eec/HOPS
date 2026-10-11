import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

// A separate development cluster; never reuse the disposable E2E database.
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const directory = resolve(".local-db");
const data = join(directory, "data");
const suffix = process.platform === "win32" ? ".exe" : "";
const bundledBin = resolve(".tools/postgres/package/native/bin");
const bin = process.env.POSTGRES_BIN || (existsSync(bundledBin) ? bundledBin : "");
const executable = name => bin ? join(bin, name + suffix) : name + suffix;

function run(command, args, quiet = false) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, windowsHide: true, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Не удалось выполнить ${command}. Проверьте установку PostgreSQL и .local-db/postgres.log.`);
  return result;
}

async function main() {
  run(executable("initdb"), ["--version"]);
  if (existsSync(".env.local") || existsSync(".env.development") || existsSync(".env.development.local")) {
    throw new Error("Найдены дополнительные .env-файлы Next.js. Настройте базу вручную, чтобы не изменить существующее подключение.");
  }
  if (existsSync(".env")) process.loadEnvFile(".env");
  let databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const configured = new URL(databaseUrl);
    if (configured.protocol !== "postgresql:" || configured.hostname !== "127.0.0.1" || configured.port !== "55433" || configured.pathname !== "/hops" || configured.username !== "hops") {
      throw new Error("DATABASE_URL уже указывает на другую базу. Локальная настройка остановлена; существующее подключение сохранено.");
    }
  } else {
    if (existsSync(".env") || existsSync(join(data, "PG_VERSION"))) {
      throw new Error("Восстановите DATABASE_URL в .env для существующей локальной базы.");
    }
    databaseUrl = `postgresql://hops:${randomBytes(32).toString("hex")}@127.0.0.1:55433/hops?schema=public`;
  }
  mkdirSync(directory, { recursive: true });
  if (!existsSync(join(data, "PG_VERSION"))) {
    const passwordFile = join(directory, "init-password");
    writeFileSync(passwordFile, decodeURIComponent(new URL(databaseUrl).password), { mode: 0o600 });
    try {
      run(executable("initdb"), ["-D", data, "-U", "hops", "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", `--pwfile=${passwordFile}`]);
    } finally { unlinkSync(passwordFile); }
  }
  if (!existsSync(".env")) {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    const example = readFileSync(".env.example", "utf8")
      .replace(/^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${password}`)
      .replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${databaseUrl}`);
    writeFileSync(".env", example, { flag: "wx", mode: 0o600 });
    process.loadEnvFile(".env");
  }
  process.env.DATABASE_URL = databaseUrl;
  const status = spawnSync(executable("pg_ctl"), ["status", "-D", data], { windowsHide: true, stdio: "ignore" });
  if (status.status !== 0) {
    run(executable("pg_ctl"), ["start", "-D", data, "-l", join(directory, "postgres.log"), "-o", "-h 127.0.0.1 -p 55433", "-w", "-t", "30"]);
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const db = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    const existing = await db.$queryRaw`SELECT 1 FROM pg_database WHERE datname = 'hops'`;
    if (!existing.length) await db.$executeRawUnsafe('CREATE DATABASE "hops"');
  } finally { await db.$disconnect(); }
  run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  run(process.execPath, ["--import", "tsx", "prisma/seed.ts"]);
  console.log("Локальная база готова (127.0.0.1:55433). Теперь запустите npm run dev.");
}

main().catch(error => {
  // Never print a database URL or generated password.
  console.error(error instanceof Error && !error.message.includes("postgresql://") ? error.message : "Не удалось подготовить локальную базу.");
  process.exitCode = 1;
});
