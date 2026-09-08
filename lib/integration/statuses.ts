import type { OrderStatus } from "@prisma/client";
import { IntegrationError } from "./errors";

const forward: OrderStatus[] = ["NEW", "CONFIRMED", "PREPARING", "READY", "COMPLETED"];

/** Polling can miss intermediate states; terminal states must never regress. */
export function incomingStatusPath(current: OrderStatus, incoming: OrderStatus): OrderStatus[] {
  if (current === incoming) return [];
  if (current === "COMPLETED" || current === "CANCELLED") throw new IntegrationError("ORDER_STATUS_REGRESSION");
  if (incoming === "CANCELLED") return ["CANCELLED"];
  const start = forward.indexOf(current);
  const end = forward.indexOf(incoming);
  if (end <= start) throw new IntegrationError("ORDER_STATUS_REGRESSION");
  return forward.slice(start + 1, end + 1);
}
