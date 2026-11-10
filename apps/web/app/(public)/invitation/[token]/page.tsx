import { redirect } from "next/navigation";
import { ApiError, publicApi, setSession } from "@/lib/api";

const ROLE_LABELS = { owner: "propriétaire", admin: "administrateur", member: "membre" } as const;

interface InviteInfo {
  email: string;
  role: keyof typeof ROLE_LABELS;
  orgName: string;
  accountExists: boolean;
}

async function accept(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  try {
    const r = await publicApi<{ token: string; expiresAt: string }>("/auth/accept-invite", {
      method: "POST",
      body: JSON.stringify({ token, name: formData.get("name"), password: formData.get("password") }),
    });
    await setSession(r.token, r.expiresAt);
  } catch (e) {
    redirect(`/invitation/${encodeURIComponent(token)}?erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Erreur, réessayez")}`);
  }
  redirect("/");
}

export default async function AcceptInvitation({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ erreur?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  let info: InviteInfo;
  try {
    info = await publicApi<InviteInfo>(`/auth/invitation/${encodeURIComponent(token)}`);
  } catch (e) {
    return (
      <>
        <h1>Invitation</h1>
        <div className="notice error">{e instanceof ApiError ? e.message : "Invitation illisible"}</div>
        <p className="muted"><a href="/connexion">Aller à la connexion</a></p>
      </>
    );
  }
  return (
    <>
      <h1>Rejoindre {info.orgName}</h1>
      <p className="muted">Invitation pour <b>{info.email}</b>, avec le rôle {ROLE_LABELS[info.role]}.</p>
      {sp.erreur && <div className="notice error">{sp.erreur}</div>}
      {info.accountExists ? (
        <div className="notice error">Cette adresse a déjà un compte dans une autre organisation. Demandez une invitation pour une autre adresse.</div>
      ) : (
        <form action={accept} className="stack">
          <input type="hidden" name="token" value={token} />
          <label>Votre nom<input name="name" autoComplete="name" required autoFocus /></label>
          <label>Choisissez un mot de passe<input name="password" type="password" autoComplete="new-password" required minLength={10} />
            <span className="muted">10 caractères minimum.</span>
          </label>
          <button className="btn accent">Rejoindre l&apos;équipe</button>
        </form>
      )}
    </>
  );
}
