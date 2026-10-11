import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Navigation } from "@/components/navigation";
import { AgeGate } from "@/components/age-gate";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { getCart, getSettings } from "@/lib/data";
import { subscribeAction } from "./actions";
import "./globals.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL || "http://localhost:3000"),
  title: { default: "HOPS — напитки и снеки, самовывоз из магазина", template: "%s — HOPS" },
  description: "Каталог HOPS: напитки и снеки, наличие и поступления. Выберите товары и оформите самовывоз из магазина.",
  openGraph: { type: "website", locale: "ru_RU", siteName: "HOPS", title: "HOPS — напитки и снеки", description: "Ассортимент, наличие и самовывоз из магазина HOPS." },
  twitter: { card: "summary" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#efefed" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [settings, cart] = await Promise.all([getSettings(), getCart()]);
  const cartCount = cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  return <html lang="ru"><body><AgeGate><a className="skip-link" href="#main">К содержимому</a><Navigation address={settings.shortAddress} cartCount={cartCount} /><main id="main" tabIndex={-1}>{children}</main><footer className="site-footer"><div className="container footer-top"><div className="footer-brand"><Link className="brand" href="/">HOPS</Link><p>Напитки, снеки и самовывоз из магазина. Выбирайте в своём темпе — забирайте после подтверждения.</p><p>{settings.address}</p><p>{settings.hoursWeek}<br />{settings.hoursWeekend}</p></div><div className="footer-col"><h2>Покупателям</h2><Link href="/pickup">Самовывоз</Link><Link href="/account">Личный кабинет</Link><Link href="/orders">Мои заказы</Link><Link href="/loyalty">Бонусы</Link><Link href="/about">О магазине</Link><Link href="/contacts">Как нас найти</Link><Link href="/admin">Управление магазином</Link></div><div className="footer-col"><h2>Новости магазина</h2><p className="muted">Оставьте почту, чтобы получать новости о поступлениях.</p><ActionForm action={subscribeAction} className="form-stack" resetOnSuccess><div className="field"><label htmlFor="newsletter-email">Электронная почта</label><input className="input" id="newsletter-email" name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.ru" /></div><label className="checkbox-row"><input type="checkbox" name="consent" required /><span>Согласен на обработку данных и получение новостей. <Link className="text-link" href="/legal?doc=privacy">Политика конфиденциальности</Link></span></label><SubmitButton>Подписаться</SubmitButton></ActionForm></div></div><div className="container footer-bottom"><span>© {new Date().getFullYear()} HOPS</span><div className="footer-links"><Link href="/legal?doc=offer">Условия самовывоза</Link><Link href="/legal?doc=privacy">Конфиденциальность</Link><Link href="/legal?doc=returns">Возврат и обмен</Link></div></div></footer></AgeGate></body></html>;
}
