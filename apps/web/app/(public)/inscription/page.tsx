import { redirect } from "next/navigation";
import { ApiError, publicApi, setSession } from "@/lib/api";

async function signup(formData: FormData) {
  "use server";
  try {
    const r = await publicApi<{ token: string; expiresAt: string }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        orgName: formData.get("orgName"),
        name: formData.get("name"),
        email: formData.get("email"),
        password: formData.get("password"),
      }),
    });
    await setSession(r.token, r.expiresAt);
  } catch (e) {
    redirect(`/inscription?erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Inscription impossible")}`);
  }
  redirect("/equipe?bienvenue=1");
}

export default async function Signup({ searchParams }: { searchParams: Promise<{ erreur?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <h1>Créer votre organisation</h1>
      <p className="muted">Vous serez propriétaire du compte et pourrez inviter votre équipe.</p>
      {sp.erreur && <div className="notice error">{sp.erreur}</div>}
      <form action={signup} className="stack">
        <label>Nom de l&apos;entreprise<input name="orgName" required minLength={2} autoFocus /></label>
        <label>Votre nom<input name="name" autoComplete="name" required /></label>
        <label>E-mail professionnel<input name="email" type="email" autoComplete="email" required /></label>
        <label>Mot de passe<input name="password" type="password" autoComplete="new-password" required minLength={10} />
          <span className="muted">10 caractères minimum.</span>
        </label>
        <button className="btn accent">Créer le compte</button>
      </form>
      <p className="muted">Déjà inscrit ? <a href="/connexion">Se connecter</a></p>
    </>
  );
}
