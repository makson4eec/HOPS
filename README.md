# HOPS на Windows

Next.js/TypeScript, один ПК магазина, приватное локальное JSON-хранилище. Отдельная СУБД, Docker и VPS не нужны. Дизайн и страницы сохранены. Рабочий каталог изначально пустой.

1. Установить Node.js 22.12+ LTS и зависимости: `npm.cmd ci`.
2. Скопировать `.env.example` в `.env`, указать пути и разрешённые ID 1С.
3. Выполнить `npm.cmd run build`, создать администратора по [инструкции Windows](docs/WINDOWS.md).
4. Установить задачу автозапуска из повышенного PowerShell: `powershell.exe -ExecutionPolicy Bypass -File .\install-autostart.ps1 -RunAsUser "$env:COMPUTERNAME\HopsSvc"`.

[Установка, обновление и восстановление](docs/WINDOWS.md) · [Контракт для 1С](docs/1C.md) · [Устройство хранилища](docs/STORAGE.md) · [Проверки](docs/VERIFICATION.md).

Проверки: `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, `npm.cmd run test:e2e`. E2E запускает сервер с отдельной папкой `.test-data/e2e`; не указывайте для тестов рабочую папку магазина.
