import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server.ts";
import { getMember } from "@/lib/session.ts";
import { startReviewAction } from "@/review/actions.ts";
import { Notices, Shell } from "@/components/Shell.tsx";

export const metadata = { title: "Reviews · OpenMarkup" };

export default async function Home({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams;
  const member = await getMember();
  if (!member) redirect("/login");
  const db = await createClient();
  const { data: reviews } = await db.from("reviews").select("id, title, site_origin, status, created_at").order("created_at", { ascending: false }).limit(200);
  const ids = (reviews ?? []).map((r) => r.id);
  const { data: open } = ids.length ? await db.from("review_threads").select("review_id").in("review_id", ids).is("resolved_at", null) : { data: [] as { review_id: string }[] };
  const count = new Map<string, number>();
  for (const t of open ?? []) count.set(t.review_id, (count.get(t.review_id) ?? 0) + 1);
  return (
    <Shell member={member}>
      <h1 className="om-h1">Reviews</h1>
      <Notices done={sp.done} error={sp.error} />
      <section className="om-card om-card--flush">
        {(reviews ?? []).length === 0 ? <p className="om-empty">No reviews yet. Start one below.</p> : (
          <table className="om-table">
            <thead><tr><th>Review</th><th>Status</th><th className="om-hide-sm">Started</th></tr></thead>
            <tbody>
              {reviews!.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/reviews/${r.id}`}><strong>{r.title}</strong></Link><span className="om-sub">{r.site_origin.replace(/^https?:\/\//, "")}</span></td>
                  <td><span className="om-pill">{r.status === "completed" ? "Completed" : count.get(r.id) ? `${count.get(r.id)} open` : "No comments yet"}</span></td>
                  <td className="om-hide-sm om-muted">{new Date(r.created_at).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="om-card">
        <h2 className="om-h2">Start a review</h2>
        <form action={startReviewAction} className="om-stack">
          <div><label className="om-label" htmlFor="url">Page to start from</label>
            <input id="url" name="url" className="om-input" required placeholder="https://example.com/" autoCapitalize="none" inputMode="url" /></div>
          <div><label className="om-label" htmlFor="title">Title</label>
            <input id="title" name="title" className="om-input" maxLength={200} placeholder="Website review" /></div>
          <p className="om-muted" style={{ margin: 0, fontSize: 13 }}>The site needs the OpenMarkup script in its head. You’ll find the line to add on the review page, or in the <a href="/setup.md">setup guide</a>.</p>
          <div><button className="om-btn">Start a review</button></div>
        </form>
      </section>
    </Shell>
  );
}
