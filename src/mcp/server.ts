import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin.ts";
import { adminConfigured, appOrigin } from "@/lib/env.ts";
import { REVIEW_COLUMNS, loadThreads, type Ctx, type ReviewRow } from "@/review/context.ts";
import { reviewToMarkdown } from "@/review/markdown.ts";
import { UUID } from "@/review/lib.ts";

// The Claude connection (MCP, "Streamable HTTP" without sessions). Claude posts JSON-RPC to /api/mcp/<key>; the key belongs
// to one member, and every tool acts as that member. Answers are plain JSON, never a stream.

export const KEY = /^om_[A-Za-z0-9_-]{40,60}$/;
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

type Who = { id: string; isAdmin: boolean };
type Json = Record<string, unknown>;

/** The member a connection key belongs to, or null. */
export async function memberForKey(key: string): Promise<Who | null> {
  if (!KEY.test(key) || !adminConfigured()) return null;
  const db = createAdminClient();
  const { data: k } = await db.from("mcp_keys").select("user_id").eq("key_hash", hashKey(key)).maybeSingle();
  if (!k) return null;
  const { data: p } = await db.from("profiles").select("is_admin").eq("user_id", k.user_id).maybeSingle();
  if (!p) return null;
  void db.from("mcp_keys").update({ last_used_at: new Date().toISOString() }).eq("user_id", k.user_id).then(() => undefined);
  return { id: k.user_id, isAdmin: Boolean(p.is_admin) };
}

const TOOLS = [
  {
    name: "list_reviews",
    description: "List the website reviews in OpenMarkup, newest first, with how many comments are open on each.",
    inputSchema: { type: "object", properties: { include_completed: { type: "boolean", description: "Also list reviews marked completed. Default false." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_review",
    description: "Every comment on one review as Markdown: page, element selector and text, screen size, screenshot and image links, and replies. Each comment has an id to use with reply_to_comment and resolve_comment.",
    inputSchema: { type: "object", required: ["review_id"], properties: { review_id: { type: "string" }, open_only: { type: "boolean", description: "Leave out resolved comments. Default false." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "reply_to_comment",
    description: "Add a reply to a comment, as the person who owns this connection. Use it to say what was changed.",
    inputSchema: { type: "object", required: ["review_id", "comment_id", "text"], properties: { review_id: { type: "string" }, comment_id: { type: "string" }, text: { type: "string", maxLength: 5000 } } },
  },
  {
    name: "resolve_comment",
    description: "Mark a comment resolved (done), or reopen it with resolved=false.",
    inputSchema: { type: "object", required: ["review_id", "comment_id"], properties: { review_id: { type: "string" }, comment_id: { type: "string" }, resolved: { type: "boolean", description: "Default true." } } },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function ctxFor(who: Who, reviewId: unknown): Promise<Ctx | null> {
  if (typeof reviewId !== "string" || !UUID.test(reviewId)) return null;
  const db = createAdminClient();
  const { data: review } = await db.from("reviews").select(REVIEW_COLUMNS).eq("id", reviewId).maybeSingle();
  if (!review) return null;
  return { db, review: review as ReviewRow, viewer: "member", me: who.id, isAdmin: who.isAdmin, canComment: true };
}

async function callTool(who: Who, name: string, args: Json) {
  const db = createAdminClient();
  if (name === "list_reviews") {
    let q = db.from("reviews").select("id, title, site_origin, status, created_at").order("created_at", { ascending: false }).limit(100);
    if (!args.include_completed) q = q.eq("status", "open");
    const { data: reviews } = await q;
    if (!reviews?.length) return text("No reviews yet.");
    const { data: open } = await db.from("review_threads").select("review_id").in("review_id", reviews.map((r) => r.id)).is("resolved_at", null);
    const counts = new Map<string, number>();
    for (const t of open ?? []) counts.set(t.review_id, (counts.get(t.review_id) ?? 0) + 1);
    return text(reviews.map((r) => `- ${r.title} (${r.site_origin}) · ${counts.get(r.id) ?? 0} open · ${r.status}\n  review_id: ${r.id}\n  ${appOrigin()}/reviews/${r.id}`).join("\n"));
  }
  const ctx = await ctxFor(who, args.review_id);
  if (!ctx) return text("No review with that review_id. Use list_reviews to find it.", true);
  if (name === "get_review") {
    let threads = await loadThreads(ctx);
    if (args.open_only) threads = threads.filter((t) => !t.resolved);
    return text(reviewToMarkdown(ctx.review, threads, { ids: true }));
  }
  const threadId = args.comment_id;
  if (typeof threadId !== "string" || !UUID.test(threadId)) return text("comment_id is missing or wrong. Use get_review to find it.", true);
  const { data: t } = await db.from("review_threads").select("id").eq("id", threadId).eq("review_id", ctx.review.id).maybeSingle();
  if (!t) return text("That comment isn't on this review.", true);
  if (name === "reply_to_comment") {
    const body = String(args.text ?? "").trim();
    if (!body || body.length > 5000) return text("Write the reply in text (up to 5000 characters).", true);
    const { error } = await db.from("review_comments").insert({ thread_id: t.id, review_id: ctx.review.id, author_id: who.id, body });
    return error ? text("The reply couldn't be saved.", true) : text("Reply added.");
  }
  if (name === "resolve_comment") {
    const resolved = args.resolved !== false;
    const { error } = await db.from("review_threads").update({ resolved_at: resolved ? new Date().toISOString() : null, resolved_by: resolved ? who.id : null }).eq("id", t.id);
    return error ? text("That couldn't be changed.", true) : text(resolved ? "Marked resolved." : "Reopened.");
  }
  return null;
}

/** One JSON-RPC message in, one answer out (null for notifications). */
export async function handleRpc(who: Who, msg: Json): Promise<Json | null> {
  const id = msg.id ?? null;
  const method = String(msg.method ?? "");
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (msg.id === undefined) return null; // notifications/initialized and friends need no answer
  switch (method) {
    case "initialize": {
      const asked = (msg.params as Json | undefined)?.protocolVersion;
      return ok({
        protocolVersion: typeof asked === "string" ? asked : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "openmarkup", version: "1.0.0" },
        instructions: "OpenMarkup holds comments pinned to live websites. list_reviews finds a review, get_review reads its comments, reply_to_comment and resolve_comment report back on what was fixed.",
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const p = (msg.params ?? {}) as Json;
      const result = await callTool(who, String(p.name ?? ""), (p.arguments ?? {}) as Json).catch(() => text("Something went wrong.", true));
      return result ? ok(result) : err(-32602, "Unknown tool");
    }
    default: return err(-32601, "Method not found");
  }
}
