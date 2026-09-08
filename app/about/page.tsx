import type { Metadata } from "next";
import Link from "next/link";
import { PageContent, PageHero } from "@/components/page-shell";

export const metadata: Metadata = { title: "О магазине", description: "HOPS — магазин напитков и снеков. Знакомство с ассортиментом и самовывоз.", alternates: { canonical: "/about" } };

export default function AboutPage() {
  return <><PageHero title="О HOPS" description="Напитки, снеки и внимание к вашему выбору." /><PageContent><div className="split"><article className="info-card dark"><div className="eyebrow">Наш магазин</div><h2>Всё начинается с хорошего вкуса</h2><p>HOPS объединяет напитки и снеки в одном каталоге. Смотрите описания, узнавайте о поступлениях и выбирайте то, что подходит именно вам.</p><Link className="button primary" href="/assortment">Посмотреть ассортимент</Link></article><article className="info-card"><div className="eyebrow">В удобном ритме</div><h2>Знакомьтесь онлайн, забирайте в магазине</h2><p>На сайте можно проверить наличие, собрать корзину и выбрать время самовывоза. После оформления магазин проверит заказ, а вы сможете следить за его готовностью в личном кабинете.</p><Link className="button" href="/pickup">Подробнее о самовывозе</Link></article></div><div className="notice mt-24"><p>Нужна помощь с выбором? <Link className="text-link" href="/contacts">Свяжитесь с нами</Link> — сотрудники подскажут, что есть в магазине.</p></div></PageContent></>;
}
