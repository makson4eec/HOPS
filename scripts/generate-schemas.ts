import { promises as fs } from "node:fs";
import { z } from "zod";
import { catalogSchema, loyaltySchema, normalizeSnapshot } from "../lib/snapshots";
await fs.mkdir("schemas", { recursive: true });
await fs.mkdir("examples", { recursive: true });
for (const [kind, schema] of [["catalog", catalogSchema], ["loyalty", loyaltySchema]] as const) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  if (kind === "catalog") {
    const shape = jsonSchema as unknown as { properties: { products: { items: { properties: { price: Record<string, unknown> } } } } };
    shape.properties.products.items.properties.price.multipleOf = 0.01;
  }
  await fs.writeFile(`schemas/${kind}.schema.json`, JSON.stringify({ ...jsonSchema, title: `HOPS 1C ${kind} snapshot 1.0` }, null, 2) + "\n");
  const source = JSON.parse((await fs.readFile(`examples/${kind}.json`, "utf8")).replace(/^\uFEFF/, ""));
  if (kind === "catalog") for (const product of source.products) if (product.siteCategory === "beer_drink") product.siteCategory = "beer_drinks";
  await fs.writeFile(`examples/${kind}.json`, JSON.stringify(schema.parse(normalizeSnapshot(source, kind)), null, 2) + "\n");
}
