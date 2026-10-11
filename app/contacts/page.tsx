import type { Metadata } from "next";
import { Icon } from "@/components/icon";
import { PageContent, PageHero } from "@/components/page-shell";
import { getSettings } from "@/lib/data";

export const metadata: Metadata = { title: "Как нас найти", description: "Адрес магазина HOPS, часы работы и маршрут.", alternates: { canonical: "/contacts" } };

export default async function ContactsPage() {
  const settings = await getSettings();
  return <><PageHero title="Как нас найти" description="Адрес магазина и часы работы. Ждём вас каждый день." /><PageContent>
    <div className="split">
      <div className="map-panel"><div className="map-card"><strong>Магазин HOPS</strong><span>{settings.address}</span><div className="mt-16"><a className="button primary" href={`https://yandex.ru/maps/?text=${encodeURIComponent(settings.address)}`} target="_blank" rel="noopener noreferrer">Открыть карту <Icon name="arrow" /></a></div></div></div>
      <section className="panel"><span className="eyebrow">Планируйте визит</span><h2>Режим работы</h2><ul className="hours-list"><li>{settings.hoursWeek}</li><li>{settings.hoursWeekend}</li></ul><p className="muted">Время местное, Екатеринбург.</p></section>
    </div>
  </PageContent></>;
}
