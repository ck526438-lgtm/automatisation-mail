import { revalidatePath } from "next/cache";
import { api, tryApi, type Account } from "@/lib/api";
import { ApiDown } from "../ui";

export const dynamic = "force-dynamic";

async function togglePause(formData: FormData) {
  "use server";
  await api(`/v1/accounts/${String(formData.get("id"))}`, { method: "PATCH", body: JSON.stringify({ paused: formData.get("paused") === "true" }) });
  revalidatePath("/boites");
}

function health(score: number) {
  if (score >= 70) return { label: "Bonne", cls: "ok" };
  if (score >= 50) return { label: "Volume réduit de moitié", cls: "warning" };
  return { label: "Envois suspendus", cls: "error" };
}

export default async function Accounts() {
  const { data, error } = await tryApi<Account[]>("/v1/accounts");
  if (error) return <ApiDown error={error} />;
  return (
    <>
      <h1>Boîtes d&apos;envoi</h1>
      <p className="lead">Chaque boîte monte en charge progressivement (warm-up) et est freinée automatiquement si son score de santé baisse.</p>
      <div className="panel">
        <table>
          <thead><tr><th>Boîte</th><th>Santé</th><th>Warm-up</th><th className="num">Envoyés aujourd&apos;hui</th><th className="num">Autorisés</th><th></th></tr></thead>
          <tbody>
            {data!.map((a) => {
              const h = health(a.healthScore);
              const allowed = a.healthScore < 50 ? 0 : a.healthScore < 70 ? Math.floor(a.todayPlan.campaign / 2) : a.todayPlan.campaign;
              return (
                <tr key={a.id}>
                  <td>{a.email}<div className="muted">{a.fromName} · {a.provider.toUpperCase()}</div></td>
                  <td>
                    <div className="row"><div className="bar"><i style={{ width: `${a.healthScore}%` }} /></div><b>{a.healthScore}</b></div>
                    <span className={`badge ${h.cls}`}>{h.label}</span>
                  </td>
                  <td>{a.warmupEnabled ? (a.warmupDay < 21 ? `Jour ${a.warmupDay + 1} · ${a.todayPlan.warmup} échanges` : "Terminé, maintien actif") : "Désactivé"}</td>
                  <td className="num">{a.sentToday}</td>
                  <td className="num">{allowed}</td>
                  <td>
                    <form action={togglePause}>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="paused" value={String(!a.paused)} />
                      <button className="btn secondary">{a.paused ? "Réactiver" : "Mettre en pause"}</button>
                    </form>
                  </td>
                </tr>
              );
            })}
            {data!.length === 0 && <tr><td colSpan={6} className="muted">Aucune boîte. Ajoutez-en une avec <code>POST /v1/accounts</code> (SMTP).</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
