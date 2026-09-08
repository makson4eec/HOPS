"use client";
export default function GlobalError({ reset }: { reset: () => void }) {
  return <html lang="ru"><body style={{ background: "#efefed", color: "#151515", fontFamily: "Arial, sans-serif", padding: "40px 24px" }}><main style={{ maxWidth: 640, margin: "10vh auto" }}><p>HOPS</p><h1>Не удалось загрузить магазин</h1><p>Сервис временно недоступен. Пожалуйста, попробуйте ещё раз немного позже.</p><button onClick={reset} style={{ padding: "14px 24px", background: "#ef7200", border: 0, borderRadius: 8, cursor: "pointer", fontSize: 16 }}>Попробовать снова</button></main></body></html>;
}
