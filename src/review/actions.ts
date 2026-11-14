"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server.ts";
import { createAdminClient } from "@/lib/supabase/admin.ts";
import { adminConfigured } from "@/lib/env.ts";
import { getMember } from "@/lib/session.ts";
import { cleanImages, type ReviewComment, type ReviewThread, type ThreadDraft } from "./shared/protocol.ts";
import { loadThreads, reviewContext } from "./context.ts";
import { reviewToMarkdown } from "./markdown.ts";
import { ATTACHMENT_BUCKET, SNAPSHOT_BUCKET, UUID, cleanName, pageBelongsToSite, parseSite, toDbViewport } from "./lib.ts";

const MAX_GUEST_THREADS = 300;
type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });
const msg = (m: string) => encodeURIComponent(m);

// ------------------------------------------------------------------ members: start and manage a review

export async function startReviewAction(form: FormData) {
  const member = await getMember();
  if (!member) redirect("/login");
  const bad = (m: string) => redirect(`/?error=${msg(m)}`);
  const title = String(form.get("title") ?? "").trim() || "Website review";
  if (title.length > 200) bad("That title is too long.");
  const site = parseSite(String(form.get("url") ?? ""));
  if (!site.ok) bad(site.error);
  const s = site as { ok: true; origin: string; startPath: string };
  const supabase = await createClient();
  const { data, error } = await supabase.from("reviews")
    .insert({ title, site_origin: s.origin, start_path: s.startPath, created_by: member!.id }).select("id").single();
  if (error || !data) bad("We couldn’t start that review.");
  revalidatePath("/");
  redirect(`/reviews/${data!.id}`);
}

async function memberReview(form: FormData) {
  const member = await getMember();
  if (!member) redirect("/login");
  const id = String(form.get("review_id") ?? "");
  if (!UUID.test(id)) redirect("/");
  return { id, back: `/reviews/${id}`, member: member!, supabase: await createClient() };
}

// Pause or resume guest comments; mark the review completed or open again.
export async function setReviewStateAction(form: FormData) {
  const { id, back, supabase } = await memberReview(form);
  const what = String(form.get("what") ?? "");
  const patch = what === "pause" ? { comments_paused: true } : what === "resume" ? { comments_paused: false }
    : what === "complete" ? { status: "completed" } : what === "reopen" ? { status: "open" } : null;
  if (!patch) redirect(back);
  const { data, error } = await supabase.from("reviews").update(patch).eq("id", id).select("id").maybeSingle();
  if (error || !data) redirect(`${back}?error=${msg("We couldn’t change that.")}`);
  revalidatePath(back);
  redirect(`${back}?done=${msg("Saved.")}`);
}

// Make (or switch on again, or turn off) the link for people with no login.
export async function shareLinkAction(form: FormData) {
  const { id, back, member, supabase } = await memberReview(form);
  const what = String(form.get("what") ?? "");
  const { data: link } = await supabase.from("review_share_links").select("review_id").eq("review_id", id).maybeSingle();
  const fresh = (can_comment: boolean) => ({ review_id: id, token: randomBytes(32).toString("base64url"), can_comment, created_by: member.id });
  if (what === "off") {
    await supabase.from("review_share_links").update({ enabled: false }).eq("review_id", id);
  } else if (what === "view" || what === "comment") {
    const can_comment = what === "comment";
    if (link) await supabase.from("review_share_links").update({ enabled: true, can_comment }).eq("review_id", id);
    else await supabase.from("review_share_links").insert(fresh(can_comment));
  } else if (what === "new") {
    // A fresh address; the old one stops working.
    await supabase.from("review_share_links").delete().eq("review_id", id);
    await supabase.from("review_share_links").insert(fresh(true));
  }
  revalidatePath(back);
  redirect(`${back}#share`);
}

export async function renameReviewAction(form: FormData) {
  const { id, back, supabase } = await memberReview(form);
  const title = String(form.get("title") ?? "").replace(/\s+/g, " ").trim();
  if (!title || title.length > 200) redirect(`${back}?error=${msg("Give the review a short title.")}`);
  const { data, error } = await supabase.from("reviews").update({ title }).eq("id", id).select("id").maybeSingle();
  if (error || !data) redirect(`${back}?error=${msg("We couldn’t rename that.")}`);
  revalidatePath(back); revalidatePath("/");
  redirect(`${back}?done=${msg("Renamed.")}`);
}

