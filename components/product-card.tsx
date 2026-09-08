import Image from "next/image";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { addToCartAction } from "@/app/actions";
import { categories, money } from "@/lib/constants";
import { ActionForm, SubmitButton } from "./action-form";
import { Icon } from "./icon";

export type StoreProduct = Prisma.ProductGetPayload<{ include: { inventories: { include: { warehouse: true } }; arrivals: true } }>;

export function availableQuantity(product: Pick<StoreProduct, "inventories">) {
  return Math.max(0, ...product.inventories.filter((item) => item.warehouse.pickupEnabled).map((item) => item.quantity - item.reserved));
}

export function ProductStatus({ product }: { product: StoreProduct }) {
  const available = product.source === "1c" ? product.stock > 0 : availableQuantity(product) > 0;
  const incoming = product.source !== "1c" && product.arrivals.some((arrival) => !arrival.received && arrival.quantity > 0);
  return <span className={`status ${available ? "" : incoming ? "soon" : "out"}`}>{available ? "В наличии" : incoming ? "Ожидается поступление" : "Нет в наличии"}</span>;
}

export function ProductVisual({ product, priority = false }: { product: Pick<StoreProduct, "name" | "imageUrl">; priority?: boolean }) {
  const remote = Boolean(product.imageUrl?.startsWith("https://"));
  return <div className="product-visual">{product.imageUrl && (remote || /^\/images\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|avif)$/.test(product.imageUrl)) ? <Image src={product.imageUrl} alt={product.name} fill sizes="(max-width: 560px) 90vw, (max-width: 820px) 45vw, 30vw" priority={priority} unoptimized={remote} referrerPolicy="no-referrer" /> : <span className="product-placeholder"><Icon name="package" /><span>Фотография пока не добавлена</span></span>}</div>;
}

export function ProductCard({ product }: { product: StoreProduct }) {
  const available = availableQuantity(product) > 0 && product.price > 0;
  return <article className="product-card"><Link href={`/catalog/${product.slug}`} aria-label={product.name}><ProductVisual product={product} /></Link><div className="product-card-body"><ProductStatus product={product} /><h2><Link href={`/catalog/${product.slug}`}>{product.name}</Link></h2><p>{product.volume || categories.find((category) => category.id === product.category)?.title}</p><div className="product-meta"><span className="price">{product.price > 0 ? money(product.price) : "Цена уточняется"}</span>{product.isNew && <span className="status soon">Новинка</span>}</div><ActionForm action={addToCartAction}><input type="hidden" name="productId" value={product.id} /><SubmitButton className="button primary full" disabled={!available}>{available ? "В корзину" : "Пока недоступен"}</SubmitButton></ActionForm></div></article>;
}
