import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { addToCartAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageContent, PageHero } from "@/components/page-shell";
import { availableQuantity, ProductStatus, ProductVisual } from "@/components/product-card";
import { categories, formatDate, money } from "@/lib/constants";
import { db } from "@/lib/db";

const getProduct = cache((slug: string) => db.product.findFirst({
  where: { slug, status: "PUBLISHED" },
  include: {
    inventories: { include: { warehouse: true } },
    arrivals: { where: { received: false }, include: { warehouse: true }, orderBy: { expectedAt: "asc" } },
  },
}));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const product = await getProduct((await params).slug);
  if (!product) return { title: "Товар не найден", robots: { index: false } };
  return { title: product.name, description: product.description.slice(0, 155) || `${product.name} в HOPS: цена, наличие и самовывоз из магазина.`, alternates: { canonical: `/catalog/${product.slug}` }, openGraph: { title: product.name, description: product.description.slice(0, 155) } };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const product = await getProduct((await params).slug);
  if (!product) notFound();
  const quantity = availableQuantity(product);
  const canBuy = quantity > 0 && product.price > 0;
  return <><PageHero title={product.name} description={categories.find((category) => category.id === product.category)?.title} /><PageContent><div className="product-detail"><ProductVisual product={product} priority /><article className="panel product-copy"><ProductStatus product={product} /><span className="price">{product.price > 0 ? money(product.price) : "Цена уточняется"}</span><p className="product-description">{product.description || "Описание товара пока не добавлено. Уточнить подробности можно у сотрудников магазина."}</p><dl className="detail-list"><dt>Артикул</dt><dd>{product.sku}</dd>{product.volume && <><dt>Объём / упаковка</dt><dd>{product.volume}</dd></>}<dt>Получение</dt><dd>Самовывоз</dd></dl><ActionForm action={addToCartAction} className="form-stack"><input type="hidden" name="productId" value={product.id} /><div className="field"><label htmlFor="product-quantity">Количество</label><input className="input quantity-input" id="product-quantity" name="quantity" type="number" min={1} max={Math.max(1, Math.min(quantity, 99))} defaultValue={1} required disabled={!canBuy} /></div><SubmitButton disabled={!canBuy}>{canBuy ? "Добавить в корзину" : "Пока недоступен для самовывоза"}</SubmitButton></ActionForm><p className="hint">Состав и наличие заказа подтверждает магазин. <Link className="text-link" href="/pickup">Как работает самовывоз</Link></p></article></div><section className="section-spacing"><h2 className="section-heading">Наличие в магазине</h2>{product.inventories.length ? <div className="table-wrap panel"><table className="availability-table"><caption className="sr-only">Остатки товара по складам</caption><thead><tr><th scope="col">Склад / магазин</th><th scope="col">Доступно</th><th scope="col">Получение</th></tr></thead><tbody>{product.inventories.map((inventory) => <tr key={inventory.id}><td><strong>{inventory.warehouse.name}</strong>{inventory.warehouse.address && <div className="muted">{inventory.warehouse.address}</div>}</td><td>{Math.max(0, inventory.quantity - inventory.reserved)} шт.</td><td>{inventory.warehouse.pickupEnabled ? "Самовывоз" : "Уточните в магазине"}</td></tr>)}</tbody></table></div> : <p className="notice">Данные об остатках пока не опубликованы.</p>}</section>{product.arrivals.length > 0 && <section className="section-spacing"><h2 className="section-heading">Ожидаемые поступления</h2><div className="panel"><ul className="order-items">{product.arrivals.map((arrival) => <li key={arrival.id}><span>{arrival.warehouse.name} · {formatDate(arrival.expectedAt)}</span><strong>{arrival.quantity} шт.</strong></li>)}</ul><p className="hint">Дата поступления предварительная и может измениться.</p></div></section>}<Link className="button mt-24" href="/catalog">← Вернуться в каталог</Link></PageContent></>;
}
