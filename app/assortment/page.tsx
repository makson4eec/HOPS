import type { Metadata } from "next";
import Link from "next/link";
import { PageContent, PageHero } from "@/components/page-shell";
import { categories } from "@/lib/constants";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Ассортимент", description: "Категории ассортимента HOPS: напитки и снеки.", alternates: { canonical: "/assortment" } };

export default async function AssortmentPage() {
  const [counts, newCount] = await Promise.all([db.product.groupBy({ by: ["category"], where: { status: "PUBLISHED", isActive: true }, _count: true }), db.product.count({ where: { status: "PUBLISHED", isActive: true, isNew: true } })]);
  return <><PageHero title="Ассортимент" description="Выберите категорию и познакомьтесь с ассортиментом магазина." /><PageContent><div className="category-grid">{categories.map((category) => <Link className="category-card" data-letter={category.letter} href={`/catalog?category=${category.id}`} key={category.id}><span className="count">В каталоге: {category.id === "new" ? newCount : counts.find((count) => count.category === category.id)?._count ?? 0}</span><div><h2>{category.title}</h2><p>{category.copy}</p></div></Link>)}</div></PageContent></>;
}
