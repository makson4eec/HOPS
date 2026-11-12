import type { Metadata } from "next";
import Link from "next/link";
import { reviewAction } from "@/app/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LegalFormTerms } from "@/components/legal-form-terms";
import { EmptyState, PageContent, PageHero } from "@/components/page-shell";
import { getCurrentUser } from "@/lib/auth";
import { formatDate } from "@/lib/constants";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Отзывы", description: "Отзывы покупателей HOPS о магазине, ассортименте и самовывозе.", alternates: { canonical: "/reviews" } };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Math.min(10000, Number.parseInt((await searchParams).page ?? "1", 10) || 1));
  const [reviews, user, count] = await Promise.all([db.review.findMany({ where: { status: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 12, skip: (page - 1) * 12 }), getCurrentUser(), db.review.count({ where: { status: "APPROVED" } })]);
  return <><PageHero title="Отзывы" description="Мнения покупателей о магазине, ассортименте и качестве обслуживания." /><PageContent>{reviews.length ? <><div className="reviews-grid">{reviews.map((review) => <article className="review-card" key={review.id}><div className="review-head"><span className="review-avatar" aria-hidden="true">П</span><span className="stars" aria-label={`Оценка ${review.rating} из 5`}>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</span></div><h2>Покупатель HOPS</h2><p>{review.text}</p><time className="review-date" dateTime={review.createdAt.toISOString()}>{formatDate(review.createdAt)}</time></article>)}</div>{count > 12 && <nav className="pagination" aria-label="Страницы отзывов">{page > 1 && <Link className="button" href={`/reviews?page=${page - 1}`}>← Назад</Link>}<span>Страница {page}</span>{page * 12 < count && <Link className="button" href={`/reviews?page=${page + 1}`}>Далее →</Link>}</nav>}</> : <EmptyState icon="star" title="Пока нет опубликованных отзывов" description="Поделитесь впечатлениями о магазине — ваш опыт поможет другим покупателям." compact />}<section className="panel section-spacing"><h2>Оставить отзыв</h2><p className="muted">Отзыв появится на сайте после модерации. Не указывайте в тексте телефон и другие личные данные.</p>{user ? <ActionForm action={reviewAction} className="form-grid" resetOnSuccess><div className="field"><label htmlFor="review-rating">Ваша оценка</label><select className="select" id="review-rating" name="rating" defaultValue="5" required><option value="5">5 — отлично</option><option value="4">4 — хорошо</option><option value="3">3 — нормально</option><option value="2">2 — есть замечания</option><option value="1">1 — плохо</option></select></div><div className="field full"><label htmlFor="review-text">Текст отзыва</label><textarea className="textarea" id="review-text" name="text" required minLength={10} maxLength={2000} rows={5} aria-describedby="review-hint" /><span className="hint" id="review-hint">От 10 до 2000 символов. Отзыв публикуется без имени и контактов.</span></div><LegalFormTerms flow="review"><SubmitButton>Отправить отзыв</SubmitButton></LegalFormTerms></ActionForm> : <Link className="button primary" href="/account?next=/reviews">Войти и оставить отзыв</Link>}</section></PageContent></>;
}
