# Установка на ПК магазина

Требуются Windows 10/11 или Windows Server с Task Scheduler, Node.js 22.12+ LTS в системном PATH, локальный NTFS-диск. Проект разместить, например, в `D:\HOPS\HOPS`, вне профиля пользователя. Сервер привязан к `127.0.0.1`; порт по умолчанию 3000.

## Первая установка

В обычном PowerShell из папки проекта:

```powershell
Copy-Item .env.example .env
notepad.exe .env
npm.cmd ci
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

В `.env` задать `HOPS_DATA_DIR=C:\HOPS\data`, точные разрешённые ID категорий/товаров, при необходимости пути входящих файлов. Пустые списки ID запрещают импорт. Не копировать примеры в рабочую папку. 1С должна публиковать настоящие снимки.

Создать администратора с временным паролем без записи в файл:

```powershell
$env:ADMIN_EMAIL = Read-Host 'Email администратора HOPS'
$adminSecret = Read-Host 'Пароль администратора HOPS (минимум 16 символов)' -AsSecureString
$env:ADMIN_PASSWORD = [Net.NetworkCredential]::new('', $adminSecret).Password
npm.cmd run admin:create
Remove-Item Env:ADMIN_PASSWORD
Remove-Item Env:ADMIN_EMAIL
```

В **повышенном PowerShell** создать отдельного стандартного локального пользователя (не включать в Administrators):

```powershell
$serviceSecret = Read-Host 'Пароль Windows для HopsSvc' -AsSecureString
New-LocalUser -Name HopsSvc -Password $serviceSecret -PasswordNeverExpires -UserMayNotChangePassword
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1 -RunAsUser "$env:COMPUTERNAME\HopsSvc"
```

Если 1С работает под другой Windows-учётной записью, добавить параметр `-OneCUser 'ИМЯПК\Пользователь1С'`. Ей предоставляются права на входящую/исходящую папки, а не на пользователей и сессии HOPS. Сервисной записи нужны чтение проекта, изменение приватной папки и `.next/cache`; установщик настраивает эти ACL. Подключать внешний носитель для копий до запуска и дать HopsSvc право изменения только папки копий.

Задача использует AtStartup, S4U и RunLevel Limited, запускается без интерактивного входа и без пароля в скриптах. S4U работает с локальными файлами, не с сетевыми шарами/EFS. Политика Windows должна разрешать HopsSvc «Вход в качестве пакетного задания» и не запрещать его (при доменной политике проверить `secpol.msc`/политику администратора). Если ограничение мешает S4U, используйте Task Scheduler → HOPS → учётная запись HopsSvc → «Выполнять вне зависимости от регистрации пользователя», введите пароль **в интерфейсе Windows**, сохранив AtStartup и минимальные права.

Сборка выполняется только при установке/обновлении. После запуска есть задержка 45 секунд на готовность Windows. Supervisor проверяет порт и здоровье, перезапускает сервер после ошибки; задача перезапускает supervisor. Логи: `C:\HOPS\data\logs`. Повторный экземпляр не запускается.

## Проверка на реальном ПК

```powershell
Get-ScheduledTask -TaskName HOPS | Select-Object State
Get-ScheduledTaskInfo -TaskName HOPS
Invoke-RestMethod http://127.0.0.1:3000/api/health
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object LocalAddress, OwningProcess
```

Ожидаются `status: ok`, адрес `127.0.0.1`, один слушающий процесс. Проверить также админку, личный кабинет, входящие выгрузки и пробный самовывоз нерегулируемого товара.

Перезагрузить ПК и **не входить в Windows**; с внешней стороны защищённого туннеля проверить доступность сайта, после входа посмотреть время запуска задачи. Для проверки аварийного восстановления завершить только PID сервера из `Get-NetTCPConnection` и убедиться, что supervisor поднял новый PID. Завершение задачи вручную не имитирует аварию сервера.

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\stop-hops.ps1
powershell.exe -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
```

Остановка отправляет supervisor запрос, затем сервер закрывает HTTP и текущие запросы. Данные/задача сохраняются при остановке; удаление задачи сохраняет данные. На новой загрузке Windows установленная задача снова стартует.

## Обновление и резервные копии

После установки выполнять обслуживание из повышенного PowerShell: приватные файлы доступны только сервисной записи и администраторам.

Сначала остановить HOPS, выполнить ручную копию, затем обновить файлы, `npm.cmd ci`, проверки и `npm.cmd run build`, `Start-ScheduledTask -TaskName HOPS`. Не собирать поверх работающего сервера. Не публиковать `.env`, JSON и копии.

```powershell
npm.cmd run backup
npm.cmd run backup -- E:\HOPS-backup
powershell.exe -ExecutionPolicy Bypass -File .\stop-hops.ps1
npm.cmd run restore -- E:\HOPS-backup\hops-ДАТА.json
Start-ScheduledTask -TaskName HOPS
```

Автоматическая копия делается ежедневно, локальные копии хранятся 30 дней (настраивается). `HOPS_BACKUP_DIR=E:\HOPS-backup` включает проверенную копию на другой локальный носитель. Снимок резервирования включает принятый каталог, бонусы и все операционные данные; исходящие файлы восстанавливаются из него. Отдельно сохранить проект, `.env` и права папок. После отката обязательно сверить заказы с 1С: повторный импорт должен учитывать `id`/`checkoutKey`; исходящие файлы до восстановления переносятся в `restore-previous-*`.

## Публичный доступ

До выбора схемы проверьте у интернет-провайдера магазина, доступен ли входящий белый IP. При наличии белого IP и домена можно принимать HTTPS через reverse proxy на ПК магазина. При CGNAT нужен исходящий туннель к публичному HTTPS-адресу. После настройки проверьте сайт и вход в аккаунт с телефона по мобильной сети, затем повторите проверку после перезагрузки ПК без входа в Windows.

Настроить HTTPS-туннель или reverse proxy к **только** `http://127.0.0.1:3000`, запускаемый своей задачей/службой до или одновременно с HOPS. Указать точный `APP_URL=https://домен`, `COOKIE_SECURE=true`, затем перезапустить сервер. Не открывать входящий порт приложения, SMB, 1С или папку data в Интернет. Proxy должен сохранять исходный Host/Origin; `TRUST_PROXY=true` допустим только если он перезаписывает `X-Real-IP` доверенным адресом клиента. Ключ туннеля хранить в его приватной конфигурации. Конкретный провайдер/домен выбирается магазином; автоматически туннель не устанавливается.
