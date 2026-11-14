import { notFound, redirect } from "next/navigation";
import { getMember } from "@/lib/session.ts";
import { UUID } from "@/review/lib.ts";
import { reviewContext } from "@/review/context.ts";
import { ReviewScreen } from "@/components/ReviewScreen.tsx";

export const metadata = { title: "Review · OpenMarkup" };

// The review filling the whole window, for members.
export default async function FullReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const member = await getMember();
  if (!member) redirect("/login");
  const ctx = await reviewContext(id);
  if (!ctx) notFound();
  return (
    <ReviewScreen layout="full" canExport canFinish={false} reviewId={ctx.review.id} siteOrigin={ctx.review.site_origin} startPath={ctx.review.start_path} title={ctx.review.title}
      user={{ id: member.id, name: member.name, isGuest: false }} canComment={ctx.canComment} backHref={`/reviews/${id}`} shareHref={`/reviews/${id}#share`} />
  );
}
