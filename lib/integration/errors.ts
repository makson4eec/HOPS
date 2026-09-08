import { z } from "zod";

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 120_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export class IntegrationError extends Error {
  constructor(public readonly code: string, public readonly retryable = false) {
    super(code);
    this.name = "IntegrationError";
  }
}

/** No exception text, payloads, credentials or customer data go to the exchange log. */
export function publicFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof IntegrationError) {
    const allowed = /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code);
    return { code: allowed ? error.code : "INTEGRATION_ERROR", retryable: error.retryable };
  }
  if (error instanceof z.ZodError) return { code: "INVALID_ADAPTER_DATA", retryable: false };
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "P2002") return { code: "EXTERNAL_ID_CONFLICT", retryable: false };
    if (error.code === "P2034") return { code: "CONCURRENT_UPDATE", retryable: true };
    if (error.code === "P2010" && "meta" in error && error.meta && typeof error.meta === "object" && "code" in error.meta && ["40001", "40P01"].includes(String(error.meta.code))) return { code: "CONCURRENT_UPDATE", retryable: true };
    if (["P1001", "P1002", "P1017", "P2024", "P2028"].includes(String(error.code))) return { code: "DATABASE_TEMPORARILY_UNAVAILABLE", retryable: true };
  }
  return { code: "EXCHANGE_FAILED", retryable: true };
}

export function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 15_000 * 2 ** Math.min(20, Math.max(0, Math.floor(attempt) - 1)));
}

export function shouldRetry(attempt: number, retryable: boolean): boolean {
  return retryable && attempt < MAX_ATTEMPTS;
}

export function isNewer(incoming: string, current: Date | null): boolean {
  return current === null || new Date(incoming).getTime() > current.getTime();
}

export async function requestWithTimeout<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new IntegrationError("ADAPTER_TIMEOUT", true)); }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
