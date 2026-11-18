import { redirect } from "next/navigation";
import { getMember } from "@/lib/session.ts";
import { renameMeAction } from "@/review/actions.ts";
import { Notices, Shell } from "@/components/Shell.tsx";
import { ConnectClaude } from "@/components/ConnectClaude.tsx";
import { createAdminClient } from "@/lib/supabase/admin.ts";
import { adminConfigured } from "@/lib/env.ts";

export const metadata = { title: "Account · OpenMarkup" };

export default async function Account({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  const sp = await searchParams;
  const member = await getMember();
  if (!member) redirect("/login");
  const { data: key } = adminConfigured()
    ? await createAdminClient().from("mcp_keys").select("last_used_at").eq("user_id", member.id).maybeSingle()
    : { data: null };
  return (
    <Shell member={member}>
      <h1 className="om-h1">Your account</h1>
      <Notices done={sp.done} error={sp.error} />
      <section className="om-card">
        <form action={renameMeAction} className="om-stack">
          <p className="om-muted" style={{ margin: 0 }}>{member.email}{member.isAdmin ? " · Admin" : ""}</p>
          <div><label className="om-label" htmlFor="dn">Name shown on your comments</label>
            <input id="dn" name="display_name" className="om-input" defaultValue={member.name} maxLength={80} required /></div>
          <div><button className="om-btn om-btn--light">Save</button></div>
        </form>
      </section>
      <ConnectClaude connected={Boolean(key)} lastUsed={key?.last_used_at ?? null} />
    </Shell>
  );
}
