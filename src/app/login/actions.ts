"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server.ts";
import { signupAllowed } from "@/lib/env.ts";

const back = (m: string) => redirect(`/login?error=${encodeURIComponent(m)}`);

export async function signInAction(form: FormData) {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) back("Enter your email and password.");
  const db = await createClient();
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) back("That email and password don’t match.");
  redirect("/");
}

export async function signUpAction(form: FormData) {
  if (!signupAllowed()) back("Sign-ups are switched off. Ask an admin for a login.");
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || password.length < 8) back("Enter your email and a password of at least 8 characters.");
  const db = await createClient();
  const { data, error } = await db.auth.signUp({ email, password });
  if (error) back(error.message);
  if (!data.session) redirect(`/login?done=${encodeURIComponent("Check your email to confirm, then sign in.")}`);
  redirect("/");
}
