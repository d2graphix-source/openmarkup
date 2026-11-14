import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// A Supabase client that acts as the signed-in person, so row-level security decides what they can read and change.
export async function createClient() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* called from a server component: middleware refreshes the cookie */ }
      },
    },
  });
}
