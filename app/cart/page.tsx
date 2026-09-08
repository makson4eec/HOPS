import type { Metadata } from "next";
import Link from "next/link";
import { updateCartAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { EmptyState, PageContent, PageHero } from "@/components/page-shell";
import { availableQuantity } from "@/components/product-card";
import { money } from "@/lib/constants";
import { getCart } from "@/lib/data";

export const metadata: Metadata = { title: "Корзина", robots: { index: false, follow: false } };

export default async function CartPage() {
  const cart = await getCart();
  const items = cart?.items ?? [];
  const total = items.reduce((sum, item) => sum + item.quantity * item.product.price, 0);
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const invalid = items.some((item) => !item.product.isActive || item.product.status !== "PUBLISHED" || item.product.price <= 0 || availableQuantity(item.product) < item.quantity);
  return <><PageHero title="Корзина" description="Проверьте количество и состав заказа перед оформлением самовывоза." /><PageContent>{items.length ? <div className="cart-layout"><div className="cart-list">{invalid && <p className="notice">Наличие некоторых товаров изменилось. Обновите их количество или удалите из корзины.</p>}{items.map((item) => <article className="cart-item" key={item.id}><div><h2><Link className="text-link" href={`/catalog/${item.product.slug}`}>{item.product.name}</Link></h2><p>{item.product.volume ? `${item.product.volume} · ` : ""}{money(item.product.price)} за шт.</p>{(!item.product.isActive || item.product.status !== "PUBLISHED" || item.product.price <= 0 || availableQuantity(item.product) < item.quantity) && <p className="form-error">Доступно для самовывоза: {item.product.isActive && item.product.status === "PUBLISHED" && item.product.price > 0 ? availableQuantity(item.product) : 0} шт.</p>}</div><strong>{money(item.quantity * item.product.price)}</strong><div className="cart-controls"><ActionForm action={updateCartAction} className="cart-controls"><input type="hidden" name="productId" value={item.product.id} /><div className="field"><label htmlFor={`quantity-${item.id}`}>Количество</label><input className="input quantity-input" id={`quantity-${item.id}`} name="quantity" type="number" min={1} max={99} defaultValue={item.quantity} required /></div><SubmitButton className="button small">Обновить</SubmitButton></ActionForm><ActionForm action={updateCartAction}><input type="hidden" name="productId" value={item.product.id} /><input type="hidden" name="quantity" value="0" /><SubmitButton className="button small danger">Удалить</SubmitButton></ActionForm></div></article>)}<Link className="text-link mt-16" href="/catalog">← Продолжить покупки</Link></div><aside className="panel summary"><h2>Ваш заказ</h2><div className="summary-row"><span>Товаров</span><strong>{count}</strong></div><div className="summary-row"><span>Самовывоз</span><strong>Бесплатно</strong></div><div className="summary-row total"><span>Итого</span><strong>{money(total)}</strong></div>{invalid ? <p className="hint">Для оформления обновите корзину.</p> : <Link className="button primary full mt-16" href="/checkout">Оформить самовывоз</Link>}<p className="hint">Стоимость и наличие проверяются повторно при оформлении.</p></aside></div> : <EmptyState icon="cart" title="Корзина пока пуста" description="Выберите товары в каталоге — они появятся здесь." href="/catalog" label="Перейти в каталог" />}</PageContent></>;
}
