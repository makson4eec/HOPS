import type { Metadata } from "next";
import { Icon } from "@/components/icon";
import { PageContent, PageHero } from "@/components/page-shell";
import { getSettings } from "@/lib/data";

export const metadata: Metadata = { title: "Контакты", description: "Адрес магазина HOPS, телефон, электронная почта, часы работы и маршрут.", alternates: { canonical: "/contacts" } };

export default async function ContactsPage() {
  const settings = await getSettings();
  return <><PageHero title="Контакты" description="Заходите в магазин или свяжитесь с нами, если нужна помощь с выбором и заказом." /><PageContent><div className="contact-grid"><article className="contact-card"><span className="contact-icon"><Icon name="pin" /></span><h2>Магазин HOPS</h2><p>{settings.address}</p></article><article className="contact-card"><span className="contact-icon"><Icon name="phone" /></span><h2>Телефон</h2><a className="text-link" href={`tel:${settings.phone.replace(/[^\d+]/g, "")}`}>{settings.phone}</a></article><article className="contact-card"><span className="contact-icon"><Icon name="mail" /></span><h2>Электронная почта</h2><a className="text-link" href={`mailto:${settings.email}`}>{settings.email}</a></article></div><div className="split mt-24"><div className="map-panel"><div className="map-card"><strong>Как нас найти</strong><span>{settings.address}</span><div className="mt-16"><a className="button primary" href={`https://yandex.ru/maps/?text=${encodeURIComponent(settings.address)}`} target="_blank" rel="noopener noreferrer">Открыть карту <Icon name="arrow" /></a></div></div></div><section className="panel"><span className="eyebrow">Планируйте визит</span><h2>Режим работы</h2><ul className="hours-list"><li>{settings.hoursWeek}</li><li>{settings.hoursWeekend}</li></ul><p className="muted">Чтобы уточнить наличие товара или изменить время получения заказа, позвоните нам в часы работы.</p></section></div></PageContent></>;
}
