import { tryApi, type Account, type Campaign, type Me, type SystemSmtpSettings } from "@/lib/api";
import { ApiDown, Badge } from "@/app/ui";

export const dynamic = "force-dynamic";

type Dashboard = Record<"contacts" | "active_contacts" | "running_campaigns" | "sent_30d" | "replies_30d" | "bounces_30d", number>;

export default async function Home() {
  const [dash, camps, me, accounts] = await Promise.all([
    tryApi<Dashboard>("/v1/dashboard"), tryApi<Campaign[]>("/v1/campaigns"), tryApi<Me>("/v1/me"), tryApi<Account[]>("/v1/accounts"),
  ]);
  if (dash.error) return <ApiDown error={dash.error} />;
  const d = dash.data!;
  const smtp = me.data?.canManagePlatform ? await tryApi<SystemSmtpSettings>("/v1/system-smtp") : null;
  const steps = [
    { done: Boolean(me.data?.org.postalAddress), label: "Renseigner l'adresse postale de l'entreprise (obligatoire dans chaque e-mail)", href: "/equipe" },
    { done: (accounts.data ?? []).length > 0, label: "Connecter une boîte d'envoi (Google, Microsoft ou SMTP)", href: "/boites" },
    ...(smtp ? [{ done: Boolean(smtp.data?.configured), label: "Configurer le SMTP des e-mails système (alertes, mot de passe)", href: "/equipe" }] : []),
    { done: d.contacts > 0, label: "Importer vos contacts", href: "/contacts" },
    { done: (camps.data ?? []).some((c) => c.status === "running"), label: "Démarrer une campagne", href: "/campagnes" },
  ];
  const todo = steps.filter((s) => !s.done);
  const replyRate = d.sent_30d ? ((100 * d.replies_30d) / d.sent_30d).toFixed(1) : "0";
  const bounceRate = d.sent_30d ? ((100 * d.bounces_30d) / d.sent_30d).toFixed(1) : "0";

  return (
    <>
      <h1>Tableau de bord</h1>
      {todo.length > 0 && (
        <div className="panel" style={{ marginBottom: 20 }}><div className="panel-body">
          <b>Pour commencer</b> <span className="muted">({steps.length - todo.length}/{steps.length})</span>
          <ul className="checklist">
            {steps.map((s) => <li key={s.label} className={s.done ? "done" : ""}>{s.done ? "✓" : "○"} {s.done ? s.label : <a href={s.href}>{s.label}</a>}</li>)}
          </ul>
        </div></div>
      )}
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
