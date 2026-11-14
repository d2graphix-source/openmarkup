"use client";

import { useState } from "react";

// The share link in a read-only box, with a button that copies it.
export function CopyLink({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input className="om-input" readOnly value={value} aria-label="Share link" style={{ flex: 1, minWidth: 240 }} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="om-btn om-btn--light om-btn--sm"
        onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the box is selectable as a fallback */ } }}>
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
