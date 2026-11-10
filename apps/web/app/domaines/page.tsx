import { tryApi, type DomainReport, type ProtocolResult } from "@/lib/api";
import { ApiDown, Badge } from "../ui";

export const dynamic = "force-dynamic";

const ROWS: [keyof Pick<DomainReport, "spf" | "dkim" | "dmarc" | "mx">, string, string][] = [
  ["spf", "SPF", "Liste les serveurs autorisés à envoyer pour votre domaine."],
  ["dkim", "DKIM", "Signature cryptographique qui prouve que le message n'a pas été modifié."],
  ["dmarc", "DMARC", "Politique appliquée quand SPF ou DKIM échoue, et rapports."],
  ["mx", "MX", "Serveurs qui reçoivent les réponses et les rebonds."],
];

function Result({ r }: { r: ProtocolResult }) {
  return (
    <>
      <Badge value={r.status} />
      {r.record && <div><code>{r.record}</code></div>}
      <ul className="details">{r.details.map((d) => <li key={d}>{d}</li>)}</ul>
    </>
  );
}

export default async function Domains({ searchParams }: { searchParams: Promise<{ domain?: string }> }) {
  const { domain } = await searchParams;
  const report = domain ? await tryApi<DomainReport>(`/v1/dns-check?domain=${encodeURIComponent(domain)}`) : null;
  if (report?.error) return <ApiDown error={report.error} />;
  const r = report?.data;

  return (
    <>
      <h1>Domaines &amp; DNS</h1>
      <p className="lead">Gmail et Yahoo exigent SPF, DKIM et DMARC pour les expéditeurs en volume. Vérifiez votre domaine avant tout envoi.</p>
      <form className="row" style={{ marginBottom: 20 }}>
        <input name="domain" defaultValue={domain} placeholder="exemple.ci" style={{ width: 280 }} required />
        <button className="btn">Vérifier</button>
      </form>
      {r && (
        <>
          <div className={`notice ${r.sendable ? "" : "error"}`}>
            <b>{r.domain}</b> : {r.sendable ? "prêt à envoyer." : "authentification incomplète, envois bloqués tant que SPF, DKIM et DMARC ne sont pas en place."}
          </div>
          <div className="panel">
            <table>
              <thead><tr><th style={{ width: 120 }}>Protocole</th><th>Résultat</th></tr></thead>
              <tbody>
                {ROWS.map(([k, label, help]) => (
                  <tr key={k}>
                    <td><b>{label}</b><div className="muted">{help}</div></td>
                    <td><Result r={r[k]} /></td>
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
