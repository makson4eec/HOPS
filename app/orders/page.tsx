import type { Metadata } from "next";
import Link from "next/link";
import { AccountNav, EmptyState, PageContent, PageHero } from "@/components/page-shell";
import { getCurrentUser } from "@/lib/auth";
import { formatDate, money, orderStatuses } from "@/lib/constants";
import { getSettings } from "@/lib/data";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Мои заказы", robots: { index: false, follow: false } };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getCurrentUser();
  if (!user) return <><PageHero title="Мои заказы" /><PageContent><EmptyState icon="user" title="Войдите в личный кабинет" description="История и статусы заказов доступны после входа." href="/account?next=/orders" label="Войти в кабинет" /></PageContent></>;
  const page = Math.max(1, Math.min(10000, Number.parseInt((await searchParams).page ?? "1", 10) || 1));
  const [orders, count, settings] = await Promise.all([db.order.findMany({ where: { userId: user.id }, include: { items: true, warehouse: true }, orderBy: { createdAt: "desc" }, take: 10, skip: (page - 1) * 10 }), db.order.count({ where: { userId: user.id } }), getSettings()]);
  const pickupDate = (date: Date) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: settings.timezone }).format(date);
  return <><PageHero title="Мои заказы" description="Статус сборки, состав заказа и время самовывоза." /><PageContent><AccountNav />{orders.length ? <><div className="order-list">{orders.map((order) => <article className="panel" key={order.id} id={`order-${order.number}`}><div className="order-header"><div><h2>Заказ № {order.number}</h2><p className="muted">Оформлен {formatDate(order.createdAt)}</p></div><span className={`status ${order.status === "CANCELLED" ? "out" : order.status === "READY" || order.status === "COMPLETED" ? "" : "soon"}`}>{orderStatuses[order.status]}</span></div>{order.status === "READY" && <p className="notice">Заказ готов. Назовите его номер сотруднику магазина при получении.</p>}<ul className="order-items">{order.items.map((item) => <li key={item.id}><span>{item.name} × {item.quantity}</span><strong>{money(item.price * item.quantity)}</strong></li>)}</ul><div className="summary-row"><span>Самовывоз</span><strong>Бесплатно</strong></div><div className="summary-row total"><span>Итого</span><strong>{money(order.total)}</strong></div><dl className="detail-list"><dt>Магазин</dt><dd>{order.warehouse.name}</dd><dt>Адрес</dt><dd>{order.warehouse.address || settings.address}</dd><dt>Время получения</dt><dd>{pickupDate(order.pickupAt)}</dd><dt>Получатель</dt><dd>{order.name}</dd><dt>Телефон</dt><dd>{order.phone}</dd></dl>{order.comment && <p><strong>Комментарий:</strong> {order.comment}</p>}</article>)}</div>{count > 10 && <nav className="pagination" aria-label="Страницы заказов">{page > 1 && <Link className="button" href={`/orders?page=${page - 1}`}>← Назад</Link>}<span>Страница {page}</span>{page * 10 < count && <Link className="button" href={`/orders?page=${page + 1}`}>Далее →</Link>}</nav>}</> : <EmptyState icon="bag" title="Заказов пока нет" description="После оформления самовывоза здесь появятся состав и статус вашего заказа." href="/catalog" label="Перейти в каталог" />}</PageContent></>;
}
