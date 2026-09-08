import type { Metadata } from "next";
import Link from "next/link";
import { AccountNav, EmptyState, PageContent, PageHero } from "@/components/page-shell";
import { getCurrentUser } from "@/lib/auth";
import { formatDate } from "@/lib/constants";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Бонусы", robots: { index: false, follow: false } };
const operationNames = { ACCRUAL: "Начисление", REDEMPTION: "Списание", REVERSAL: "Возврат операции" };
const operationStatuses = { PENDING: "Ожидает подтверждения", RUNNING: "Обрабатывается", SUCCESS: "Подтверждено", FAILED: "Ожидает уточнения" };

export default async function LoyaltyPage() {
  const user = await getCurrentUser();
  const operations = user ? await db.bonusOperation.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 50 }) : [];
  return <><PageHero title="Бонусы" description="Ваш баланс и история операций по программе лояльности." /><PageContent>{!user ? <EmptyState icon="heart" title="Ваши бонусы — в личном кабинете" description="Войдите, чтобы посмотреть баланс и подтверждённые бонусные операции." href="/account?next=/loyalty" label="Войти в кабинет" /> : <><AccountNav /><div className="account-dashboard"><div className="balance-card"><div><span>Бонусный баланс</span>{user.bonusUpdatedAt ? <strong>{user.bonusBalance.toLocaleString("ru-RU")} Б</strong> : <h2>Баланс пока не получен</h2>}</div><span>{user.bonusUpdatedAt ? `Обновлён ${formatDate(user.bonusUpdatedAt)}` : "Данные появятся после подтверждения магазином."}</span></div><div className="panel"><h2>Программа лояльности</h2><p className="muted">Здесь отражаются подтверждённый баланс и операции магазина. Условия начисления и использования бонусов можно уточнить у сотрудников.</p><Link className="button" href="/contacts">Связаться с магазином</Link><p className="hint mt-24">Если баланс кажется неверным, сообщите об этом сотруднику до использования бонусов.</p></div></div><section className="section-spacing"><h2 className="section-heading">История бонусов</h2>{operations.length ? <div className="table-wrap panel" tabIndex={0} role="region" aria-label="История бонусных операций"><table className="availability-table"><thead><tr><th scope="col">Операция</th><th scope="col">Дата</th><th scope="col">Бонусы</th><th scope="col">Статус</th></tr></thead><tbody>{operations.map((operation) => <tr key={operation.id}><td><strong>{operationNames[operation.kind]}</strong>{operation.description && <div className="muted">{operation.description}</div>}</td><td>{formatDate(operation.createdAt)}</td><td>{operation.kind === "ACCRUAL" ? "+" : operation.kind === "REDEMPTION" ? "−" : ""}{operation.amount.toLocaleString("ru-RU")} Б</td><td>{operationStatuses[operation.status]}</td></tr>)}</tbody></table><p className="hint">Показаны последние 50 операций.</p></div> : <EmptyState compact icon="heart" title="Операций пока нет" description="Подтверждённые начисления и списания появятся здесь." />}</section></>}</PageContent></>;
}
