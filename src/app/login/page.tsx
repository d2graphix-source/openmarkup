import { signupAllowed } from "@/lib/env.ts";
import { signInAction, signUpAction } from "./actions.ts";

export const metadata = { title: "Sign in · OpenMarkup" };

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; done?: string; mode?: string }> }) {
  const sp = await searchParams;
  const signup = signupAllowed() && sp.mode === "signup";
  return (
    <main className="om-auth">
      <h1 className="om-brand"><span className="om-brand__mark" aria-hidden />OpenMarkup</h1>
      <form action={signup ? signUpAction : signInAction} className="om-card om-stack">
        <h2 className="om-h2">{signup ? "Create an account" : "Sign in"}</h2>
        {sp.error ? <p role="alert" className="om-notice om-notice--error">{sp.error}</p> : null}
        {sp.done ? <p role="status" className="om-notice">{sp.done}</p> : null}
        <div><label className="om-label" htmlFor="email">Email</label><input id="email" name="email" type="email" className="om-input" autoComplete="email" required /></div>
        <div><label className="om-label" htmlFor="password">Password</label><input id="password" name="password" type="password" className="om-input" autoComplete={signup ? "new-password" : "current-password"} required /></div>
        <button className="om-btn">{signup ? "Create account" : "Sign in"}</button>
        {signupAllowed() ? <a className="om-muted" href={signup ? "/login" : "/login?mode=signup"}>{signup ? "I already have an account" : "Create an account"}</a> : null}
      </form>
    </main>
  );
}
