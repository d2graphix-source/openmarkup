import { loadThreads, reviewContext } from "@/review/context.ts";
import { reviewToMarkdown } from "@/review/markdown.ts";

// The review as a .md file. Members only.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await reviewContext(id);
  if (!ctx) return new Response("Not found", { status: 404 });
  const md = reviewToMarkdown(ctx.review, await loadThreads(ctx));
  const name = (ctx.review.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "review").slice(0, 60);
  return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${name}.md"`, "cache-control": "no-store" } });
}
