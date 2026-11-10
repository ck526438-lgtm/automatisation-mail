import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api, ApiError, type AuditEntry, type Invitation, type Me, type Member, type Role } from "@/lib/api";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<Role, string> = { owner: "Propriétaire", admin: "Administrateur", member: "Membre" };
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
const ACTIONS: Record<string, string> = {
  signup: "a créé l'organisation", login: "s'est connecté", "invitation.create": "a invité", "invitation.accept": "a rejoint l'équipe",
  "user.role": "a changé le rôle de", "user.remove": "a retiré", "api_key.rotate": "a régénéré la clé API",
  "password.change": "a changé son mot de passe", "org.update": "a modifié les réglages", "contact.erase": "a effacé le contact",
};

/** Exécute une action et revient sur la page avec un message, en succès comme en erreur. */
async function run(fn: () => Promise<string>): Promise<never> {
  let params: string;
  try {
    params = `ok=${encodeURIComponent(await fn())}`;
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e;
    params = `erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Action impossible")}`;
  }
  revalidatePath("/equipe");
  redirect(`/equipe?${params}`);
}

async function invite(formData: FormData) {
  "use server";
  let link = "";
  try {
    const r = await api<{ link: string; email: string }>("/v1/invitations", { method: "POST", body: JSON.stringify({ email: formData.get("email"), role: formData.get("role") }) });
    link = r.link;
  } catch (e) {
    redirect(`/equipe?erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Invitation impossible")}`);
  }
  revalidatePath("/equipe");
  await flash("am_flash_link", link);
  redirect("/equipe?invitation=1");
}

/**
 * Secrets à montrer une seule fois (clé API, lien d'invitation) : passés par un cookie httpOnly
 * de 2 minutes plutôt que par l'adresse de la page, qui resterait dans l'historique et les journaux.
 */
async function flash(name: string, value: string) {
  (await cookies()).set(name, value, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/equipe", maxAge: 120 });
}

async function changeRole(formData: FormData) {
  "use server";
  await run(async () => {
    await api(`/v1/users/${formData.get("id")}`, { method: "PATCH", body: JSON.stringify({ role: formData.get("role") }) });
    return "Rôle mis à jour";
  });
}

async function removeUser(formData: FormData) {
  "use server";
  await run(async () => {
    await api(`/v1/users/${formData.get("id")}`, { method: "DELETE" });
    return "Personne retirée de l'équipe";
  });
}

async function cancelInvite(formData: FormData) {
  "use server";
  await run(async () => {
    await api(`/v1/invitations/${formData.get("id")}`, { method: "DELETE" });
    return "Invitation annulée";
  });
}

async function saveOrg(formData: FormData) {
  "use server";
  await run(async () => {
    await api("/v1/org", { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), postalAddress: formData.get("postalAddress"), timezone: formData.get("timezone") }) });
    return "Réglages enregistrés";
  });
}

async function changePassword(formData: FormData) {
  "use server";
  await run(async () => {
    await api("/v1/me", { method: "PATCH", body: JSON.stringify({ currentPassword: formData.get("current"), newPassword: formData.get("next") }) });
    return "Mot de passe changé. Vos autres sessions ont été fermées.";
  });
}

async function rotateKey() {
  "use server";
  let key = "";
  try {
    key = (await api<{ apiKey: string }>("/v1/api-key/rotate", { method: "POST", body: "{}" })).apiKey;
  } catch (e) {
    redirect(`/equipe?erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Impossible")}`);
  }
  await flash("am_flash_key", key);
  redirect("/equipe?cle=1");
}

