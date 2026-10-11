"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="page-section"><div className="container empty-state"><div><h1>Не удалось загрузить страницу</h1><p>Попробуйте ещё раз через некоторое время.</p><div className="hero-actions"><button className="button primary" onClick={reset}>Попробовать снова</button><Link className="button" href="/contacts">Как нас найти</Link></div></div></div></section>;
}
