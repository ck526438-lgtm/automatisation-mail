import { redirect } from "next/navigation";
import { ApiError, publicApi } from "@/lib/api";

async function reset(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  if (formData.get("password") !== formData.get("confirm")) {
    redirect(`/reinitialisation/${encodeURIComponent(token)}?erreur=${encodeURIComponent("Les deux mots de passe ne correspondent pas")}`);
  }
  try {
    await publicApi("/auth/reset", { method: "POST", body: JSON.stringify({ token, password: formData.get("password") }) });
  } catch (e) {
    redirect(`/reinitialisation/${encodeURIComponent(token)}?erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Erreur, réessayez")}`);
  }
  redirect("/connexion?reinitialise=1");
}

export default async function Reset({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ erreur?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  return (
    <>
      <h1>Nouveau mot de passe</h1>
      {sp.erreur && <div className="notice error">{sp.erreur}</div>}
      <form action={reset} className="stack">
        <input type="hidden" name="token" value={token} />
        <label>Nouveau mot de passe<input name="password" type="password" autoComplete="new-password" required minLength={10} autoFocus />
          <span className="muted">10 caractères minimum.</span>
        </label>
        <label>Confirmez<input name="confirm" type="password" autoComplete="new-password" required minLength={10} /></label>
        <button className="btn">Enregistrer</button>
      </form>
      <p className="muted"><a href="/mot-de-passe-oublie">Demander un nouveau lien</a></p>
    </>
  );
}
