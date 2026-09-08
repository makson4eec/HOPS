"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="page-section"><div className="container empty-state"><div><h1>Не удалось загрузить страницу</h1><p>Попробуйте ещё раз через некоторое время. Если ошибка повторяется, свяжитесь с магазином.</p><div className="hero-actions"><button className="button primary" onClick={reset}>Попробовать снова</button><Link className="button" href="/contacts">Контакты магазина</Link></div></div></div></section>;
}
