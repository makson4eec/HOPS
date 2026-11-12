import { canOrder } from "@/lib/purchase-policy";
import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { checkoutAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LegalFormTerms } from "@/components/legal-form-terms";
import { EmptyState, PageContent, PageHero } from "@/components/page-shell";
import { getCurrentUser } from "@/lib/auth";
import { money } from "@/lib/constants";
import { getCart, getSettings } from "@/lib/data";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Оформление самовывоза", robots: { index: false, follow: false } };

export default async function CheckoutPage() {
  const [cart, user, settings, warehouses] = await Promise.all([getCart(), getCurrentUser(), getSettings(), db.warehouse.findMany({ where: { pickupEnabled: true }, orderBy: { name: "asc" } })]);
  const items = cart?.items ?? [];
  const total = items.reduce((sum, item) => sum + item.quantity * item.product.price, 0);
  function localDate(date: Date) {
    const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: settings.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    return parts.replace(" ", "T");
  }
  // This dynamic server component derives the pickup window once per request.
  // eslint-disable-next-line react-hooks/purity
  const requestTime = Date.now();
  const from = localDate(new Date(Math.ceil((requestTime + 60 * 60_000) / 900_000) * 900_000));
  const until = localDate(new Date(requestTime + 7 * 86400_000));
  return <><PageHero title="Оформление самовывоза" description="Укажите контакты и удобное время. Магазин подтвердит заказ после проверки." /><PageContent>{!items.length ? <EmptyState icon="bag" title="Сначала добавьте товары" description="Перейдите в каталог, чтобы собрать заказ для самовывоза." href="/catalog" /> : items.some(item => !canOrder(item.product)) ? <EmptyState title="Обновите состав корзины" description="Некоторые товары доступны только для покупки в магазине." href="/cart" label="Вернуться в корзину" /> : !user ? <EmptyState icon="user" title="Войдите, чтобы оформить заказ" description="В личном кабинете сохранится история заказов и будет доступен статус сборки." href="/account?next=/checkout" label="Войти или зарегистрироваться" /> : !warehouses.length ? <EmptyState icon="pin" title="Самовывоз пока недоступен" description="Магазин ещё не открыл приём заказов. Уточните возможность покупки у сотрудников." href="/contacts" label="Как нас найти" /> : <div className="cart-layout"><ActionForm action={checkoutAction} className="panel form-grid"><input type="hidden" name="checkoutKey" value={randomUUID()} /><input type="hidden" name="expectedTotal" value={total} /><div className="field"><label htmlFor="checkout-name">Имя получателя</label><input className="input" id="checkout-name" name="name" autoComplete="name" defaultValue={user.name} required minLength={2} maxLength={80} /></div><div className="field"><label htmlFor="checkout-phone">Телефон</label><input className="input" id="checkout-phone" name="phone" type="tel" autoComplete="tel" defaultValue={user.phone ?? ""} required minLength={10} maxLength={24} placeholder="+7 900 000-00-00" /></div><div className="field full"><label htmlFor="checkout-warehouse">Магазин самовывоза</label><select className="select" id="checkout-warehouse" name="warehouseId" required defaultValue={warehouses[0].id}>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}{warehouse.address ? ` — ${warehouse.address}` : ""}</option>)}</select></div><div className="field full"><label htmlFor="checkout-time">Дата и время получения</label><input className="input" id="checkout-time" name="pickupAt" type="datetime-local" min={from} max={until} step={900} required aria-describedby="pickup-hint" /><span className="hint" id="pickup-hint">Время магазина ({settings.timezone}). Выберите время с {String(settings.pickupOpen).padStart(2, "0")}:00 до {String(settings.pickupClose % 24).padStart(2, "0")}:00, в течение ближайших 7 дней.</span></div><div className="field full"><label htmlFor="checkout-comment">Комментарий к заказу <span className="muted">(необязательно)</span></label><textarea className="textarea" id="checkout-comment" name="comment" maxLength={500} rows={3} /></div><LegalFormTerms flow="checkout"><SubmitButton pendingLabel="Оформляем заказ…">Подтвердить самовывоз</SubmitButton></LegalFormTerms></ActionForm><aside className="panel summary"><h2>Состав заказа</h2>{items.map((item) => <div className="summary-row" key={item.id}><span>{item.product.name} × {item.quantity}</span><strong>{money(item.quantity * item.product.price)}</strong></div>)}<div className="summary-row"><span>Самовывоз</span><strong>Бесплатно</strong></div><div className="summary-row total"><span>Итого</span><strong>{money(total)}</strong></div><p className="hint">После оформления дождитесь статуса «Готов к выдаче» в разделе заказов.</p><Link className="text-link" href="/cart">Изменить корзину</Link></aside></div>}</PageContent></>;
}

