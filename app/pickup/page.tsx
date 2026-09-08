import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageContent, PageHero } from "@/components/page-shell";
import { getSettings } from "@/lib/data";

export const metadata: Metadata = { title: "Самовывоз", description: "Как оформить и получить заказ в магазине HOPS. Адрес, часы работы и порядок самовывоза.", alternates: { canonical: "/pickup" } };

export default async function PickupPage() {
  const settings = await getSettings();
  return <><PageHero title="Самовывоз" description="Выберите товары на сайте, дождитесь подтверждения и заберите заказ в магазине." /><PageContent><div className="steps"><article className="step"><span className="step-number" aria-hidden="true">1</span><h2>Соберите корзину</h2><p>Добавьте доступные товары и укажите удобное время самовывоза.</p></article><article className="step"><span className="step-number" aria-hidden="true">2</span><h2>Дождитесь готовности</h2><p>Магазин проверит наличие и соберёт заказ. Статус появится в вашем кабинете.</p></article><article className="step"><span className="step-number" aria-hidden="true">3</span><h2>Заберите в магазине</h2><p>Приходите в выбранное время после подтверждения и назовите номер заказа.</p></article></div><div className="split mt-24"><div className="map-panel"><div className="map-card"><strong>HOPS</strong><span>{settings.address}</span><div className="mt-16"><a className="button small primary" href={`https://yandex.ru/maps/?text=${encodeURIComponent(settings.address)}`} target="_blank" rel="noopener noreferrer">Построить маршрут <Icon name="arrow" /></a></div></div></div><div className="info-card dark"><h2>Ждём вас в магазине</h2><ul className="hours-list"><li>{settings.hoursWeek}</li><li>{settings.hoursWeekend}</li></ul><p>Самовывоз бесплатный. Если ваши планы изменились, сообщите об этом сотрудникам.</p><Link className="button primary" href="/catalog">Перейти в каталог</Link></div></div><div className="notice mt-24"><p>При оформлении выбирайте время по часовому поясу магазина. Подробные условия — в разделе <Link className="text-link" href="/legal?doc=offer">«Документы»</Link>.</p></div></PageContent></>;
}
