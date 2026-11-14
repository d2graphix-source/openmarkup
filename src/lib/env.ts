import "server-only";

// Settings read from the environment, in one place. See .env.example.
export const appOrigin = () => (process.env.APP_ORIGIN ?? "").trim().replace(/\/+$/, "") || "http://localhost:3000";
export const signupAllowed = () => process.env.ALLOW_SIGNUP === "true";
export const adminConfigured = () => Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);
