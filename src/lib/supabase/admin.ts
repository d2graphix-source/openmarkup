import "server-only";
import { createClient } from "@supabase/supabase-js";

// The service-role client. Bypasses row-level security, so it is only used after the server has checked a share link,
// and only for that one review.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
