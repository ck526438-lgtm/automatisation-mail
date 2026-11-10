import { redirect } from "next/navigation";
import { ApiError, publicApi, setSession } from "@/lib/api";

/** N'accepte que les chemins internes, pour éviter une redirection ouverte. */
function safeNext(v: FormDataEntryValue | null | undefined): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

async function login(formData: FormData) {
  "use server";
  const next = safeNext(formData.get("suite"));
  try {
    const r = await publicApi<{ token: string; expiresAt: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: formData.get("email"), password: formData.get("password") }),
    });
    await setSession(r.token, r.expiresAt);
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : "Connexion impossible, réessayez";
    redirect(`/connexion?erreur=${encodeURIComponent(msg)}&suite=${encodeURIComponent(next)}`);
  }
  redirect(next);
}

export default async function Login({ searchParams }: { searchParams: Promise<{ erreur?: string; suite?: string; expire?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <h1>Connexion</h1>
      {sp.expire && <div className="notice">Votre session a expiré. Reconnectez-vous.</div>}
      {sp.erreur && <div className="notice error">{sp.erreur}</div>}
      <form action={login} className="stack">
        <input type="hidden" name="suite" value={safeNext(sp.suite)} />
        <label>E-mail<input name="email" type="email" autoComplete="email" required autoFocus /></label>
        <label>Mot de passe<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="btn">Se connecter</button>
      </form>
      <p className="muted">Pas encore de compte ? <a href="/inscription">Créer une organisation</a></p>
    </>
  );
}
