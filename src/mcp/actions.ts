"use server";

import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin.ts";
import { adminConfigured, appOrigin } from "@/lib/env.ts";
import { getMember } from "@/lib/session.ts";
import { hashKey } from "./server.ts";

// Make (or replace) the signed-in member's Claude connection. The address is returned once and never stored.
export async function makeConnectionAction(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const member = await getMember();
  if (!member || !adminConfigured()) return { ok: false, error: "Sign in first." };
  const key = "om_" + randomBytes(32).toString("base64url");
  const { error } = await createAdminClient().from("mcp_keys").upsert({ user_id: member.id, key_hash: hashKey(key), created_at: new Date().toISOString(), last_used_at: null });
  if (error) return { ok: false, error: "We couldn’t make a connection. Try again." };
  return { ok: true, url: `${appOrigin()}/api/mcp/${key}` };
}

export async function removeConnectionAction(): Promise<{ ok: boolean }> {
  const member = await getMember();
  if (!member || !adminConfigured()) return { ok: false };
  const { error } = await createAdminClient().from("mcp_keys").delete().eq("user_id", member.id);
  return { ok: !error };
}
