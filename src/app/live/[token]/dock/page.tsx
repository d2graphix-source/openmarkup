import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin.ts";
import { adminConfigured } from "@/lib/env.ts";
import { TOKEN, VIEWPORT_NAMES } from "@/review/lib.ts";
import { reviewContext } from "@/review/context.ts";
import { OnsiteDock } from "@/components/OnsiteDock.tsx";

export const metadata = { title: "Review comments", robots: { index: false, follow: false } };

// The comment dock that the OpenMarkup script (review-assets/openmarkup.js) puts on a site's real, logged-in page.
// Same share link rules as /live/<code>: anything wrong looks like "not found".
export default async function OnsiteDockPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ vp?: string }> }) {
  const { token } = await params;
  const { vp } = await searchParams;
  if (!TOKEN.test(token) || !adminConfigured()) notFound();
  const { data: link } = await createAdminClient().from("review_share_links").select("review_id").eq("token", token).maybeSingle();
  if (!link) notFound();
  const ctx = await reviewContext(link.review_id, token);
  if (!ctx) notFound();
  const viewport = (VIEWPORT_NAMES as readonly string[]).includes(vp ?? "") ? vp! : VIEWPORT_NAMES[0];
  return <OnsiteDock reviewId={ctx.review.id} siteOrigin={ctx.review.site_origin} token={token} title={ctx.review.title} canComment={ctx.canComment} viewport={viewport} />;
}
