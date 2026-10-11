"use client";

import { useState } from "react";
import { categories } from "@/lib/constants";
import { beerColors, beerFiltrations } from "@/lib/beer";

export function ProductCategoryFields({ category = "kvass", beerColor, beerFiltration, locked = false }: {
  category?: string; beerColor?: string | null; beerFiltration?: string | null; locked?: boolean;
}) {
  const [selectedCategory, setCategory] = useState(category);
  const [selectedColor, setColor] = useState(beerColor || "");
  return <>
    {!locked && <label className="field"><span>Категория</span><select className="select" name="category" value={selectedCategory} onChange={event => setCategory(event.target.value)}>
      {categories.filter(item => item.id !== "new").map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>}
    {selectedCategory === "kvass" && <>
      <label className="field"><span>Цвет пива</span><select className="select" name="beerColor" value={selectedColor} onChange={event => setColor(event.target.value)}>
        <option value="">Не указан</option>
        {beerColors.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      {selectedColor && <label className="field"><span>Фильтрация пива</span><select className="select" name="beerFiltration" defaultValue={beerFiltration || ""}>
        <option value="">Не указана</option>
        {beerFiltrations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>}
    </>}
  </>;
}
