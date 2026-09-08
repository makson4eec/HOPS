# Развёртывание HOPS

## Что подготовлено

Next.js собирается в standalone-образ. PostgreSQL 16 хранит данные в постоянном Docker volume. Сервис `migrator` применяет версионные миграции и повторяемый seed; после его успешного завершения запускаются `app` и `sync-worker`. Все Node.js контейнеры запускаются от непривилегированного пользователя. Исходные товары, клиенты и отзывы не генерируются.

На машине разработки Docker первоначально отсутствовал. Наличие Dockerfile не означает, что локальный запуск контейнеров был проверен: фактический результат указан в `docs/VERIFICATION.md`. GitHub Actions содержит отдельный проверочный запуск Compose.

## Первый запуск

Установите Docker Engine и Docker Compose v2 по [официальной инструкции Docker](https://docs.docker.com/engine/install/). Скопируйте репозиторий на сервер, перейдите в его корень и создайте `.env` из `.env.example`.

`POSTGRES_PASSWORD` обязателен. Используйте отдельный случайный пароль: например, `openssl rand -hex 32`. Для интерполяции в URL выбирайте URL-safe символы (hex подходит). Не используйте пробелы, `@`, `:`, `/`, `#` или `$` в переменных подключения. `POSTGRES_USER` и `POSTGRES_DB` по умолчанию равны `hops`. Compose сам формирует `DATABASE_URL` с внутренним именем `db`; строка из `.env` предназначена для npm-команд вне Docker.

Для локального HTTP:

```dotenv
APP_URL=http://localhost:3000
COOKIE_SECURE=false
BIND_ADDRESS=127.0.0.1
PORT=3000
ONE_C_MODE=test
```

После заполнения `.env` запуск выполняется одной командой:

```sh
docker compose up --build -d
```

Проверка:

```sh
docker compose ps -a
docker compose logs --tail=100 migrator app sync-worker
curl --fail http://localhost:3000/api/health
```

У `migrator` ожидается статус `Exited (0)`, у `db` и `app` — `healthy`, у `sync-worker` — `Up`. Endpoint `/api/health` проверяет доступ к PostgreSQL и возвращает ошибку, если база недоступна. Обычный `docker compose down` сохраняет данные. Флаг `-v` удаляет том с базой: не используйте его на рабочем сервере.

## Создание администратора

Демонстрационных учётных данных нет. Создавайте администратора отдельной CLI-командой. Пароль передаётся только процессу подготовки и хранится в БД в виде хеша.

Bash (пароль не записывается в историю):

```sh
read -r -p 'Email администратора: ' ADMIN_EMAIL
read -r -s -p 'Новый пароль: ' ADMIN_PASSWORD
export ADMIN_EMAIL ADMIN_PASSWORD
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD migrator npm run admin:create
unset ADMIN_EMAIL ADMIN_PASSWORD
```

PowerShell 7:

```powershell
$env:ADMIN_EMAIL = Read-Host 'Email администратора'
$adminSecret = Read-Host 'Новый пароль' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $adminSecret).Password
try {
  docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD migrator npm run admin:create
} finally {
  Remove-Item Env:ADMIN_EMAIL, Env:ADMIN_PASSWORD
  $adminSecret.Dispose()
}
```

Войдите с этим email и паролем через кабинет, затем откройте `/admin`. Не добавляйте административные пароли в `.env`, Dockerfile, README или GitHub.

## GitHub

Проверьте `.gitignore`, прежде чем создавать первый коммит. `.env`, резервные копии, локальные результаты тестов и `node_modules` исключены из Git. В репозиторий должны попасть `package-lock.json`, схема Prisma и все каталоги миграций. Создайте пустой приватный репозиторий и отправьте код:

```sh
git init
git add .
git commit -m "Prepare HOPS application and deployment"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Workflow `.github/workflows/ci.yml` проверяет lint, TypeScript, модульные тесты, production build, браузерные сценарии с отдельной PostgreSQL и сборку/запуск Compose. Он не публикует приложение и не получает доступ к рабочей базе. Сделайте успешный CI обязательным условием merge в `main`. Для VPS используйте отдельный SSH-ключ с минимально необходимым доступом; деплой запускает оператор после проверки CI.

## VPS и HTTPS

На VPS откройте наружу только SSH и HTTP/HTTPS. Приложение слушает `127.0.0.1:3000`, PostgreSQL доступен только внутри сети Compose. Перед публичным запуском задайте:

```dotenv
APP_URL=https://YOUR_DOMAIN
COOKIE_SECURE=true
TRUST_PROXY=true
BIND_ADDRESS=127.0.0.1
```

Настройте DNS и reverse proxy с TLS. Например, установите Caddy на хост по [официальной инструкции](https://caddyserver.com/docs/install), замените домен в `/etc/caddy/Caddyfile`:

```caddyfile
YOUR_DOMAIN {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote_host}
    }
}
```

Caddy [получает и обновляет сертификат](https://caddyserver.com/docs/automatic-https) при корректном DNS и доступных портах 80/443. После настройки примените `.env` командой `docker compose up -d --force-recreate app sync-worker`. `APP_URL` должен точно совпадать с браузерным origin: сервер проверяет источник запросов, меняющих данные. Не выключайте эту проверку для исправления неверной конфигурации proxy. `TRUST_PROXY=true` допустим, только когда приложение недоступно напрямую и proxy [перезаписывает `X-Real-IP`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers): тогда ограничения попыток разделяются по адресам клиентов. Без доверенного proxy оставьте `false` (общий лимит для неизвестного адреса).

Проверьте реальные контакты и часы работы, настройте точку самовывоза и опубликуйте документы владельца через админку. Текст юридических документов не подменяется сгенерированными обещаниями. Проект не принимает онлайн-оплату и не создаёт доставку. Проверка email, сброс пароля и SMS-провайдер не подключены. Отдельный поток восстановления с проверкой владельца учётной записи нужно реализовать до его предложения клиентам; команда создания администратора не изменяет существующие аккаунты.

## Обновление и откат

Перед обновлением сделайте резервную копию и запишите текущую ревизию. Затем:

```sh
git pull --ff-only
docker compose build
docker compose stop app sync-worker
docker compose run --rm migrator
docker compose up -d
```

Если миграция завершилась с ошибкой, сначала разберите `docker compose logs migrator` и статус Prisma; не меняйте вручную таблицу миграций для обхода ошибки. Для отката приложения переключитесь на проверенную ревизию и пересоберите. Откат кода допустим только при совместимости со схемой: необратимые изменения данных требуют проверенного плана восстановления. На первом развёртывании нет автоматического переноса старого браузерного состояния: исходный каталог пуст, а данные разных браузеров не были общей базой.

## Резервная копия и восстановление

Пример для Bash на VPS. Каталог резервных копий должен быть доступен только оператору; выгружайте шифрованные копии на отдельное хранилище и регулярно проверяйте восстановление.

```sh
umask 077
mkdir -p backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "backups/hops-$(date +%Y%m%d-%H%M%S).dump"
```

Для восстановления в отдельной тестовой среде запустите только базу, подайте выбранный dump на stdin `pg_restore`. `--clean` удаляет существующие объекты в целевой базе; сначала проверьте имя Compose-проекта и среду.

```sh
docker compose stop app sync-worker
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < backups/CHOSEN_BACKUP.dump
docker compose up -d
```

## Обмен с 1С и наблюдение

`ONE_C_MODE=test` использует пустой адаптер без создания товаров. Реальный контракт API не предоставлен. `ONE_C_MODE=live` до реализации адаптера выдаёт явную ошибку; переменные `ONE_C_BASE_URL` и `ONE_C_TOKEN` зарезервированы для подключения. Согласуйте формат товаров, единицы цен/остатков, склады, часовой пояс, статусы и ключи идемпотентности с разработчиком 1С. После реализации проверьте контракт в отдельной среде и только затем включайте live.

Задания, попытки и сообщения сохраняются в PostgreSQL. В админке доступны ручной запуск и повтор; отдельный `sync-worker` обрабатывает очередь. В тестовом режиме сведения о ценах, наличии и бонусах не выдаются за подтверждённые 1С. Для эксплуатации настройте внешнюю проверку `/api/health`, оповещение об остановке worker и росте ошибок обмена, контроль свободного места и резервных копий. HTTP health сайта не является проверкой живости отдельного worker.

## Источники конфигурации

- [Порядок запуска и проверки готовности Docker Compose](https://docs.docker.com/compose/how-tos/startup-order/).
- [Standalone output Next.js](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).
- [Браузерные проверки Playwright в CI](https://playwright.dev/docs/ci-intro).
