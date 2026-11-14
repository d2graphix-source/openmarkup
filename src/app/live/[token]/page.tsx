import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin.ts";
import { adminConfigured } from "@/lib/env.ts";
import { TOKEN } from "@/review/lib.ts";
import { reviewContext } from "@/review/context.ts";
import { ReviewScreen } from "@/components/ReviewScreen.tsx";

export const metadata = { title: "Review a website · OpenMarkup", robots: { index: false, follow: false } };

// The public review page: no login. The link is checked first; anything wrong looks like "not found".
export default async function GuestReview({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN.test(token) || !adminConfigured()) notFound();
  const { data: link } = await createAdminClient().from("review_share_links").select("review_id").eq("token", token).maybeSingle();
  if (!link) notFound();
  const ctx = await reviewContext(link.review_id, token);
  if (!ctx) notFound();
  const closedNote = ctx.review.status === "completed" ? "This review is finished. You can still look around." : "Comments are paused for a moment. You can still look around.";
  return <ReviewScreen layout="full" canFinish reviewId={ctx.review.id} siteOrigin={ctx.review.site_origin} startPath={ctx.review.start_path} token={token} title={ctx.review.title} user={null} canComment={ctx.canComment} closedNote={closedNote} />;
}
