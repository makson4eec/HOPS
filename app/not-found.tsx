import { EmptyState, PageContent, PageHero } from "@/components/page-shell";

export default function NotFound() {
  return <><PageHero title="Страница не найдена" description="Возможно, ссылка изменилась или товар больше не опубликован." /><PageContent><EmptyState icon="search" title="Продолжим с каталога?" description="Там собраны все опубликованные товары магазина." href="/catalog" label="Открыть каталог" /></PageContent></>;
}
