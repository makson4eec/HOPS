import "server-only";
import mockCatalog from "./mock.json";
import { getOneCConfig, validateOneCConfig, type OneCConfig } from "./config";
import { OneCError } from "./errors";

const MAX_BYTES = 10 * 1024 * 1024;

export async function fetchOneCProducts(config: OneCConfig = getOneCConfig()): Promise<unknown> {
  validateOneCConfig(config);
  if (config.useMock) return structuredClone(mockCatalog);
  const headers: Record<string, string> = { Accept: "application/json" };
  // Bearer takes precedence; a request never sends both authentication methods.
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  else if (config.login && config.password) headers.Authorization = `Basic ${Buffer.from(`${config.login}:${config.password}`).toString("base64")}`;
  try {
    const response = await fetch(config.apiUrl, {
      headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new OneCError("ONE_C_HTTP_ERROR");
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new OneCError("ONE_C_RESPONSE_TOO_LARGE");
    }
    if (!response.body) throw new OneCError("ONE_C_EMPTY_RESPONSE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new OneCError("ONE_C_RESPONSE_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new OneCError("ONE_C_INVALID_JSON"); }
  } catch (error) {
    if (error instanceof OneCError) throw error;
    throw new OneCError("ONE_C_CONNECTION_FAILED");
  }
}
