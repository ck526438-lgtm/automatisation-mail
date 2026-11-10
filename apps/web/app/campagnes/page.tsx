import { revalidatePath } from "next/cache";
import { api, tryApi, type Campaign } from "@/lib/api";
import { ApiDown, Badge } from "../ui";

export const dynamic = "force-dynamic";

async function toggle(formData: FormData) {
  "use server";
  const id = String(formData.get("id"));
  const action = formData.get("action") === "start" ? "start" : "pause";
  await api(`/v1/campaigns/${id}/${action}`, { method: "POST", body: "{}" });
  revalidatePath("/campagnes");
}

async function enrollAll(formData: FormData) {
  "use server";
  await api(`/v1/campaigns/${String(formData.get("id"))}/enroll`, { method: "POST", body: JSON.stringify({ all: true }) });
  revalidatePath("/campagnes");
}

const TYPES = { cold: "Prospection", nurture: "Rétention", newsletter: "Newsletter" } as const;

export default async function Campaigns() {
  const { data, error } = await tryApi<Campaign[]>("/v1/campaigns");
  if (error) return <ApiDown error={error} />;
  return (
    <>
      <h1>Campagnes</h1>
      <p className="lead">Chaque campagne exécute une séquence. Elle s&apos;arrête pour un contact dès qu&apos;il répond, se désinscrit ou rebondit.</p>
      <div className="panel">
        <table>
          <thead><tr><th>Campagne</th><th>Type</th><th>Statut</th><th>En cours</th><th>Terminés</th><th>Arrêtés</th><th></th></tr></thead>
          <tbody>
            {data!.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`/campagnes/${c.id}`}>{c.name}</a>
                  {c.pauseReason && <div className="muted">{c.pauseReason}</div>}
                </td>
                <td>{TYPES[c.type]}</td>
                <td><Badge value={c.status} /></td>
                <td className="num">{(c.enrollments.active ?? 0) + (c.enrollments.waiting ?? 0)}</td>
                <td className="num">{c.enrollments.completed ?? 0}</td>
                <td className="num">{c.enrollments.stopped ?? 0}</td>
                <td>
                  <div className="row">
                    <form action={toggle}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="action" value={c.status === "running" ? "pause" : "start"} />
                      <button className={c.status === "running" ? "btn secondary" : "btn"}>{c.status === "running" ? "Mettre en pause" : "Démarrer"}</button>
                    </form>
                    <form action={enrollAll}>
                      <input type="hidden" name="id" value={c.id} />
                      <button className="btn secondary" title="Inscrire tous les contacts actifs">Inscrire tous</button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {data!.length === 0 && <tr><td colSpan={7} className="muted">Aucune campagne. Créez-en une via l&apos;API (<code>POST /v1/campaigns</code>) ou lancez <code>pnpm db:seed</code>.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
