import { handleRpc, memberForKey } from "@/mcp/server.ts";

// The Claude connection. The address itself carries the member's key, so keep it private like a password.
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const who = await memberForKey((await params).key);
  if (!who) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This connection key isn't valid. Make a new one on your OpenMarkup account page." } }, 401);
  let body: unknown;
  try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(who, m)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const answer = await handleRpc(who, body as Record<string, unknown>);
  return answer ? json(answer) : new Response(null, { status: 202 });
}

// No server-to-client stream and no sessions.
export async function GET() { return new Response(null, { status: 405, headers: { allow: "POST" } }); }
export async function DELETE() { return new Response(null, { status: 405, headers: { allow: "POST" } }); }
