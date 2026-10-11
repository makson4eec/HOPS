ALTER TABLE "ShopSettings"
  ALTER COLUMN "address" SET DEFAULT 'г. Екатеринбург, ул. Библиотечная, 43',
  ALTER COLUMN "shortAddress" SET DEFAULT 'г. Екатеринбург, ул. Библиотечная, 43',
  ALTER COLUMN "phone" SET DEFAULT '',
  ALTER COLUMN "email" SET DEFAULT '',
  ALTER COLUMN "hoursWeek" SET DEFAULT 'Пн–Пт: 11:00–00:00',
  ALTER COLUMN "hoursWeekend" SET DEFAULT 'Сб–Вс: 11:00–00:00',
  ALTER COLUMN "pickupClose" SET DEFAULT 24,
  ALTER COLUMN "timezone" SET DEFAULT 'Asia/Yekaterinburg';

UPDATE "ShopSettings" SET
  "address" = 'г. Екатеринбург, ул. Библиотечная, 43',
  "shortAddress" = 'г. Екатеринбург, ул. Библиотечная, 43',
  "phone" = '', "email" = '',
  "hoursWeek" = 'Пн–Пт: 11:00–00:00', "hoursWeekend" = 'Сб–Вс: 11:00–00:00',
  "pickupOpen" = 11, "pickupClose" = 24, "timezone" = 'Asia/Yekaterinburg',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'main';

UPDATE "Warehouse" SET "address" = 'г. Екатеринбург, ул. Библиотечная, 43'
WHERE "id" = 'hops-store';
