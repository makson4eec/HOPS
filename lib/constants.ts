export const categories = [
  { id: "beer", title: "Пиво", letter: "П", copy: "Пиво от знакомых и независимых производителей." },
  { id: "lemonade", title: "Газировки", letter: "Г", copy: "Газированные и негазированные напитки." },
  { id: "ciders", title: "Сидры", letter: "С", copy: "Напитки на основе яблок." },
  { id: "poire", title: "Пуарэ", letter: "П", copy: "Напитки на основе груш." },
  { id: "beer_drinks", title: "Пивные напитки", letter: "П", copy: "Разные стили и вкусы." },
  { id: "snacks", title: "Снеки", letter: "С", copy: "Закуски к вашим любимым напиткам." },
  { id: "vapes", title: "Электронные сигареты и вейпы", letter: "Э", copy: "Электронные сигареты и вейпы. Только для совершеннолетних." },
  { id: "new", title: "Новинки", letter: "Н", copy: "Последние поступления в магазин." },
] as const;
export const orderStatuses: Record<string, string> = { NEW: "Новый", CONFIRMED: "Подтверждён", PREPARING: "Собирается", READY: "Готов к выдаче", COMPLETED: "Выдан", CANCELLED: "Отменён" };
export const money = (kopecks: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(kopecks / 100);
const quantityNumber = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 });
function stockUnit(unit: string) {
  if (["", "pcs", "шт", "шт.", "штука"].includes(unit)) return "шт.";
  if (["л/дм3", "л/дм³", "литр"].includes(unit)) return "л";
  return unit;
}
export const formatQuantity = (quantity: number, unit: string) => `${quantityNumber.format(quantity)} ${stockUnit(unit)}`;
export function productPrice(price: number, unit: string) {
  if (price <= 0) return "Цена уточняется";
  return stockUnit(unit) === "шт." ? money(price) : `${money(price)} / ${stockUnit(unit)}`;
}
export const formatDate = (date: Date | string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Yekaterinburg" }).format(new Date(date));
