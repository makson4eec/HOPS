import next from "next";
import { createServer } from "node:http";

process.env.NODE_ENV = "production";
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be 1024..65535");
const hostname = "127.0.0.1";
const app = next({ dev: false, hostname, port });
await app.prepare();
const server = createServer(app.getRequestHandler());
server.listen(port, hostname, () => console.log(`HOPS listening on http://${hostname}:${port}`));
server.on("error", error => { console.error(error); process.exitCode = 1; void app.close(); });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000); deadline.unref();
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
  await app.close(); clearTimeout(deadline); process.exit(0);
}
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.on("message", message => { if (message === "shutdown") void stop(); });
