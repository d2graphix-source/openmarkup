import Link from "next/link";
import type { Member } from "@/lib/session.ts";

// The top bar and page column for signed-in pages.
export function Shell({ member, children }: { member: Member; children: React.ReactNode }) {
  return (
    <>
      <header className="om-top">
        <Link href="/" className="om-brand"><span className="om-brand__mark" aria-hidden />OpenMarkup</Link>
        <nav className="om-top__nav">
          <Link href="/account" className="om-muted">{member.name}</Link>
          <form action="/auth/signout" method="post"><button className="om-text-btn">Sign out</button></form>
        </nav>
      </header>
      <main className="om-page">{children}</main>
    </>
  );
}

export function Notices({ done, error }: { done?: string; error?: string }) {
  return (
    <>
      {done ? <p role="status" className="om-notice">{done}</p> : null}
      {error ? <p role="alert" className="om-notice om-notice--error">{error}</p> : null}
    </>
  );
}
