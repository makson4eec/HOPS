import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageContent, PageHero } from "@/components/page-shell";
import { formatDate } from "@/lib/constants";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Документы", description: "Условия самовывоза, политика обработки персональных данных и документы магазина HOPS.", alternates: { canonical: "/legal" } };

export default async function LegalPage({ searchParams }: { searchParams: Promise<{ doc?: string }> }) {
  const [params, documents] = await Promise.all([searchParams, db.document.findMany({ where: { published: true }, orderBy: { title: "asc" } })]);
  const slug = typeof params.doc === "string" ? params.doc : documents[0]?.slug;
  const document = documents.find((item) => item.slug === slug);
  return <><PageHero title="Документы" description="Условия работы магазина и информация об обработке персональных данных." /><PageContent>{documents.length > 0 && <nav className="chip-row account-nav" aria-label="Документы магазина">{documents.map((item) => <Link className={`chip ${item.slug === slug ? "active" : ""}`} key={item.id} href={`/legal?doc=${encodeURIComponent(item.slug)}`} aria-current={item.slug === slug ? "page" : undefined}>{item.title}</Link>)}</nav>}{document ? <article className="panel legal-copy"><h2>{document.title}</h2><p className="hint">Обновлён {formatDate(document.updatedAt)}</p><div className="legal-text">{document.content}</div></article> : <EmptyState icon="package" title="Документ пока не опубликован" description="Документы появятся здесь после публикации магазином." href="/" label="На главную" />}</PageContent></>;
}
