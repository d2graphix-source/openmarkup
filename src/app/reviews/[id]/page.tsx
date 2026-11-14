import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server.ts";
import { getMember } from "@/lib/session.ts";
import { appOrigin } from "@/lib/env.ts";
import { UUID, onsiteLink } from "@/review/lib.ts";
import { REVIEW_COLUMNS } from "@/review/context.ts";
import { changeSiteAction, deleteReviewAction, renameReviewAction, setReviewStateAction, shareLinkAction } from "@/review/actions.ts";
import { ReviewScreen } from "@/components/ReviewScreen.tsx";
import { CopyLink } from "@/components/CopyLink.tsx";
import { Notices, Shell } from "@/components/Shell.tsx";

export const metadata = { title: "Review · OpenMarkup" };

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string; error?: string; edit?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const member = await getMember();
  if (!member) redirect("/login");
  const db = await createClient();
  const { data: r } = await db.from("reviews").select(REVIEW_COLUMNS).eq("id", id).maybeSingle();
  if (!r) notFound();
  const [{ data: link }, { data: events }] = await Promise.all([
    db.from("review_share_links").select("token, enabled, can_comment").eq("review_id", id).maybeSingle(),
    db.from("review_events").select("id, actor_id, actor_name, created_at").eq("review_id", id).eq("kind", "finished").order("created_at", { ascending: false }).limit(20),
  ]);
  const app = appOrigin();
  const shareUrl = link?.enabled ? `${app}/live/${link.token}` : null;
  const canDelete = member.isAdmin || r.created_by === member.id;
  const hidden = (what: string) => <><input type="hidden" name="review_id" value={id} /><input type="hidden" name="what" value={what} /></>;
  const btn = (action: (f: FormData) => Promise<void>, what: string, label: string) => (
    <form action={action} style={{ display: "inline" }}>{hidden(what)}<button className="om-btn om-btn--light om-btn--sm">{label}</button></form>
  );
  return (
    <Shell member={member}>
      <Link href="/" className="om-muted">← All reviews</Link>
      <div className="om-head">
        <div>
          <h1 className="om-h1">{r.title}</h1>
          <p className="om-muted" style={{ margin: 0 }}>{r.site_origin.replace(/^https?:\/\//, "")}{" · "}<Link href={sp.edit === "address" ? `/reviews/${r.id}` : `/reviews/${r.id}?edit=address`} style={{ color: "inherit" }}>{sp.edit === "address" ? "Cancel" : "Change address"}</Link>{r.status === "completed" ? " · Completed" : r.comments_paused ? " · Guest comments paused" : ""}</p>
        </div>
        <div className="om-row">
          {r.comments_paused ? btn(setReviewStateAction, "resume", "Resume guest comments") : btn(setReviewStateAction, "pause", "Pause guest comments")}
          {r.status === "completed" ? btn(setReviewStateAction, "reopen", "Reopen") : btn(setReviewStateAction, "complete", "Mark completed")}
        </div>
      </div>
      <Notices done={sp.done} error={sp.error} />
      {sp.edit === "address" ? (
        <form action={changeSiteAction} className="om-card om-stack" style={{ maxWidth: 560 }}>
          <input type="hidden" name="review_id" value={id} />
          <div><label className="om-label" htmlFor="rv-site">New website address</label>
            <input id="rv-site" name="site" className="om-input" placeholder="https://example.com" required autoFocus /></div>
          <p className="om-muted" style={{ margin: 0, fontSize: 13 }}>Use this when the site goes live on a new domain. Every comment moves to the same page on the new address, and the old address keeps working as an alias.</p>
          <div><button className="om-btn om-btn--sm">Change address</button></div>
        </form>
      ) : null}
      <ReviewScreen reviewId={r.id} siteOrigin={r.site_origin} startPath={r.start_path} user={{ id: member.id, name: member.name, isGuest: false }} canComment canExport fullHref={`/r/${r.id}`} />
      <section className="om-card om-stack">
        <h2 className="om-h2">The OpenMarkup script</h2>
        <p className="om-muted" style={{ margin: 0 }}>The site needs this one line in its head. It does nothing for ordinary visitors. It lets this page show the site and pin comments on it, and it opens the comment panel when someone follows the “For pages behind a login” link. The site must also allow being shown in a frame by this app.</p>
        <pre className="om-pre">{`<script src="${app}/review-assets/openmarkup.js" async></script>`}</pre>
        <p className="om-muted" style={{ margin: 0 }}>Where it goes on WordPress, and everything else: <a href="/setup.md">setup guide (.md)</a>.</p>
      </section>
      {(events ?? []).length ? (
        <section className="om-card">
          <h2 className="om-h2">Finished reviewing</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {events!.map((e) => <li key={e.id}>{e.actor_name ?? "A team member"} · {new Date(e.created_at).toLocaleString("en")}</li>)}
          </ul>
        </section>
      ) : null}
      <section id="share" className="om-card om-stack">
        <h2 className="om-h2">Share with someone who has no login</h2>
        <p className="om-muted" style={{ margin: 0 }}>Anyone with this link can look at the site and, if you allow it, leave comments by giving their name.</p>
        {shareUrl ? (
          <>
            <div><p className="om-label">Review link</p><CopyLink value={shareUrl} /></div>
            <div><p className="om-label">For pages behind a login</p>
              <CopyLink value={onsiteLink(r.site_origin, r.start_path, link!.token)} />
              <p className="om-muted" style={{ margin: "6px 0 0", fontSize: 13 }}>Opens the real app. They log in with their own account and the comment panel appears. The site needs the OpenMarkup script (see above).</p></div>
            <p className="om-muted" style={{ margin: 0 }}>{link?.can_comment ? "People with the link can comment." : "People with the link can look but not comment."}</p>
            <div className="om-row">
              {btn(shareLinkAction, link?.can_comment ? "view" : "comment", link?.can_comment ? "Make it look-only" : "Allow comments")}
              {btn(shareLinkAction, "new", "Make a new link (the old one stops working)")}
              {btn(shareLinkAction, "off", "Turn the link off")}
            </div>
          </>
        ) : (
          <div className="om-row">{btn(shareLinkAction, "comment", "Make a link that allows comments")}{btn(shareLinkAction, "view", "Make a look-only link")}</div>
        )}
      </section>
      <section className="om-card om-stack">
        <h2 className="om-h2">Rename or delete</h2>
        <form action={renameReviewAction} className="om-stack">
          <input type="hidden" name="review_id" value={id} />
          <div><label className="om-label" htmlFor="rv-title">Title</label>
            <input id="rv-title" name="title" className="om-input" defaultValue={r.title} maxLength={200} required /></div>
          <div><button className="om-btn om-btn--light om-btn--sm">Save name</button></div>
        </form>
        {canDelete ? (
          <form action={deleteReviewAction} className="om-row">
            <input type="hidden" name="review_id" value={id} />
            <label className="om-check"><input type="checkbox" name="confirm" /> Yes, delete this review and all its comments for good.</label>
            <button className="om-btn om-btn--danger om-btn--sm">Delete review</button>
          </form>
        ) : <p className="om-muted" style={{ margin: 0 }}>Only the person who started this review, or an admin, can delete it. You can mark it completed instead.</p>}
      </section>
    </Shell>
  );
}
