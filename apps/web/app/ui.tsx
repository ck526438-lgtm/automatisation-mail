export function ApiDown({ error }: { error: string }) {
  return (
    <div className="notice error">
      <b>L&apos;API ne répond pas.</b> {error}
      <p className="muted">
        Démarrez l&apos;infrastructure (<code>docker compose up -d</code>), puis <code>pnpm dev</code>. Vérifiez{" "}
        <code>API_URL</code> et <code>API_KEY</code> dans <code>apps/web/.env.local</code>.
      </p>
    </div>
  );
}

const LABELS: Record<string, string> = {
  ok: "OK", warning: "À améliorer", missing: "Absent", error: "Erreur",
  draft: "Brouillon", running: "En cours", paused: "En pause", completed: "Terminée",
  active: "Actif", unsubscribed: "Désinscrit", bounced: "Rebond", complained: "Plainte",
};

export function Badge({ value }: { value: string }) {
  return <span className={`badge ${value}`}>{LABELS[value] ?? value}</span>;
}
