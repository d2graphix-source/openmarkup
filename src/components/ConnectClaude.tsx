"use client";

import { useState, useTransition } from "react";
import { makeConnectionAction, removeConnectionAction } from "@/mcp/actions.ts";
import { CopyLink } from "./CopyLink.tsx";

// Account card: make the private address that lets Claude read reviews and reply as you.
export function ConnectClaude({ connected, lastUsed }: { connected: boolean; lastUsed: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [on, setOn] = useState(connected);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const make = () => start(async () => {
    setError(null);
    const r = await makeConnectionAction();
    if (r.ok) { setUrl(r.url); setOn(true); } else setError(r.error);
  });
  const remove = () => start(async () => { if ((await removeConnectionAction()).ok) { setOn(false); setUrl(null); } });
  return (
    <section className="om-card om-stack">
      <h2 className="om-h2">Connect Claude</h2>
      <p className="om-muted" style={{ margin: 0 }}>
        Lets Claude list your reviews, read every comment with its page, element and screenshot, reply, and mark comments
        resolved. It acts as you. In Claude, open Settings › Connectors › Add custom connector and paste the address.
      </p>
      {url ? (
        <div className="om-stack">
          <CopyLink value={url} />
          <p className="om-notice" style={{ margin: 0 }}>Copy it now: it is shown only once. Anyone with this address can act as you, so keep it private.</p>
        </div>
      ) : on ? (
        <p style={{ margin: 0 }}>Connected{lastUsed ? ` · last used ${new Date(lastUsed).toLocaleString()}` : " · not used yet"}.</p>
      ) : null}
      {error && <p className="om-notice om-notice--error">{error}</p>}
      <div className="om-row">
        <button type="button" className={on ? "om-btn om-btn--light" : "om-btn"} disabled={busy} onClick={make}>{on ? "Make a new address" : "Make a connection address"}</button>
        {on && <button type="button" className="om-btn om-btn--danger" disabled={busy} onClick={remove}>Disconnect</button>}
      </div>
      {on && !url && <p className="om-muted" style={{ margin: 0, fontSize: 13 }}>A new address stops the old one working.</p>}
    </section>
  );
}
