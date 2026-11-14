"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, X } from "lucide-react";
import type { ReviewMode, ReviewThread, ReviewUser } from "@/review/shared/protocol.ts";
import { ReviewHost } from "@/review/host/reviewHost.ts";
import { ServerStore } from "./ReviewScreen.tsx";

const NAME_KEY = "openmarkup-name";
const DOCK = "openmarkup-dock";
const iconBtn: React.CSSProperties = { width: 44, height: 44, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-sm)", border: "1px solid var(--input)", background: "var(--card)", color: "var(--foreground)", cursor: "pointer", flex: "none" };

// The on-site review dock. It sits inside the site's own page (added by review-assets/openmarkup.js), so the reviewer stays
// logged in to that site. It drives the comment layer in the page around it and saves through the share link.
export function OnsiteDock({ reviewId, siteOrigin, token, title, canComment, viewport }: {
  reviewId: string; siteOrigin: string; token: string; title: string; canComment: boolean; viewport: string;
}) {
  const hostRef = useRef<ReviewHost | null>(null);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ReviewMode>("browse");
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [page, setPage] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { try { const n = localStorage.getItem(NAME_KEY) ?? ""; setName(n); setDraft(n); } catch { /* storage blocked */ } }, []);

  const me: ReviewUser | null = name ? { id: `guest:${name}`, name, isGuest: true } : null;
  const inFrame = typeof window !== "undefined" && window.parent !== window;

  useEffect(() => {
    if (!inFrame) return;
    const host = new ReviewHost({
      siteWindow: window.parent, frameOrigin: siteOrigin, store: new ServerStore(reviewId, token, name), user: me,
      canComment: canComment && me !== null, mode: "browse", viewport,
      onThreadsChange: setThreads, onReady: () => setReady(true), onUrlChange: (i) => setPage(i.pageUrl),
      onError: (e) => setError(e instanceof Error ? e.message : "Something went wrong."),
    });
    hostRef.current = host;
    setMode("browse");
    void host.start().catch((e) => setError(e instanceof Error ? e.message : "The review couldn’t start."));
    const poll = setInterval(() => void host.reload(), 15000); // others' comments show up without a reload
    return () => { clearInterval(poll); host.destroy(); hostRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId, siteOrigin, token, name]);

  const tell = (msg: Record<string, unknown>) => window.parent.postMessage({ channel: DOCK, ...msg }, siteOrigin);
  const shrink = (c: boolean) => { setCollapsed(c); tell({ type: "dock:size", collapsed: c }); };
  const change = (m: ReviewMode) => { setMode(m); hostRef.current?.setMode(m); };
  const open = threads.filter((t) => !t.resolved);
  const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };
  const btn = (on: boolean) => (on ? "om-btn om-btn--sm" : "om-btn om-btn--light om-btn--sm");

  if (!inFrame) {
    return <main style={{ padding: 24 }}><p className="om-muted">This panel opens on the site itself. Use the review link you were sent.</p></main>;
  }
  if (collapsed) {
    return (
      <button type="button" onClick={() => shrink(false)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", boxSizing: "border-box", height: 56, padding: "0 18px", font: "600 15px var(--font-sans)", color: "var(--foreground)" }}>
        <span>Review · {open.length} open</span><Maximize2 size={20} strokeWidth={1.75} aria-hidden />
      </button>
    );
  }
  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh", font: "15px var(--font-sans)", color: "var(--foreground)", background: "var(--background)" }}>
      <header style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
        <button type="button" style={iconBtn} onClick={() => shrink(true)} aria-label="Minimise" title="Minimise"><Minus size={22} strokeWidth={1.75} aria-hidden /></button>
        <button type="button" style={iconBtn} onClick={() => tell({ type: "dock:close" })} aria-label="Stop reviewing" title="Stop reviewing"><X size={22} strokeWidth={1.75} aria-hidden /></button>
      </header>
      <div style={{ padding: 14, display: "grid", gap: 10, borderBottom: "1px solid var(--border)" }}>
        {!name && canComment ? (
          <form onSubmit={(e) => { e.preventDefault(); const n = draft.replace(/\s+/g, " ").trim().slice(0, 80); if (!n) return; try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } setName(n); }} style={{ display: "grid", gap: 6 }}>
            <label htmlFor="dock-name" className="om-label">Your name</label>
            <input id="dock-name" className="om-input" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={80} placeholder="So everyone knows who commented" />
            <button className="om-btn om-btn--sm" disabled={!draft.trim()}>Continue</button>
          </form>
        ) : null}
        <div role="group" aria-label="Mode" style={{ display: "flex", gap: 6 }}>
          <button type="button" className={btn(mode === "browse")} aria-pressed={mode === "browse"} onClick={() => change("browse")}>Browse</button>
          <button type="button" className={btn(mode === "comment")} aria-pressed={mode === "comment"} disabled={!canComment || !me} onClick={() => change("comment")}>Comment</button>
        </div>
        <p className="om-muted" style={{ margin: 0, fontSize: 13 }}>
          {!ready ? "Connecting to the page…" : !canComment ? "Comments are closed on this review." : mode === "comment" ? "Click anything on the page to leave a comment there." : "Use the app as normal. Switch to Comment when you spot something."}
        </p>
        {error ? <p role="alert" style={{ margin: 0, color: "var(--destructive)", fontSize: 13 }}>{error}</p> : null}
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, overflow: "auto", flex: 1 }}>
        {open.length === 0 ? <li className="om-muted" style={{ padding: 14 }}>No open comments on {viewport.toLowerCase()} yet.</li> : null}
        {open.map((t, i) => (
          <li key={t.id}>
            <button type="button" onClick={() => hostRef.current?.focusThread(t.id)} style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box", padding: "10px 14px", borderBottom: "1px solid var(--border)", background: t.pageUrl === page ? "var(--muted)" : undefined }}>
              <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>#{i + 1} · {pathOf(t.pageUrl)} · {t.comments[0]?.authorName}</span>
              <span style={{ display: "block", marginTop: 2 }}>{t.comments[0]?.body}</span>
              {t.comments[0]?.images?.length ? <span style={{ display: "flex", gap: 6, marginTop: 6 }}>{t.comments[0].images.map((src) => <img key={src} src={src} alt="Attached picture" loading="lazy" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }} />)}</span> : null}
              {t.snapshotUrl ? <img src={t.snapshotUrl} alt="" loading="lazy" style={{ display: "block", width: "100%", marginTop: 6, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }} /> : null}
              {t.comments.length > 1 ? <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{t.comments.length - 1} {t.comments.length === 2 ? "reply" : "replies"}</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </main>
  );
}
