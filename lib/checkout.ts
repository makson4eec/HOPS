import { canOrder } from "./purchase-policy";
import { db } from "@/lib/db";
import { serializable } from "@/lib/orders";
import { UserFacingError } from "@/lib/security";
import { recordLegalAcceptance, type LegalVersions } from "./legal";

export type CheckoutInput = { userId: string; cartId: string; checkoutKey: string; warehouseId: string; name: string; phone: string; pickupAt: Date; comment: string; expectedTotal?: number };
export async function placeOrder(input: CheckoutInput, versions: LegalVersions = {}) {
  return serializable(async tx => {
    const duplicate = await tx.order.findUnique({ where: { checkoutKey: input.checkoutKey } });
    if (duplicate) {
      if (duplicate.userId !== input.userId) throw new UserFacingError("Обновите страницу оформления заказа.");
      return duplicate;
    }
    const cart = await tx.cart.findUnique({ where: { id: input.cartId }, include: { items: { include: { product: true }, orderBy: { productId: "asc" } } } });
    if (!cart || cart.userId !== input.userId || cart.expiresAt < new Date() || !cart.items.length) throw new UserFacingError("Корзина пуста или недоступна. Добавьте товары снова.");
    const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId } });
    if (!warehouse?.pickupEnabled) throw new UserFacingError("Этот пункт самовывоза недоступен.");
    let total = 0;
    for (const item of cart.items) {
      if (!canOrder(item.product) || !item.product.isActive || item.product.status !== "PUBLISHED" || item.product.price <= 0 || item.quantity < 1 || item.quantity > 99) throw new UserFacingError(`Проверьте доступность товара «${item.product.name}».`);
      const stock = await tx.inventory.findUnique({ where: { productId_warehouseId: { productId: item.productId, warehouseId: input.warehouseId } } });
      if (!stock || stock.quantity - stock.reserved < item.quantity) throw new UserFacingError(`Недостаточно товара «${item.product.name}» в выбранном магазине.`);
      await tx.inventory.update({ where: { id: stock.id }, data: { reserved: { increment: item.quantity } } });
      total += item.product.price * item.quantity;
    }
    if (!Number.isSafeInteger(total) || total > 2_000_000_000) throw new UserFacingError("Сумма заказа превышает допустимую. Уменьшите количество товаров.");
    if (input.expectedTotal !== undefined && total !== input.expectedTotal) throw new UserFacingError("Цены изменились. Обновите страницу и проверьте сумму заказа.");
    const { cartId: _cartId, expectedTotal: _expectedTotal, ...orderData } = input;
    void _cartId; void _expectedTotal;
    const order = await tx.order.create({ data: { ...orderData, total, items: { create: cart.items.map(item => ({
      productId: item.productId, name: item.product.name, sku: item.product.sku, price: item.product.price, quantity: item.quantity,
    })) } } });
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    await tx.user.update({ where: { id: input.userId }, data: { phone: input.phone } });
    await recordLegalAcceptance(tx, "checkout", input.userId, order.id, versions);
    return order;
  });
}
export async function findOwnedOrder(checkoutKey: string, userId: string) {
  return db.order.findFirst({ where: { checkoutKey, userId } });
}
