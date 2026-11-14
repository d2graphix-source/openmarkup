import "server-only";
import { createClient } from "./supabase/server.ts";

export type Member = { id: string; email: string; name: string; isAdmin: boolean };

// The signed-in member, or null. A login without a profile (schema not run yet) is treated as signed out.
export async function getMember(): Promise<Member | null> {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { data: p } = await db.from("profiles").select("display_name, is_admin").eq("user_id", user.id).maybeSingle();
  if (!p) return null;
  return { id: user.id, email: user.email ?? "", name: p.display_name, isAdmin: Boolean(p.is_admin) };
}
