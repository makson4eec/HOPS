import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { getSettings } from "@/lib/data";
import { db } from "@/lib/db";
import { legalDocumentSlugs, legalFieldGroups, legalFields, legalTemplateFields, legalTemplates, renderLegalTemplate } from "@/lib/legal-templates";
import { saveDocumentAction, saveLegalDetailsAction } from "./actions";

export async function LegalDocuments() {
  const [settings, documents] = await Promise.all([getSettings(), db.document.findMany()]);
  const details = settings.legalDetails ?? {};
  return <div className="form-stack">
    <section className="panel">
      <h2>Данные для документов HOPS</h2>
      <p>Заполните реквизиты один раз. Они подставятся в черновики. Сайт публикует только документы, которые вы сохранили с отметкой о публикации.</p>
      <p className="hint">Для запуска укажите фактические сроки хранения, поставщиков услуг и условия бонусов. Изменение реквизитов обновляет предпросмотр. Чтобы изменить опубликованный текст, сохраните новую редакцию документа.</p>
      <ActionForm action={saveLegalDetailsAction} className="form-stack">
        {legalFieldGroups.map(group => <details key={group.title}>
          <summary>{group.title}</summary>
          <div className="form-grid mt-16">
            {Object.entries(group.fields).map(([name, label]) => <label key={name} className="field">
              <span>{label}</span>
              {group.title === "Реквизиты продавца" ? <input name={name} className="input" maxLength={1600} defaultValue={details[name] ?? ""} />
                : <textarea name={name} className="textarea" rows={2} maxLength={1600} defaultValue={details[name] ?? ""} />}
            </label>)}
          </div>
        </details>)}
        <SubmitButton>Сохранить данные для документов</SubmitButton>
      </ActionForm>
    </section>
    {legalDocumentSlugs.map(slug => {
      const template = legalTemplates[slug];
      const doc = documents.find(item => item.slug === slug);
      const draft = doc?.draft ?? doc?.content ?? template.content;
      const preview = renderLegalTemplate(draft, details);
      const missing = legalTemplateFields(preview);
      return <section className="panel" key={slug}>
        <h2>{doc?.title ?? template.title}</h2>
        {doc?.published ? <p><Link href={`/legal?doc=${slug}`} className="text-link">Открыть опубликованный документ</Link></p> : <p className="muted">Черновик</p>}
        {missing.length > 0 && <p className="hint">Осталось заполнить поля: {missing.map(key => Object.hasOwn(legalFields, key) ? legalFields[key] : key).join(", ")}.</p>}
        <details className="mt-16">
          <summary>Предпросмотр</summary>
          <div className="legal-text mt-16">{preview}</div>
        </details>
        <ActionForm action={saveDocumentAction} className="form-stack mt-16">
          <input type="hidden" name="slug" value={slug} />
          <details>
            <summary>Правка текста шаблона</summary>
            <div className="form-stack mt-16">
              <label className="field"><span>Заголовок документа</span><input name="title" className="input" defaultValue={doc?.title ?? template.title} required maxLength={200} /></label>
              <label className="field"><span>Текст черновика</span><textarea name="content" className="textarea" rows={12} defaultValue={draft} required minLength={30} maxLength={100000} /></label>
            </div>
          </details>
          <label className="checkbox-row"><input name="published" type="checkbox" defaultChecked={doc?.published} />Опубликовать документ</label>
          <SubmitButton>Сохранить документ</SubmitButton>
        </ActionForm>
      </section>;
    })}
  </div>;
}
