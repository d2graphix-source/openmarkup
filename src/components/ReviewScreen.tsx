"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Monitor, Smartphone, Tablet } from "lucide-react";
import type { ReviewComment, ReviewMode, ReviewThread, ReviewUser, ThreadDraft } from "@/review/shared/protocol.ts";
import { ReviewHost, type ThreadStore } from "@/review/host/reviewHost.ts";
import { VIEWPORT_NAMES } from "@/review/lib.ts";
import { addCommentAction, createThreadAction, deleteCommentAction, deleteThreadAction, editCommentAction, finishReviewAction, loadThreadsAction, reviewMarkdownAction, setResolvedAction } from "@/review/actions.ts";

// Saves and loads comments through the server. A guest's name rides along with each call; the server checks the share link.
export class ServerStore implements ThreadStore {
  constructor(private reviewId: string, private token: string | null, private guestName: string) {}
  async listThreads() {
    const r = await loadThreadsAction(this.reviewId, this.token);
    if (!r.ok) throw new Error(r.error);
    return r.threads;
  }
  async createThread(input: { draft: ThreadDraft; viewport: string; author: ReviewUser }): Promise<ReviewThread> {
    const r = await createThreadAction(this.reviewId, this.token, { draft: input.draft, viewport: input.viewport, name: this.guestName });
    if (!r.ok) throw new Error(r.error);
    return r.thread;
  }
  async addComment(input: { threadId: string; body: string; images?: string[]; author: ReviewUser }): Promise<ReviewComment> {
    const r = await addCommentAction(this.reviewId, this.token, { threadId: input.threadId, body: input.body, images: input.images, name: this.guestName });
    if (!r.ok) throw new Error(r.error);
    return r.comment;
  }
  async setResolved(threadId: string, resolved: boolean) {
    const r = await setResolvedAction(this.reviewId, this.token, threadId, resolved);
    if (!r.ok) throw new Error(r.error);
  }
  async deleteThread(threadId: string) {
    const r = await deleteThreadAction(this.reviewId, this.token, threadId);
    if (!r.ok) throw new Error(r.error);
  }
  async editComment(input: { threadId: string; commentId: string; body: string }) {
    const r = await editCommentAction(this.reviewId, this.token, { commentId: input.commentId, body: input.body });
    if (!r.ok) throw new Error(r.error);
    return { editedAt: r.editedAt };
  }
  async deleteComment(input: { threadId: string; commentId: string }) {
    const r = await deleteCommentAction(this.reviewId, this.token, input);
    if (!r.ok) throw new Error(r.error);
    return { thread: r.thread };
  }
  // Other people's comments appear without a reload: look again every 15 seconds while the tab is open.
  subscribe(onChange: () => void) {
    const timer = setInterval(() => { if (document.visibilityState === "visible") onChange(); }, 15000);
    return () => clearInterval(timer);
  }
}

const NAME_KEY = "openmarkup-name";

