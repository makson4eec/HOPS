import type { Rows } from "./models";
export function canOrder(product: Pick<Rows["product"], "category" | "alcohol" | "unit">) {
  const alcohol = Number((product.alcohol || "0").replace("%", "").replace(",", ".").trim());
  return ["lemonade", "snacks"].includes(product.category) && alcohol === 0 && ["pcs", "шт", "шт."].includes(product.unit);
}