export default async function Team({ searchParams }: { searchParams: Promise<{ ok?: string; erreur?: string; invitation?: string; cle?: string; bienvenue?: string }> }) {
  const sp = await searchParams;
  const jar = await cookies();
  const newLink = sp.invitation ? jar.get("am_flash_link")?.value : undefined;
  const newKey = sp.cle ? jar.get("am_flash_key")?.value : undefined;
  const me = await api<Me>("/v1/me");
  const isAdmin = RANK[me.role] >= RANK.admin;
  const [members, invites, auditLog] = await Promise.all([
    api<Member[]>("/v1/users"),
    isAdmin ? api<Invitation[]>("/v1/invitations") : Promise.resolve([]),
    isAdmin ? api<AuditEntry[]>("/v1/audit") : Promise.resolve([]),
  ]);
  const assignable = (Object.keys(ROLE_LABELS) as Role[]).filter((r) => RANK[r] <= RANK[me.role]);

  return (
    <>
      <h1>Équipe &amp; réglages</h1>
      <p className="lead">{me.org.name}</p>
      {sp.bienvenue && <div className="notice">Bienvenue ! Complétez l&apos;adresse postale ci-dessous (obligatoire dans chaque e-mail), puis connectez une boîte d&apos;envoi.</div>}
      {sp.ok && <div className="notice">{sp.ok}</div>}
      {sp.erreur && <div className="notice error">{sp.erreur}</div>}
      {newLink && (
        <div className="notice">
          <b>Invitation créée.</b> Envoyez ce lien à la personne (valable 7 jours, usage unique) :
          <div><code>{newLink}</code></div>
        </div>
      )}
      {newKey && (
        <div className="notice">
          <b>Nouvelle clé API</b>, affichée une seule fois. Copiez-la maintenant ; l&apos;ancienne ne fonctionne plus.
          <div><code>{newKey}</code></div>
        </div>
      )}

      <h2>Membres</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Dernière connexion</th><th></th></tr></thead>
          <tbody>
            {members.map((m) => {
              const self = m.id === me.user?.id;
              const manageable = isAdmin && !self && RANK[m.role] <= RANK[me.role];
              return (
                <tr key={m.id}>
                  <td>{m.name}{self && <span className="muted"> (vous)</span>}</td>
                  <td>{m.email}</td>
                  <td>
                    {manageable ? (
                      <form action={changeRole} className="row">
                        <input type="hidden" name="id" value={m.id} />
                        <select name="role" defaultValue={m.role}>
                          {assignable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </select>
                        <button className="btn secondary">OK</button>
                      </form>
                    ) : ROLE_LABELS[m.role]}
                  </td>
                  <td className="muted">{m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "Jamais"}</td>
                  <td>
                    {manageable && (
                      <form action={removeUser}>
                        <input type="hidden" name="id" value={m.id} />
                        <button className="btn secondary">Retirer</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <>
          <h2>Inviter quelqu&apos;un</h2>
          <div className="panel"><div className="panel-body">
            <form action={invite} className="row">
              <input name="email" type="email" placeholder="collegue@entreprise.ci" required style={{ flex: 1, minWidth: 220 }} />
              <select name="role" defaultValue="member">
                {assignable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              <button className="btn accent">Créer l&apos;invitation</button>
            </form>
            <p className="muted">Membre : contacts, campagnes et séquences. Administrateur : en plus, boîtes d&apos;envoi, domaines, équipe et effacement de contacts. Propriétaire : en plus, la clé API.</p>
            {invites.length > 0 && (
              <table>
                <thead><tr><th>En attente</th><th>Rôle</th><th>Expire le</th><th></th></tr></thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td>
                      <td>{ROLE_LABELS[i.role]}</td>
                      <td className="muted">{new Date(i.expiresAt).toLocaleDateString("fr-FR")}</td>
                      <td><form action={cancelInvite}><input type="hidden" name="id" value={i.id} /><button className="btn secondary">Annuler</button></form></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div></div>

          <h2>Organisation</h2>
          <div className="panel"><div className="panel-body">
            <form action={saveOrg} className="stack">
              <label>Nom<input name="name" defaultValue={me.org.name} required /></label>
              <label>Adresse postale (affichée en pied de chaque e-mail)<input name="postalAddress" defaultValue={me.org.postalAddress} placeholder="Rue, quartier, ville, pays" /></label>
              <label>Fuseau horaire par défaut<input name="timezone" defaultValue={me.org.timezone} placeholder="Africa/Abidjan" /></label>
              <div><button className="btn">Enregistrer</button></div>
            </form>
          </div></div>
        </>
      )}

      {me.role === "owner" && (
        <>
          <h2>Clé API</h2>
          <div className="panel"><div className="panel-body">
            <p className="muted">Pour connecter un CRM ou un script : en-tête <code>x-api-key</code>. Elle donne les droits d&apos;administrateur sur toute l&apos;organisation.</p>
            <form action={rotateKey}><button className="btn secondary">Générer une nouvelle clé</button></form>
          </div></div>
        </>
      )}

      <h2>Mon mot de passe</h2>
      <div className="panel"><div className="panel-body">
        <form action={changePassword} className="row">
          <input name="current" type="password" placeholder="Mot de passe actuel" autoComplete="current-password" required />
          <input name="next" type="password" placeholder="Nouveau (10 caractères min.)" autoComplete="new-password" required minLength={10} />
          <button className="btn secondary">Changer</button>
        </form>
      </div></div>

      {isAdmin && auditLog.length > 0 && (
        <>
          <h2>Journal d&apos;activité</h2>
          <div className="panel">
            <table>
              <tbody>
                {auditLog.slice(0, 25).map((a) => (
                  <tr key={a.id}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(a.occurredAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td><b>{a.actor}</b> {ACTIONS[a.action] ?? a.action} {a.target ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