// The live review: the real site in a frame, a Browse / Comment switch, the viewport, and the list of comments.
export function ReviewScreen({ reviewId, siteOrigin, startPath, token = null, user, canComment, closedNote, canExport = false, canFinish = false, layout = "embedded", title, backHref, shareHref, fullHref }: {
  reviewId: string; siteOrigin: string; startPath: string; token?: string | null;
  user: ReviewUser | null; // null = a share-link guest who hasn't given a name yet
  canComment: boolean; closedNote?: string;
  canExport?: boolean; canFinish?: boolean; layout?: "embedded" | "full"; // "full" fills the whole window with a top bar and a collapsible comment list
  title?: string; backHref?: string; shareHref?: string; fullHref?: string;
}) {
  const full = layout === "full";
  const [sideOpen, setSideOpen] = useState(true);
  const guest = user === null || user.isGuest;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<ReviewHost | null>(null);
  const storeRef = useRef<ServerStore | null>(null);
  const quietRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [guestName, setGuestName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [mode, setMode] = useState<ReviewMode>("browse");
  const [viewport, setViewport] = useState<string>(VIEWPORT_NAMES[0]);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [page, setPage] = useState<string>("");
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "page">("newest");
  const [done, setDone] = useState<string | null>(null); // a short confirmation under the buttons (copied, finished)
  const [silent, setSilent] = useState(false); // the page never answered, so the review script isn't running on it

  useEffect(() => {
    if (!guest) return;
    try { const n = localStorage.getItem(NAME_KEY) ?? ""; setGuestName(n); setNameDraft(n); } catch { /* storage unavailable */ }
  }, [guest]);

  const me: ReviewUser | null = guest ? (guestName ? { id: `guest:${guestName}`, name: guestName, isGuest: true } : null) : user;
  const meId = me?.id ?? "";

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const store = new ServerStore(reviewId, token, guest ? guestName : "");
    storeRef.current = store;
    const host = new ReviewHost({
      iframe, frameOrigin: siteOrigin, startPath, store, user: me, canComment: canComment && me !== null, mode: "browse",
      onThreadsChange: setThreads, onCounts: setCounts, onReady: () => { clearTimeout(quietRef.current); setSilent(false); }, onUrlChange: (i) => setPage(i.pageUrl), onMissingAnchors: (ids) => setMissing(new Set(ids)),
      onError: (e) => setError(e instanceof Error ? e.message : "Something went wrong."),
    });
    hostRef.current = host;
    setMode("browse");
    setSilent(false);
    const quiet = setTimeout(() => setSilent(true), 12000); // cleared the moment the page answers
    quietRef.current = quiet;
    void host.start().catch((e) => setError(e instanceof Error ? e.message : "The review couldn’t start."));
    return () => { clearTimeout(quiet); host.destroy(); hostRef.current = null; };
    // A new host when the review, the address or the person changes; permission changes are pushed below without a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId, siteOrigin, startPath, token, meId]);

  useEffect(() => hostRef.current?.setCanComment(canComment && me !== null), [canComment, meId]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = threads.filter((t) => (tab === "open") !== t.resolved).filter((t) => !q
      || t.pageKey.toLowerCase().includes(q) || t.comments.some((c) => c.body.toLowerCase().includes(q) || c.authorName.toLowerCase().includes(q)));
    const when = (t: ReviewThread) => Date.parse(t.createdAt) || 0;
    return [...list].sort((a, b) => (sort === "oldest" ? when(a) - when(b) : sort === "page" ? a.pageKey.localeCompare(b.pageKey) || when(a) - when(b) : when(b) - when(a)));
  }, [threads, tab, search, sort]);
  const byPage = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of shown) m.set(t.pageKey, [...(m.get(t.pageKey) ?? []), t]);
    return [...m.entries()];
  }, [shown]);
  const openCount = threads.filter((t) => !t.resolved).length;

  const changeMode = (m: ReviewMode) => { setMode(m); hostRef.current?.setMode(m); };
  const changeViewport = (v: string) => { setViewport(v); hostRef.current?.setViewport(v); };
  async function toggle(t: ReviewThread) {
    try { await storeRef.current?.setResolved(t.id, !t.resolved); await hostRef.current?.reload(); } catch (e) { setError(e instanceof Error ? e.message : "We couldn’t change that."); }
  }
  async function copyMarkdown() {
    const r = await reviewMarkdownAction(reviewId);
    if (!r.ok) return setError(r.error);
    try { await navigator.clipboard.writeText(r.markdown); setDone("Copied. Paste it into your chat, issue or brief."); }
    catch { setDone(null); setError("Your browser wouldn’t let us copy. Try again, or allow clipboard access for this site."); }
  }
  async function finish() {
    const r = await finishReviewAction(reviewId, token, guestName);
    if (!r.ok) return setError(r.error);
    setDone("Thank you. We’ve let the team know you’re finished.");
  }
  function saveName() {
    const n = nameDraft.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!n) return;
    try { localStorage.setItem(NAME_KEY, n); } catch { /* storage unavailable */ }
    setGuestName(n);
  }

  const canWrite = canComment && me !== null;
  const needName = guest && !guestName && canComment;
  const sideVisible = sideOpen || needName; // a guest must see the name box, so the list stays open until they give one
  const seg = (on: boolean) => (on ? "om-btn om-btn--light om-btn--sm is-on" : "om-btn om-btn--light om-btn--sm");

  const nameForm = needName ? (
    <form className="lr__name" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
      <label htmlFor="lr-name" className="om-label">Your name</label>
      <input id="lr-name" className="om-input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={80} placeholder="So everyone knows who commented" />
      <button className="om-btn om-btn--sm" disabled={!nameDraft.trim()}>Continue</button>
    </form>
  ) : null;
  const modeSwitch = (
    <div role="group" aria-label="Mode" className="lr__seg">
      <button type="button" aria-pressed={mode === "browse"} className={`lr__mode${mode === "browse" ? " is-on" : ""}`} onClick={() => changeMode("browse")}>{mode === "browse" ? <Check size={16} strokeWidth={2.25} aria-hidden /> : null}Browse</button>
      <button type="button" aria-pressed={mode === "comment"} disabled={!canWrite} className={`lr__mode${mode === "comment" ? " is-on" : ""}`} onClick={() => changeMode("comment")}>{mode === "comment" ? <Check size={16} strokeWidth={2.25} aria-hidden /> : null}Comment</button>
    </div>
  );
  const DEVICE_ICON = { Desktop: Monitor, Tablet: Tablet, Phone: Smartphone } as const;
  const sizeSwitch = (
    <div role="group" aria-label="Screen size" className="lr__devices">
      {VIEWPORT_NAMES.map((v) => {
        const Icon = DEVICE_ICON[v];
        const n = counts[v] ?? 0;
        return (
          <button key={v} type="button" aria-pressed={viewport === v} className={`lr__dev${viewport === v ? " is-on" : ""}`}
            aria-label={`${v}${n ? `, ${n} open ${n === 1 ? "comment" : "comments"}` : ""}`} title={`${v}${n ? ` · ${n} open` : ""}`} onClick={() => changeViewport(v)}>
            <Icon size={20} strokeWidth={1.75} aria-hidden />
            {n ? <span className="lr__devcount">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
  const hints = (
    <>
      {silent ? (
        <p role="status" className="lr__note lr__warn">
          The site isn’t answering the review script yet. Check that the OpenMarkup script is in the site’s head and that the site allows being shown in a frame, clear the site’s cache, then reload this page.
        </p>
      ) : null}
      {!canComment ? <p className="om-muted lr__note">{closedNote ?? "Comments are closed on this review. You can still look around."}</p> : null}
      {mode === "browse" && canWrite ? <p className="om-muted lr__note">Look around the site first. When you spot something to change, switch to Comment and click it.</p> : null}
      {mode === "comment" && canWrite ? <p className="om-muted lr__note">Click anything on the page to leave a comment there. Switch to Browse to use links and menus.</p> : null}
    </>
  );
  const errorLine = error ? (
    <p role="alert" className="lr__note lr__error">{error} <button type="button" className="om-text-btn" onClick={() => setError(null)}>Dismiss</button></p>
  ) : null;
  const notes = <>{hints}{errorLine}</>;
  const stage = (
    <div className={`lr__stage${viewport === "Phone" ? " lr__stage--phone" : ""}`}><iframe ref={iframeRef} title="The page under review" className="lr__frame" /></div>
  );
  const sidebar = (
    <aside className="lr__side" aria-label="Comments">
      {full ? <>{nameForm}{hints}</> : null}
      <div role="tablist" aria-label="Comments" className="lr__seg">
        <button type="button" role="tab" aria-selected={tab === "open"} className={seg(tab === "open")} onClick={() => setTab("open")}>Open {openCount}</button>
        <button type="button" role="tab" aria-selected={tab === "resolved"} className={seg(tab === "resolved")} onClick={() => setTab("resolved")}>Resolved {threads.length - openCount}</button>
      </div>
      <div className="lr__tools">
        <input type="search" className="om-input" placeholder="Search comments" aria-label="Search comments" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div role="group" aria-label="Sort comments" className="lr__sort">
          {([["newest", "Newest"], ["oldest", "Oldest"], ["page", "By page"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={sort === k} className={seg(sort === k)} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
      </div>
      {byPage.length === 0 ? <p className="om-muted" style={{ margin: 0 }}>{search ? "No comments match your search." : tab === "open" ? "No open comments on this screen size." : "Nothing resolved yet."}</p> : null}
      {byPage.map(([key, list]) => (
        <section key={key} className="lr__group">
          <h3 className="lr__pagekey">{key}</h3>
          {list.map((t) => (
            <div key={t.id} className="lr__thread">
              <button type="button" className="lr__open" onClick={() => { setMode("comment"); hostRef.current?.focusThread(t.id); }}>
                <b>{t.comments[0]?.authorName ?? "Someone"}</b>{missing.has(t.id) ? " · element no longer on the page" : ""}
                <span className="lr__text">{t.comments[0]?.body}</span>
                {(() => { const n = t.comments.reduce((s, c) => s + (c.images?.length ?? 0), 0); return n ? <span className="om-muted" style={{ display: "block", fontSize: 12 }}>{n === 1 ? "1 picture attached" : `${n} pictures attached`}</span> : null; })()}
                {t.comments.length > 1 ? <span className="om-muted">{t.comments.length - 1} {t.comments.length === 2 ? "reply" : "replies"}</span> : null}
              </button>
              {canWrite ? <button type="button" className="om-text-btn" onClick={() => toggle(t)}>{t.resolved ? "Reopen" : "Resolve"}</button> : null}
            </div>
          ))}
        </section>
      ))}
      {canExport || canFinish ? (
        <div className="lr__foot">
          {canExport ? <button type="button" className="om-btn om-btn--light om-btn--sm" onClick={copyMarkdown}>Copy as markdown</button> : null}
          {canExport ? <a className="om-btn om-btn--light om-btn--sm" href={`/api/reviews/${reviewId}/markdown`} download>Download .md</a> : null}
          {canFinish && !done?.startsWith("Thank") ? <button type="button" className="om-btn om-btn--sm" disabled={guest && !guestName} onClick={finish}>I’ve finished reviewing</button> : null}
          {done ? <p role="status" className="om-muted" style={{ margin: 0, fontSize: 13 }}>{done}</p> : null}
        </div>
      ) : null}
    </aside>
  );

  if (full) {
    return (
      <div className="lr lr--full">
        <header className="lr__top">
          <div className="lr__topleft">
            {backHref ? <a href={backHref} className="om-btn om-btn--light om-btn--sm">← Back</a> : null}
            <span className="lr__title" title={title}>{title}</span>
          </div>
          <div className="lr__topmid">{modeSwitch}{sizeSwitch}</div>
          <div className="lr__topright">
            {shareHref ? <a href={shareHref} className="om-btn om-btn--sm">Share</a> : null}
            <button type="button" className="om-btn om-btn--light om-btn--sm" aria-pressed={sideVisible} onClick={() => setSideOpen((o) => !o)}>{sideVisible ? "Hide comments" : `Comments ${openCount}`}</button>
          </div>
        </header>
        <div className={`lr__body${sideVisible ? "" : " lr__body--wide"}`}>
          {sideVisible ? sidebar : null}
          {stage}
        </div>
        {errorLine}
      </div>
    );
  }

  return (
    <div className="lr">
      {nameForm}
      <div className="lr__bar">
        {modeSwitch}
        {sizeSwitch}
        <span className="lr__page" title={page}>{page}</span>
        {fullHref ? <a href={fullHref} className="om-btn om-btn--light om-btn--sm">Full screen</a> : null}
      </div>
      {notes}
      <div className="lr__main">
        {stage}
        {sidebar}
      </div>
    </div>
  );
}
