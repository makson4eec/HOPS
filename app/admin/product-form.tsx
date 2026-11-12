import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { beerColors, beerFiltrations } from "@/lib/beer";
import { categories } from "@/lib/constants";
import type { Rows } from "@/lib/models";
import { saveProductAction } from "./actions";

function Select({ name, label, value = "", options }: { name: string; label: string; value?: string; options: readonly { id: string; title: string }[] }) {
  return <div className="field"><label htmlFor={name}>{label}</label><select id={name} name={name} className="select" defaultValue={value}>
    <option value="">Не указано</option>
    {options.map(option => <option key={option.id} value={option.id}>{option.title}</option>)}
  </select></div>;
}

export function ProductForm({ product }: { product: Rows["product"] | null }) {
  const fields = [
    { name: "name", label: "Название", value: product?.name, required: true, maxLength: 250 },
    { name: "price", label: "Цена, ₽", value: product ? (product.price / 100).toFixed(2) : "0", required: true, inputMode: "decimal" as const },
    { name: "stock", label: "Физический остаток до вычета резервов", value: product?.stock ?? 0, required: true, inputMode: "decimal" as const },
    { name: "unit", label: "Единица учёта", value: product?.unit ?? "шт", required: true, maxLength: 30 },
    { name: "volume", label: "Объём или вес", value: product?.volume, maxLength: 100 },
    { name: "alcohol", label: "Крепость", value: product?.alcohol, maxLength: 30 },
    { name: "barcode", label: "Штрихкод", value: product?.barcode, maxLength: 100 },
    { name: "country", label: "Страна", value: product?.country, maxLength: 200 },
    { name: "manufacturer", label: "Производитель", value: product?.manufacturer, maxLength: 300 },
    { name: "imageUrl", label: "Адрес изображения", value: product?.imageUrl, maxLength: 1000 },
  ];
  return <section className="panel">
    <Link className="text-link" href="/admin?tab=products">← К списку товаров</Link>
    <h2>{product ? "Редактировать карточку" : "Добавить временный товар"}</h2>
    {product && <p className="muted">Артикул {product.sku}{product.externalId && ` · ID 1С ${product.externalId}`}</p>}
    <p>Изменения действуют до следующей принятой выгрузки каталога из 1С. Временный товар доступен на витрине для просмотра.</p>
    <ActionForm key={product?.id ?? "new"} action={saveProductAction} className="form-grid">
      <input type="hidden" name="id" value={product?.id ?? randomUUID()} />
      <input type="hidden" name="mode" value={product ? "edit" : "create"} />
      {product && <input type="hidden" name="updatedAt" value={product.updatedAt.toISOString()} />}
      {fields.map(({ label, value, ...input }) => <label className="field" key={input.name}>
        <span>{label}</span><input className="input" {...input} defaultValue={value ?? ""} />
      </label>)}
      <div className="field"><label htmlFor="site-category">Категория</label><select id="site-category" className="select" name="siteCategory" defaultValue={product?.category ?? ""} required>
        <option value="" disabled>Выберите категорию</option>
        {categories.filter(category => category.id !== "new").map(category => <option key={category.id} value={category.id}>{category.title}</option>)}
      </select></div>
      <Select name="beerColor" label="Цвет пива" value={product?.beerColor ?? ""} options={beerColors} />
      <Select name="beerFiltration" label="Фильтрация пива" value={product?.beerFiltration ?? ""} options={beerFiltrations} />
      <label className="field"><span>Срок годности, дней</span><input className="input" name="shelfLifeDays" type="number" min={0} step={1} defaultValue={product?.shelfLifeDays ?? ""} /></label>
      <label className="field"><span>Годен до</span><input className="input" name="expiryDate" type="date" defaultValue={product?.expiryDate ?? ""} /></label>
      <label className="field full"><span>Описание</span><textarea className="textarea" name="description" rows={5} maxLength={20000} defaultValue={product?.description} /></label>
      <details className="field full">
        <summary>Дополнительные характеристики и партии</summary>
        <label className="field"><span>Характеристики (JSON)</span><textarea className="textarea" name="attributes" rows={4} defaultValue={JSON.stringify(product?.attributes ?? {}, null, 2)} /></label>
        <label className="field"><span>Партии (JSON)</span><textarea className="textarea" name="batches" rows={4} defaultValue={JSON.stringify(product?.batches ?? [], null, 2)} /></label>
      </details>
      <label className="checkbox-row"><input type="checkbox" name="isNew" defaultChecked={product?.isNew} />Показывать в новинках</label>
      <label className="checkbox-row"><input type="checkbox" name="isActive" defaultChecked={product?.isActive ?? true} />Показывать в каталоге</label>
      <div className="field full"><SubmitButton>Сохранить карточку</SubmitButton></div>
    </ActionForm>
  </section>;
}
