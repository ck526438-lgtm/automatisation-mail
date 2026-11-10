import { tryApi, type Campaign, type CampaignStats } from "@/lib/api";
import { ApiDown, Badge } from "../../ui";

export const dynamic = "force-dynamic";

type Stats = CampaignStats & { campaign: Campaign; perStep: { nodeId: string; type: string; contacts: number }[] };

const STEP_TYPES = ["sent", "open", "click", "reply", "bounce", "unsubscribe"] as const;
const STEP_LABELS: Record<string, string> = { sent: "Envoyés", open: "Ouverts", click: "Cliqués", reply: "Réponses", bounce: "Rebonds", unsubscribe: "Désinscrits" };

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, error } = await tryApi<Stats>(`/v1/campaigns/${id}/stats`);
  if (error) return <ApiDown error={error} />;
  const s = data!;
  const steps = [...new Set(s.perStep.map((p) => p.nodeId))];
  const cell = (node: string, type: string) => s.perStep.find((p) => p.nodeId === node && p.type === type)?.contacts ?? 0;
  const funnel = [
    ["Envoyés", s.sent, 100],
    ["Ouverts", s.opened, s.rates.open],
    ["Cliqués", s.clicked, s.rates.click],
    ["Réponses", s.replied, s.rates.reply],
  ] as const;

  return (
    <>
      <p className="muted"><a href="/campagnes">← Campagnes</a></p>
      <h1>{s.campaign.name}</h1>
      <p className="lead"><Badge value={s.campaign.status} /> {s.campaign.pauseReason ?? ""}</p>

      <div className="kpis">
        <div className="kpi"><small>Envoyés</small><strong>{s.sent}</strong></div>
        <div className="kpi"><small>Réponses</small><strong>{s.rates.reply} %</strong></div>
        <div className="kpi"><small>Clics</small><strong>{s.rates.click} %</strong></div>
        <div className="kpi"><small>Rebonds</small><strong>{s.rates.bounce} %</strong></div>
        <div className="kpi"><small>Désinscriptions</small><strong>{s.rates.unsubscribe} %</strong></div>
      </div>

      <h2>Entonnoir</h2>
      <div className="panel"><div className="panel-body">
        {funnel.map(([label, n, pct]) => (
          <div className="row" key={label} style={{ marginBottom: 10 }}>
            <span style={{ width: 90 }}>{label}</span>
            <div className="bar" style={{ width: 320 }}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
            <span className="muted">{n} · {pct} %</span>
          </div>
        ))}
        <p className="muted">Les ouvertures automatiques (proxys d&apos;images, scanners) sont exclues. Le chiffre reste indicatif : Apple Mail masque les ouvertures réelles.</p>
      </div></div>

      <h2>Par étape de la séquence</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Étape</th>{STEP_TYPES.map((t) => <th key={t} className="num">{STEP_LABELS[t]}</th>)}</tr></thead>
          <tbody>
            {steps.map((n) => (
              <tr key={n}><td>{n}</td>{STEP_TYPES.map((t) => <td key={t} className="num">{cell(n, t)}</td>)}</tr>
            ))}
            {steps.length === 0 && <tr><td colSpan={7} className="muted">Pas encore d&apos;envoi.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
