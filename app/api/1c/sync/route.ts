// 1C publishes private files on the shop PC; HTTP exchange is retired.
export function GET() { return Response.json({ error: "Use local JSON exchange" }, { status: 410 }); }
export const POST = GET;
