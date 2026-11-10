import { redirect } from "next/navigation";
import { ApiError, publicApi } from "@/lib/api";

async function requestReset(formData: FormData) {
  "use server";
  try {
    await publicApi("/auth/forgot", { method: "POST", body: JSON.stringify({ email: formData.get("email") }) });
  } catch (e) {
    redirect(`/mot-de-passe-oublie?erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Demande impossible")}`);
  }
  redirect("/mot-de-passe-oublie?envoye=1");
}

export default async function Forgot({ searchParams }: { searchParams: Promise<{ envoye?: string; erreur?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <h1>Mot de passe oublié</h1>
      {sp.envoye ? (
        <div className="notice">Si un compte existe pour cette adresse, un e-mail avec un lien de réinitialisation vient de partir. Le lien est valable 1 heure.</div>
      ) : (
        <>
          <p className="muted">Indiquez votre adresse : nous vous envoyons un lien pour choisir un nouveau mot de passe.</p>
          {sp.erreur && <div className="notice error">{sp.erreur}</div>}
          <form action={requestReset} className="stack">
            <label>E-mail<input name="email" type="email" autoComplete="email" required autoFocus /></label>
            <button className="btn">Envoyer le lien</button>
          </form>
        </>
      )}
      <p className="muted"><a href="/connexion">Retour à la connexion</a></p>
    </>
  );
}
