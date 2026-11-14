import { appOrigin } from "@/lib/env.ts";
import { setupGuide } from "@/review/setupGuide.ts";

// Public: holds no secrets, only the script tag and how to add it.
export async function GET() {
  return new Response(setupGuide(appOrigin()), { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'inline; filename="openmarkup-setup.md"' } });
}