// Delete a review for good (its starter or an admin, and only with the confirm box selected).
export async function deleteReviewAction(form: FormData) {
  const { id, back, supabase } = await memberReview(form);
  if (form.get("confirm") !== "on") redirect(`${back}?error=${msg("Select the box to confirm the delete.")}`);
  const { error } = await supabase.rpc("delete_review", { p_id: id });
  if (error) redirect(`${back}?error=${msg("Only the person who started this review, or an admin, can delete it.")}`);
  revalidatePath("/");
  redirect(`/?done=${msg("Review deleted.")}`);
}

// The site went live on a new address (for example from a vercel.app preview to its real domain). Point the review there.
// The old address stays as an alias, so pins made on it still count, and they show on the new address (matched by page path).
export async function changeSiteAction(form: FormData) {
  const { id, back, supabase } = await memberReview(form);
  const site = parseSite(String(form.get("site") ?? ""));
  if (!site.ok) redirect(`${back}?error=${msg(site.error)}`);
  const s = site as { ok: true; origin: string };
  const { data: r } = await supabase.from("reviews").select("site_origin, alias_hosts").eq("id", id).maybeSingle();
  if (!r) redirect(`${back}?error=${msg("This review isn’t available.")}`);
  if (r!.site_origin === s.origin) redirect(`${back}?done=${msg("That is already the address.")}`);
  const newHost = new URL(s.origin).hostname;
  const aliases = [...new Set([...(r!.alias_hosts ?? []), new URL(r!.site_origin).hostname])].filter((h) => h !== newHost).slice(0, 20);
  const { error } = await supabase.from("reviews").update({ site_origin: s.origin, alias_hosts: aliases }).eq("id", id);
  if (error) redirect(`${back}?error=${msg("We couldn’t change the address.")}`);
  revalidatePath(back);
  redirect(`${back}?done=${msg(`Now reviewing ${newHost}. Every comment moved with it.`)}`);
}

export async function renameMeAction(form: FormData) {
  const member = await getMember();
  if (!member) redirect("/login");
  const name = cleanName(form.get("display_name"));
  if (!name) redirect(`/account?error=${msg("Enter a name.")}`);
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ display_name: name }).eq("user_id", member!.id);
  redirect(error ? `/account?error=${msg("We couldn’t save that.")}` : `/account?done=${msg("Saved.")}`);
}

// ------------------------------------------------------------------ the review screen's data calls
// Called from the browser by the review screen. Each one first works out who is asking (a member, or a share link) and
// what they may do on that one review.

export async function loadThreadsAction(reviewId: string, token: string | null): Promise<{ ok: true; threads: ReviewThread[] } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx) return fail("This review isn’t available.");
  return { ok: true, threads: await loadThreads(ctx) };
}

export async function createThreadAction(
  reviewId: string, token: string | null, input: { draft: ThreadDraft; viewport: string; name?: string },
): Promise<{ ok: true; thread: ReviewThread } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx) return fail("This review isn’t available.");
  if (!ctx.canComment) return fail("Comments are closed on this review.");
  const { draft } = input;
  const body = String(draft?.body ?? "").trim();
  const images = cleanImages(draft?.images);
  if ((!body && !images.length) || body.length > 5000) return fail("Write a comment first.");
  if (!pageBelongsToSite(draft.pageUrl, ctx.review.site_origin, ctx.review.alias_hosts)) return fail("That page isn’t part of this review.");
  if (!draft.anchor || typeof draft.anchor !== "object" || JSON.stringify(draft.anchor).length > 7000) return fail("We couldn’t place that comment.");
  const guest = ctx.viewer === "guest";
  const name = cleanName(input.name);
  if (guest && !name) return fail("Please tell us your name first.");
  if (guest) {
    const { count } = await ctx.db.from("review_threads").select("id", { count: "exact", head: true }).eq("review_id", ctx.review.id).is("author_id", null);
    if ((count ?? 0) >= MAX_GUEST_THREADS) return fail("This review has reached its comment limit.");
  }
  const who = guest ? { author_id: null, guest_name: name } : { author_id: ctx.me, guest_name: null };
  const { data: t, error } = await ctx.db.from("review_threads").insert({
    review_id: ctx.review.id, page_url: draft.pageUrl, page_key: draft.pageKey, viewport: toDbViewport(input.viewport), anchor: draft.anchor, ...who,
  }).select("id").single();
  if (error || !t) return fail("We couldn’t save that comment.");
  const { data: c, error: cErr } = await ctx.db.from("review_comments").insert({ thread_id: t.id, review_id: ctx.review.id, body, ...who }).select("id").single();
  if (cErr || !c) { await ctx.db.from("review_threads").delete().eq("id", t.id); return fail("We couldn’t save that comment."); }
  await saveSnapshot(ctx.review.id, t.id, draft.snapshot);
  await saveAttachments(ctx.review.id, c.id, images);
  const thread = (await loadThreads(ctx)).find((x) => x.id === t.id);
  return thread ? { ok: true, thread } : fail("Saved, but we couldn’t show it. Reload the page.");
}

