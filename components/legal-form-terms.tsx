import Link from "next/link";
import { legalFormState, type LegalFlow } from "@/lib/legal";

const terms = {
  account: { slug: "account-consent", label: "Даю согласие на обработку персональных данных для личного кабинета" },
  checkout: { slug: "offer", label: "Принимаю условия самовывоза и публичную оферту" },
  review: { slug: "review-consent", label: "Даю согласие на обработку персональных данных для модерации отзыва" },
  newsletter: { slug: "newsletter-consent", label: "Даю согласие на обработку персональных данных для рассылки" },
};

export async function LegalFormTerms({ flow, children }: { flow: LegalFlow; children: React.ReactNode }) {
  const state = await legalFormState(flow);
  if (!state.ready) return <p className="notice field full">Форма станет доступна после публикации документов магазина.</p>;
  const term = terms[flow];
  return <>
    <input type="hidden" name="legalRevision" value={state.revision} />
    <p className="hint field full"><Link className="text-link" href="/legal?doc=privacy" target="_blank">Политика обработки персональных данных</Link>
      {flow === "checkout" && <> · <Link className="text-link" href="/legal?doc=returns" target="_blank">Возврат и претензии</Link></>}
    </p>
    <label className="checkbox-row field full"><input type="checkbox" name="consent" required />
      <span>{term.label}. <Link className="text-link" href={`/legal?doc=${term.slug}`} target="_blank">Текст документа</Link></span>
    </label>
    {flow === "newsletter" && <label className="checkbox-row field full"><input type="checkbox" name="advertisingConsent" required />
      <span>Согласен получать рекламную рассылку. <Link className="text-link" href="/legal?doc=advertising-consent" target="_blank">Текст согласия</Link></span>
    </label>}
    <div className="field full">{children}</div>
  </>;
}
