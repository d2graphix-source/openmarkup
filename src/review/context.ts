import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server.ts";
import { createAdminClient } from "@/lib/supabase/admin.ts";
import { adminConfigured } from "@/lib/env.ts";
import { getMember } from "@/lib/session.ts";
import type { ReviewThread } from "./shared/protocol.ts";
import { ATTACHMENT_BUCKET, SNAPSHOT_BUCKET, TOKEN, UUID, fromDbViewport, onCurrentSite } from "./lib.ts";

export type ReviewRow = {
  id: string; title: string; site_origin: string; alias_hosts: string[]; start_path: string;
  status: string; comments_paused: boolean; created_by: string;
};
export type Viewer = "member" | "guest";
export type Ctx = { db: SupabaseClient; review: ReviewRow; viewer: Viewer; me: string | null; isAdmin: boolean; canComment: boolean };

export const REVIEW_COLUMNS = "id, title, site_origin, alias_hosts, start_path, status, comments_paused, created_by";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Who is looking at this review, and what they may do. A member reads through their own session, so the database decides
// what they see. A visitor with a share link has no login: the server checks the link first, then acts for them, and only
// on that one review.
export async function reviewContext(reviewId: string, token?: string | null): Promise<Ctx | null> {
  if (!UUID.test(reviewId)) return null;
  if (token) {
    if (!TOKEN.test(token) || !adminConfigured()) return null;
    const admin = createAdminClient();
    const { data: link } = await admin.from("review_share_links").select("review_id, enabled, can_comment, expires_at").eq("token", token).maybeSingle();
    if (!link || !link.enabled || link.review_id !== reviewId) return null;
    if (link.expires_at && Date.parse(link.expires_at) < Date.now()) return null;
    const { data: review } = await admin.from("reviews").select(REVIEW_COLUMNS).eq("id", reviewId).maybeSingle();
    if (!review) return null;
    return { db: admin, review: review as ReviewRow, viewer: "guest", me: null, isAdmin: false,
      canComment: Boolean(link.can_comment) && review.status === "open" && !review.comments_paused };
  }
  const member = await getMember();
  if (!member) return null;
  const db = await createClient();
  const { data: review } = await db.from("reviews").select(REVIEW_COLUMNS).eq("id", reviewId).maybeSingle();
  if (!review) return null;
  return { db, review: review as ReviewRow, viewer: "member", me: member.id, isAdmin: member.isAdmin, canComment: true };
}

// The threads on a review in the shape the screen uses, with comments and readable names.
export async function loadThreads(ctx: Ctx): Promise<ReviewThread[]> {
  const { db, review, viewer, me, isAdmin } = ctx;
  const [{ data: threads }, { data: comments }] = await Promise.all([
    db.from("review_threads").select("id, page_url, page_key, viewport, anchor, author_id, guest_name, resolved_at, created_at, snapshot_path").eq("review_id", review.id).order("created_at"),
    db.from("review_comments").select("id, thread_id, author_id, guest_name, body, created_at, edited_at, attachments").eq("review_id", review.id).order("created_at"),
  ]);
  const ids = [...new Set([...(threads ?? []), ...(comments ?? [])].map((r: Row) => r.author_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await db.from("profiles").select("user_id, display_name").in("user_id", ids);
    for (const p of people ?? []) names.set(p.user_id, p.display_name);
  }
  const label = (r: Row): string => {
    if (!r.author_id) return String(r.guest_name ?? "").trim() || "Guest";
    if (r.author_id === me) return "You";
    return names.get(r.author_id) ?? "Team member";
  };
  // Pictures are private: hand out links that work for a week (long enough for a pasted Markdown brief), signed with the
  // server key only after the caller was allowed to read the threads above.
  const sign = async (bucket: string, paths: string[]) => {
    const out = new Map<string, string>();
    if (!paths.length || !adminConfigured()) return out;
    const { data } = await createAdminClient().storage.from(bucket).createSignedUrls(paths, 7 * 24 * 3600);
    for (const d of data ?? []) if (d.path && d.signedUrl) out.set(d.path, d.signedUrl);
    return out;
  };
  const [shots, attached] = await Promise.all([
    sign(SNAPSHOT_BUCKET, (threads ?? []).map((t: Row) => t.snapshot_path).filter(Boolean) as string[]),
    sign(ATTACHMENT_BUCKET, (comments ?? []).flatMap((c: Row) => (c.attachments ?? []) as string[])),
  ]);
  const member = viewer === "member" && !!me;
  return (threads ?? []).map((t: Row) => ({
    id: t.id, pageUrl: onCurrentSite(t.page_url, review.site_origin), pageKey: t.page_key, viewport: fromDbViewport(t.viewport), anchor: t.anchor,
    resolved: Boolean(t.resolved_at), createdAt: t.created_at, snapshotUrl: t.snapshot_path ? shots.get(t.snapshot_path) ?? null : null,
    comments: (comments ?? []).filter((c: Row) => c.thread_id === t.id)
      .map((c: Row) => ({ id: c.id, authorId: c.author_id ?? `guest:${label(c)}`, authorName: label(c), body: c.body, createdAt: c.created_at,
        editedAt: c.edited_at ?? null, canEdit: member && c.author_id === me, canDelete: member && (c.author_id === me || isAdmin),
        images: ((c.attachments ?? []) as string[]).map((p) => attached.get(p)).filter(Boolean) as string[] })),
  }));
}