export async function addCommentAction(
  reviewId: string, token: string | null, input: { threadId: string; body: string; images?: string[]; name?: string },
): Promise<{ ok: true; comment: ReviewComment } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx) return fail("This review isn’t available.");
  if (!ctx.canComment) return fail("Comments are closed on this review.");
  const body = String(input.body ?? "").trim();
  const images = cleanImages(input.images);
  if (!UUID.test(input.threadId) || (!body && !images.length) || body.length > 5000) return fail("Write a reply first.");
  const guest = ctx.viewer === "guest";
  const name = cleanName(input.name);
  if (guest && !name) return fail("Please tell us your name first.");
  const { data: t } = await ctx.db.from("review_threads").select("id").eq("id", input.threadId).eq("review_id", ctx.review.id).maybeSingle();
  if (!t) return fail("That comment isn’t available.");
  const who = guest ? { author_id: null, guest_name: name } : { author_id: ctx.me, guest_name: null };
  const { data, error } = await ctx.db.from("review_comments").insert({ thread_id: t.id, review_id: ctx.review.id, body, ...who }).select("id, created_at").single();
  if (error || !data) return fail("We couldn’t save that reply.");
  const paths = await saveAttachments(ctx.review.id, data.id, images);
  return { ok: true, comment: { id: data.id, authorId: ctx.me ?? `guest:${name}`, authorName: guest ? name : "You", body, createdAt: data.created_at, editedAt: null, canEdit: !guest, canDelete: !guest, images: await signAttachments(paths) } };
}

// Change the words of your own comment. Guests can't: a name typed into a share link doesn't prove who wrote what.
export async function editCommentAction(reviewId: string, token: string | null, input: { commentId: string; body: string }): Promise<{ ok: true; editedAt: string } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx || !UUID.test(input.commentId)) return fail("This review isn’t available.");
  if (ctx.viewer === "guest") return fail("Sign in to change a comment.");
  const body = String(input.body ?? "").trim();
  if (!body || body.length > 5000) return fail("Write a comment first.");
  const { data, error } = await ctx.db.from("review_comments").update({ body }).eq("id", input.commentId).eq("review_id", ctx.review.id).eq("author_id", ctx.me!).select("edited_at").maybeSingle();
  return error || !data ? fail("You can only change your own comments.") : { ok: true, editedAt: data.edited_at };
}

// Members remove their own comments (admins any). Removing the first comment of a pin removes the pin and its replies.
export async function deleteCommentAction(reviewId: string, token: string | null, input: { threadId: string; commentId: string }): Promise<{ ok: true; thread: boolean } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx || !UUID.test(input.commentId) || !UUID.test(input.threadId)) return fail("This review isn’t available.");
  if (ctx.viewer !== "member") return fail("Sign in to remove comments.");
  const { data: first } = await ctx.db.from("review_comments").select("id, author_id").eq("thread_id", input.threadId).eq("review_id", ctx.review.id).order("created_at").limit(1).maybeSingle();
  if (!first) return fail("That comment isn’t available.");
  if (first.id === input.commentId) {
    const { data, error } = await ctx.db.from("review_threads").delete().eq("id", input.threadId).eq("review_id", ctx.review.id).select("id").maybeSingle();
    return error || !data ? fail("You can only remove your own comments.") : { ok: true, thread: true };
  }
  const { data, error } = await ctx.db.from("review_comments").delete().eq("id", input.commentId).eq("thread_id", input.threadId).select("id").maybeSingle();
  return error || !data ? fail("You can only remove your own comments.") : { ok: true, thread: false };
}

