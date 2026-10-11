export const categories = [
  { id: "kvass", title: "Пиво", letter: "П", copy: "Пиво от знакомых и независимых производителей." },
  { id: "lemonade", title: "Газировки", letter: "Г", copy: "Газированные и негазированные напитки." },
  { id: "kombucha", title: "Сидры / Пуарэ", letter: "С", copy: "Напитки на основе яблок и груш." },
  { id: "mors", title: "Пивные напитки", letter: "П", copy: "Разные стили и вкусы." },
  { id: "snacks", title: "Снеки", letter: "С", copy: "Закуски к вашим любимым напиткам." },
  { id: "vapes", title: "Электронные сигареты и вейпы", letter: "Э", copy: "Электронные сигареты и вейпы. Только для совершеннолетних." },
  { id: "new", title: "Новинки", letter: "Н", copy: "Последние поступления в магазин." },
] as const;
export const orderStatuses: Record<string, string> = { NEW: "Новый", CONFIRMED: "Подтверждён", PREPARING: "Собирается", READY: "Готов к выдаче", COMPLETED: "Выдан", CANCELLED: "Отменён" };
export const money = (kopecks: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(kopecks / 100);
export const formatDate = (date: Date | string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Yekaterinburg" }).format(new Date(date));
