"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

const links = [["/catalog", "Каталог"], ["/availability", "Наличие"], ["/pickup", "Самовывоз"], ["/loyalty", "Бонусы"], ["/reviews", "Отзывы"], ["/contacts", "Контакты"]];

export function Navigation({ address, cartCount }: { address: string; cartCount: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && open) { setOpen(false); trigger.current?.focus(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const items = links.map(([href, title]) => <Link key={href} href={href} aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined} onClick={() => setOpen(false)}>{title}</Link>);
  return <header className="site-header"><div className="container header-row"><div className="header-brand"><Link className="brand" href="/" aria-label="HOPS — на главную" onClick={() => setOpen(false)}>HOPS</Link><Link className="store-switch" href="/contacts"><Icon name="pin" /><span>{address || "Магазин HOPS"}</span></Link></div><nav className="desktop-nav" aria-label="Основная навигация">{items}</nav><div className="header-actions"><Link className="icon-button" href="/catalog" aria-label="Поиск товаров"><Icon name="search" /></Link><Link className="icon-button account-link" href="/account" aria-label="Личный кабинет"><Icon name="user" /></Link><Link className="icon-button" href="/cart" aria-label={`Корзина${cartCount ? `, товаров: ${cartCount}` : ""}`}><Icon name="cart" />{cartCount > 0 && <span className="cart-count">{cartCount > 99 ? "99+" : cartCount}</span>}</Link><button className="icon-button mobile-menu-button" type="button" ref={trigger} aria-controls="mobile-nav" aria-expanded={open} aria-label={open ? "Закрыть меню" : "Открыть меню"} onClick={() => setOpen(!open)}><Icon name="menu" /></button></div></div><nav className={`mobile-nav ${open ? "open" : ""}`} id="mobile-nav" aria-label="Мобильная навигация">{items}<Link href="/account" onClick={() => setOpen(false)}>Личный кабинет</Link><Link href="/assortment" onClick={() => setOpen(false)}>Ассортимент</Link></nav></header>;
}
