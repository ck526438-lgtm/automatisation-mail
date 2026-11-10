import { tryApi, type Campaign } from "@/lib/api";
import { ApiDown, Badge } from "./ui";

export const dynamic = "force-dynamic";

type Dashboard = Record<"contacts" | "active_contacts" | "running_campaigns" | "sent_30d" | "replies_30d" | "bounces_30d", number>;

export default async function Home() {
  const [dash, camps] = await Promise.all([tryApi<Dashboard>("/v1/dashboard"), tryApi<Campaign[]>("/v1/campaigns")]);
  if (dash.error) return <ApiDown error={dash.error} />;
  const d = dash.data!;
  const replyRate = d.sent_30d ? ((100 * d.replies_30d) / d.sent_30d).toFixed(1) : "0";
  const bounceRate = d.sent_30d ? ((100 * d.bounces_30d) / d.sent_30d).toFixed(1) : "0";

  return (
    <>
      <h1>Tableau de bord</h1>
      <p className="lead">Activité des 30 derniers jours. Les réponses sont l&apos;indicateur de référence en prospection.</p>
      <div className="kpis">
        <div className="kpi"><small>E-mails envoyés</small><strong>{d.sent_30d}</strong></div>
        <div className="kpi"><small>Taux de réponse</small><strong>{replyRate} %</strong></div>
        <div className="kpi"><small>Taux de rebond</small><strong>{bounceRate} %</strong></div>
        <div className="kpi"><small>Contacts actifs</small><strong>{d.active_contacts}</strong></div>
        <div className="kpi"><small>Campagnes en cours</small><strong>{d.running_campaigns}</strong></div>
      </div>

      <h2>Campagnes récentes</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Campagne</th><th>Statut</th><th>Inscrits</th><th>Terminés</th><th>Arrêtés</th></tr></thead>
          <tbody>
            {(camps.data ?? []).slice(0, 6).map((c) => {
              const total = Object.values(c.enrollments).reduce((a, b) => a + b, 0);
              return (
                <tr key={c.id}>
                  <td><a href={`/campagnes/${c.id}`}>{c.name}</a></td>
                  <td><Badge value={c.status} /></td>
                  <td className="num">{total}</td>
                  <td className="num">{c.enrollments.completed ?? 0}</td>
                  <td className="num">{c.enrollments.stopped ?? 0}</td>
                </tr>
              );
            })}
            {(camps.data ?? []).length === 0 && <tr><td colSpan={5} className="muted">Aucune campagne pour l&apos;instant.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
