"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const storageKey = "hops_age_confirmed";
function readConfirmation() {
  try { return sessionStorage.getItem(storageKey) === "true"; }
  catch { return false; }
}
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
const serverSnapshot = () => false;

export function AgeGate({ children }: { children: React.ReactNode }) {
  const storedConfirmation = useSyncExternalStore(subscribe, readConfirmation, serverSnapshot);
  const [accepted, setAccepted] = useState(false);
  const pathname = usePathname();
  const showContent = accepted || storedConfirmation || pathname === "/legal";
  const button = useRef<HTMLButtonElement>(null);
  const legalLink = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!showContent) button.current?.focus();
  }, [showContent]);

  function confirm() {
    try { sessionStorage.setItem(storageKey, "true"); } catch { /* Allow this visit when storage is blocked. */ }
    setAccepted(true);
    requestAnimationFrame(() => document.getElementById("main")?.focus());
  }

  return <>
    {!showContent && <div className="age-gate" role="dialog" aria-modal="true" aria-labelledby="age-gate-title" aria-describedby="age-gate-description" onKeyDown={event => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      (event.target === button.current ? legalLink.current : button.current)?.focus();
    }}>
      <div className="age-gate-card">
        <span className="brand">HOPS</span>
        <div className="age-gate-badge" aria-hidden="true">18+</div>
        <h2 id="age-gate-title">Вам уже исполнилось 18 лет?</h2>
        <p id="age-gate-description">Сайт содержит информацию о товарах для совершеннолетних. Подтвердите возраст, чтобы продолжить.</p>
        <button ref={button} className="button primary" type="button" onClick={confirm}>Мне есть 18 лет — войти</button>
        <p className="age-gate-note">Если вам ещё нет 18 лет, пожалуйста, закройте эту страницу.</p>
        <Link ref={legalLink} className="text-link" href="/legal">Документы магазина</Link>
        <noscript>Для подтверждения возраста включите JavaScript в браузере.</noscript>
      </div>
    </div>}
    <div hidden={!showContent} inert={!showContent}>{children}</div>
  </>;
}
