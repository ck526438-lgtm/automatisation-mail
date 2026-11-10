import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api, ApiError, tryApi, type Account } from "@/lib/api";
import { ApiDown } from "@/app/ui";

export const dynamic = "force-dynamic";

async function togglePause(formData: FormData) {
  "use server";
  await api(`/v1/accounts/${String(formData.get("id"))}`, { method: "PATCH", body: JSON.stringify({ paused: formData.get("paused") === "true" }) });
  revalidatePath("/boites");
}

async function connect(formData: FormData) {
  "use server";
  const provider = formData.get("provider") === "outlook" ? "outlook" : "gmail";
  let url: string;
  try {
    url = (await api<{ url: string }>(`/v1/oauth/${provider}/start`)).url;
  } catch (e) {
    redirect(`/boites?erreur=${encodeURIComponent(e instanceof ApiError ? e.message : "Connexion impossible")}`);
  }
  redirect(url);
}

const PROVIDERS: Record<string, string> = { gmail: "Google Workspace", outlook: "Microsoft 365", smtp: "SMTP", ses: "Amazon SES" };

function syncLabel(a: Account): string {
  if (!a.inboxSync) return "Lecture des réponses non configurée";
  if (a.syncError) return a.syncError;
  if (!a.lastSyncAt) return "Première lecture en attente";
  const min = Math.round((Date.now() - new Date(a.lastSyncAt).getTime()) / 60_000);
  return `Réponses lues il y a ${min < 1 ? "moins d'une minute" : `${min} min`}`;
}

function health(score: number) {
  if (score >= 70) return { label: "Bonne", cls: "ok" };
  if (score >= 50) return { label: "Volume réduit de moitié", cls: "warning" };
  return { label: "Envois suspendus", cls: "error" };
}

export default async function Accounts({ searchParams }: { searchParams: Promise<{ connecte?: string; erreur?: string }> }) {
  const sp = await searchParams;
  const { data, error } = await tryApi<Account[]>("/v1/accounts");
  if (error) return <ApiDown error={error} />;
  return (
    <>
      <h1>Boîtes d&apos;envoi</h1>
      <p className="lead">Chaque boîte monte en charge progressivement (warm-up) et est freinée automatiquement si son score de santé baisse. Les réponses et rebonds sont lus toutes les 2 minutes.</p>
      {sp.connecte && <div className="notice">Boîte <b>{sp.connecte}</b> connectée. Le warm-up démarre aujourd&apos;hui.</div>}
      {sp.erreur && <div className="notice error">{sp.erreur}</div>}
      <form action={connect} className="row" style={{ marginBottom: 20 }}>
        <button className="btn" name="provider" value="gmail">Connecter Google Workspace</button>
        <button className="btn" name="provider" value="outlook">Connecter Microsoft 365</button>
        <span className="muted">Autre hébergeur : <code>POST /v1/accounts</code> (SMTP + IMAP).</span>
      </form>
      <div className="panel">
        <table>
          <thead><tr><th>Boîte</th><th>Santé</th><th>Warm-up</th><th className="num">Envoyés aujourd&apos;hui</th><th className="num">Autorisés</th><th></th></tr></thead>
          <tbody>
            {data!.map((a) => {
              const h = health(a.healthScore);
              const allowed = a.healthScore < 50 ? 0 : a.healthScore < 70 ? Math.floor(a.todayPlan.campaign / 2) : a.todayPlan.campaign;
              return (
                <tr key={a.id}>
                  <td>
                    {a.email}
                    <div className="muted">{a.fromName ? `${a.fromName} · ` : ""}{PROVIDERS[a.provider] ?? a.provider}</div>
                    {a.needsReconnect
                      ? <span className="badge error">Reconnexion nécessaire</span>
                      : <div className="muted">{syncLabel(a)}</div>}
                  </td>
                  <td>
                    <div className="row"><div className="bar"><i style={{ width: `${a.healthScore}%` }} /></div><b>{a.healthScore}</b></div>
                    <span className={`badge ${h.cls}`}>{h.label}</span>
                  </td>
                  <td>{a.warmupEnabled ? (a.warmupDay < 21 ? `Jour ${a.warmupDay + 1} · ${a.todayPlan.warmup} échanges` : "Terminé, maintien actif") : "Désactivé"}</td>
                  <td className="num">{a.sentToday}</td>
                  <td className="num">{allowed}</td>
                  <td>
                    {a.needsReconnect && (a.provider === "gmail" || a.provider === "outlook") ? (
                      <form action={connect}><button className="btn accent" name="provider" value={a.provider}>Reconnecter</button></form>
                    ) : (
                      <form action={togglePause}>
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="paused" value={String(!a.paused)} />
                        <button className="btn secondary">{a.paused ? "Réactiver" : "Mettre en pause"}</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
            {data!.length === 0 && <tr><td colSpan={6} className="muted">Aucune boîte. Connectez une boîte Google ou Microsoft ci-dessus.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
