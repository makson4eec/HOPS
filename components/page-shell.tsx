import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "./icon";

export function PageHero({ title, description }: { title: string; description?: string }) {
  return <section className="page-hero"><div className="container"><nav className="breadcrumbs" aria-label="Хлебные крошки"><Link href="/">Главная</Link><span aria-hidden="true">→</span><span aria-current="page">{title}</span></nav><h1>{title}</h1>{description && <p>{description}</p>}</div></section>;
}

export function PageContent({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className="page-section"><div className={`container ${className}`}>{children}</div></section>;
}

export function EmptyState({ title, description, href, label, icon = "package", compact = false }: { title: string; description: string; href?: string; label?: string; icon?: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`}><div><span className="empty-icon"><Icon name={icon} /></span><h2>{title}</h2><p>{description}</p>{href && <Link className="button primary" href={href}>{label ?? "В каталог"}<Icon name="arrow" /></Link>}</div></div>;
}

export function AccountNav() {
  return <nav className="chip-row account-nav" aria-label="Личный кабинет"><Link className="chip" href="/account">Профиль</Link><Link className="chip" href="/orders">Заказы</Link><Link className="chip" href="/loyalty">Бонусы</Link></nav>;
}