export async function setResolvedAction(reviewId: string, token: string | null, threadId: string, resolved: boolean): Promise<{ ok: true } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx || !UUID.test(threadId)) return fail("This review isn’t available.");
  if (!ctx.canComment) return fail("Comments are closed on this review.");
  const { data, error } = await ctx.db.from("review_threads").update({ resolved_at: resolved ? new Date().toISOString() : null }).eq("id", threadId).eq("review_id", ctx.review.id).select("id").maybeSingle();
  return error || !data ? fail("We couldn’t change that.") : { ok: true };
}

export async function deleteThreadAction(reviewId: string, token: string | null, threadId: string): Promise<{ ok: true } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx || !UUID.test(threadId)) return fail("This review isn’t available.");
  if (ctx.viewer === "guest") return fail("Sign in to remove comments.");
  const { data, error } = await ctx.db.from("review_threads").delete().eq("id", threadId).eq("review_id", ctx.review.id).select("id").maybeSingle();
  return error || !data ? fail("You can only remove your own comments.") : { ok: true };
}

// ------------------------------------------------------------------ markdown export and "finished reviewing"

// The whole review as Markdown, for pasting into an AI chat, an issue or a brief. Members only.
export async function reviewMarkdownAction(reviewId: string): Promise<{ ok: true; markdown: string } | Fail> {
  const ctx = await reviewContext(reviewId);
  if (!ctx) return fail("This review isn’t available.");
  return { ok: true, markdown: reviewToMarkdown(ctx.review, await loadThreads(ctx)) };
}

// "I've finished reviewing": lets the team know. Works for members and for people with the share link (who give a name).
export async function finishReviewAction(reviewId: string, token: string | null, name?: string): Promise<{ ok: true } | Fail> {
  const ctx = await reviewContext(reviewId, token);
  if (!ctx) return fail("This review isn’t available.");
  const guest = ctx.viewer === "guest";
  const who = cleanName(name);
  if (guest && !who) return fail("Please tell us your name first.");
  const { error } = await ctx.db.from("review_events").insert({ review_id: ctx.review.id, kind: "finished", actor_id: guest ? null : ctx.me, actor_name: guest ? who : null });
  return error ? fail("We couldn’t send that. Please try again.") : { ok: true };
}

// ------------------------------------------------------------------ pictures (server side only, after the checks above)

// Keeps the picture of the screen around a new comment's click. Best effort: a comment never fails because of its picture.
async function saveSnapshot(reviewId: string, threadId: string, snapshot: unknown): Promise<void> {
  if (typeof snapshot !== "string" || !snapshot.startsWith("data:image/jpeg;base64,") || snapshot.length > 600_000 || !adminConfigured()) return;
  try {
    const bytes = Buffer.from(snapshot.slice("data:image/jpeg;base64,".length), "base64");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return; // not a JPEG
    const path = `${reviewId}/${threadId}.jpg`;
    const admin = createAdminClient();
    const { error } = await admin.storage.from(SNAPSHOT_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: true });
    if (!error) await admin.from("review_threads").update({ snapshot_path: path }).eq("id", threadId);
  } catch { /* the comment is saved; the picture is a bonus */ }
}

// Keeps the pictures a commenter attached. Best effort per picture: the words are already saved.
async function saveAttachments(reviewId: string, commentId: string, images: string[]): Promise<string[]> {
  if (!images.length || !adminConfigured()) return [];
  const admin = createAdminClient();
  const paths: string[] = [];
  for (const [i, img] of images.entries()) {
    try {
      const bytes = Buffer.from(img.slice("data:image/jpeg;base64,".length), "base64");
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue; // not a JPEG
      const path = `${reviewId}/${commentId}-${i + 1}.jpg`;
      const { error } = await admin.storage.from(ATTACHMENT_BUCKET).upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (!error) paths.push(path);
    } catch { /* skip this picture */ }
  }
  if (paths.length) await admin.from("review_comments").update({ attachments: paths }).eq("id", commentId);
  return paths;
}

async function signAttachments(paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const { data } = await createAdminClient().storage.from(ATTACHMENT_BUCKET).createSignedUrls(paths, 7 * 24 * 3600);
  return (data ?? []).map((d) => d.signedUrl).filter(Boolean) as string[];
}
