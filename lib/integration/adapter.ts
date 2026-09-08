import type { BonusRequest, ClientQuery, ExportOrder, OneCAdapter } from "./contracts";
import { IntegrationError } from "./errors";

/** Empty by design. A test run never seeds merchandise or acknowledges an external write. */
export class EmptyTestAdapter implements OneCAdapter {
  readonly mode = "test" as const;
  async fetchCatalog(cursor: string | null) {
    return { cursor, hasMore: false, products: [], warehouses: [], prices: [], stock: [], arrivals: [] };
  }
  async fetchOrderStatuses(cursor: string | null) { return { cursor, hasMore: false, orders: [] }; }
  async exportOrder(_order: ExportOrder): Promise<never> {
    void _order;
    throw new IntegrationError("TEST_MODE_EXPORT_DISABLED");
  }
  async findClient(_query: ClientQuery) { void _query; return { client: null }; }
  async operateBonus(_operation: BonusRequest): Promise<never> {
    void _operation;
    throw new IntegrationError("TEST_MODE_BONUS_DISABLED");
  }
}

export function createAdapter(mode = process.env.ONE_C_MODE ?? "test"): OneCAdapter {
  if (mode === "test") return new EmptyTestAdapter();
  // Add an authenticated transport only after the 1C API contract is supplied.
  // Merely setting a URL/token must never pretend that a live integration exists.
  if (mode === "live") throw new IntegrationError("LIVE_ADAPTER_NOT_CONFIGURED");
  throw new IntegrationError("INVALID_ONE_C_MODE");
}
