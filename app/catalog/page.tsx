import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { EmptyState, PageContent, PageHero } from "@/components/page-shell";
import { ProductCard } from "@/components/product-card";
import { categories } from "@/lib/constants";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Каталог", description: "Каталог напитков и снеков HOPS. Поиск, категории, актуальные цены и самовывоз из магазина.", alternates: { canonical: "/catalog" } };
type Params = { q?: string; category?: string; sort?: string; page?: string };

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const q = (typeof params.q === "string" ? params.q : "").trim().slice(0, 120);
  const category = categories.some((item) => item.id === params.category) ? params.category : "all";
  const sort = params.sort === "price-asc" || params.sort === "price-desc" ? params.sort : "newest";
  const requestedPage = Math.max(1, Math.min(10000, Number.parseInt(params.page ?? "1", 10) || 1));
  const where: Prisma.ProductWhereInput = { status: "PUBLISHED", ...(category === "new" ? { isNew: true } : category !== "all" ? { category } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } : {}) };
  const count = await db.product.count({ where });
  const pageCount = Math.max(1, Math.ceil(count / 24));
  const currentPage = Math.min(requestedPage, pageCount);
  const products = await db.product.findMany({ where, include: { inventories: { include: { warehouse: true } }, arrivals: true }, orderBy: sort === "price-asc" ? [{ price: "asc" }, { id: "asc" }] : sort === "price-desc" ? [{ price: "desc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }], skip: (currentPage - 1) * 24, take: 24 });
  function href(next: { category?: string; page?: number }) {
    return `/catalog?${new URLSearchParams({ ...(q ? { q } : {}), category: next.category ?? category ?? "all", sort, page: String(next.page ?? 1) })}`;
  }
  return <><PageHero title="Каталог" description="Найдите свой напиток, проверьте наличие и добавьте товары в корзину." /><PageContent><form action="/catalog" className="catalog-toolbar" role="search"><input type="hidden" name="category" value={category} /><div className="field"><label htmlFor="catalog-query">Название или артикул</label><input className="input" id="catalog-query" name="q" type="search" defaultValue={q} maxLength={120} placeholder="Найти в каталоге" /></div><div className="field"><label htmlFor="catalog-sort">Сортировка</label><select className="select" id="catalog-sort" name="sort" defaultValue={sort}><option value="newest">Сначала новые</option><option value="price-asc">Сначала дешевле</option><option value="price-desc">Сначала дороже</option></select></div><button className="button" type="submit">Найти</button></form><nav className="chip-row" aria-label="Категории каталога">{[{ id: "all", title: "Все товары" }, ...categories].map((item) => <Link className={`chip ${category === item.id ? "active" : ""}`} href={href({ category: item.id })} key={item.id} aria-current={category === item.id ? "page" : undefined}>{item.title}</Link>)}</nav><div className="mt-24">{products.length ? <><p className="muted">Найдено товаров: {count}</p><div className="products-grid">{products.map((product) => <ProductCard key={product.id} product={product} />)}</div>{pageCount > 1 && <nav className="pagination" aria-label="Страницы каталога">{currentPage > 1 && <Link className="button" href={href({ page: currentPage - 1 })}>← Назад</Link>}<span>Страница {currentPage} из {pageCount}</span>{currentPage < pageCount && <Link className="button" href={href({ page: currentPage + 1 })}>Далее →</Link>}</nav>}</> : <EmptyState title={q || category !== "all" ? "Товары не найдены" : "Каталог готовится к открытию"} description={q || category !== "all" ? "Попробуйте другое название или посмотрите все категории." : "Мы опубликуем ассортимент, цены и наличие после их подтверждения. По вопросам ассортимента свяжитесь с магазином."} href={q || category !== "all" ? "/catalog" : "/contacts"} label={q || category !== "all" ? "Сбросить фильтры" : "Контакты магазина"} />}</div></PageContent></>;
}
