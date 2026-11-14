// A review written out as Markdown, so it can be pasted into a chat with an AI tool, a ticket or a brief for a developer.
// Pure: no imports from the app (types only), so it can be unit-tested directly.
import type { ReviewThread } from "./shared/protocol.ts";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");

export function reviewToMarkdown(review: { title: string; site_origin: string }, threads: ReviewThread[]): string {
  const open = threads.filter((t) => !t.resolved).length;
  const lines: string[] = [
    `# ${oneLine(review.title) || "Website review"}`,
    "",
    `Site: ${review.site_origin}`,
    `Comments: ${open} open, ${threads.length - open} resolved`,
  ];
  // Group by screen size, then by page, in the order people made them.
  const sizes = [...new Set(threads.map((t) => t.viewport))];
  let n = 0;
  for (const size of sizes) {
    lines.push("", `## ${size}`);
    const mine = threads.filter((t) => t.viewport === size);
    const pages = [...new Set(mine.map((t) => t.pageKey))];
    for (const page of pages) {
      for (const t of mine.filter((x) => x.pageKey === page)) {
        n++;
        const a = t.anchor;
        lines.push("", `### Change ${n}${t.resolved ? " (resolved)" : ""}`);
        lines.push(`Page: ${t.pageUrl}`);
        if (a?.selector) lines.push(`Element: \`${a.selector}\``);
        if (a?.text) lines.push(`Element text: "${oneLine(a.text).slice(0, 200)}"`);
        if (a?.viewport) lines.push(`Viewport: ${size} (${a.viewport.w}×${a.viewport.h})`);
        if (t.snapshotUrl) lines.push(`Screenshot around the click: ${t.snapshotUrl}`);
        const [first, ...replies] = t.comments;
        const pics = (c: { images?: string[] }) => (c.images ?? []).map((u, i) => `Attached image ${i + 1}: ${u}`);
        if (first) lines.push("", `${first.authorName}:`, quote(first.body), ...pics(first));
        for (const r of replies) lines.push("", `${r.authorName} replied:`, quote(r.body), ...pics(r));
      }
    }
  }
  if (!threads.length) lines.push("", "No comments yet.");
  return lines.join("\n") + "\n";
}
