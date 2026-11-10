import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api, tryApi, type Contact } from "@/lib/api";
import { ApiDown, Badge } from "@/app/ui";

export const dynamic = "force-dynamic";

interface ImportResult {
  inserted: number;
  updated: number;
  duplicates: number;
  suppressed: number;
  invalid: { row: number; email: string; reason: string }[];
}

async function importCsv(formData: FormData) {
  "use server";
  const file = formData.get("file");
  const pasted = String(formData.get("csv") ?? "");
  const csv = file instanceof File && file.size > 0 ? await file.text() : pasted;
  const tags = String(formData.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  let msg: string;
  try {
    const r = await api<ImportResult>("/v1/contacts/import", { method: "POST", body: JSON.stringify({ csv, tags }) });
    msg = `${r.inserted} ajouté(s), ${r.updated} mis à jour, ${r.duplicates} doublon(s), ${r.suppressed} en liste de suppression, ${r.invalid.length} invalide(s).`;
  } catch (e) {
    msg = `Échec de l'import : ${(e as Error).message}`;
  }
  revalidatePath("/contacts");
  redirect(`/contacts?import=${encodeURIComponent(msg)}`);
}

export default async function Contacts({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; import?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ limit: "100", ...(sp.q ? { search: sp.q } : {}), ...(sp.status ? { status: sp.status } : {}) });
  const { data, error } = await tryApi<{ total: number; items: Contact[] }>(`/v1/contacts?${qs}`);
  if (error) return <ApiDown error={error} />;

  return (
    <>
      <h1>Contacts</h1>
      <p className="lead">{data!.total} contact(s). Les adresses invalides, jetables ou désinscrites sont écartées à l&apos;import.</p>
      {sp.import && <div className="notice">{sp.import}</div>}

      <div className="grid2">
        <div className="panel"><div className="panel-body">
          <b>Importer un CSV</b>
          <p className="muted">Colonnes reconnues : e-mail, prénom, nom, société, poste, téléphone, pays. Les autres deviennent des champs personnalisés. Séparateur « , » ou « ; ».</p>
          <form action={importCsv}>
            <p><input type="file" name="file" accept=".csv,text/csv" /></p>
            <textarea name="csv" placeholder={"email;prenom;societe\nawa@exemple.ci;Awa;Koné Logistique"} />
            <div className="row" style={{ marginTop: 10 }}>
              <input name="tags" placeholder="Tags (séparés par des virgules)" style={{ flex: 1 }} />
              <button className="btn accent">Importer</button>
            </div>
          </form>
        </div></div>

        <div className="panel"><div className="panel-body">
          <b>Rechercher</b>
          <form className="row" style={{ marginTop: 10 }}>
            <input name="q" defaultValue={sp.q} placeholder="E-mail, société, nom…" style={{ flex: 1 }} />
            <select name="status" defaultValue={sp.status ?? ""}>
              <option value="">Tous les statuts</option>
              <option value="active">Actifs</option>
              <option value="unsubscribed">Désinscrits</option>
              <option value="bounced">Rebonds</option>
              <option value="complained">Plaintes</option>
            </select>
            <button className="btn secondary">Filtrer</button>
          </form>
          <p className="muted">Droits RGPD : <code>GET /v1/contacts/:id/export</code> (accès) et <code>DELETE /v1/contacts/:id</code> (effacement).</p>
        </div></div>
      </div>

      <h2>Liste</h2>
      <div className="panel">
        <table>
          <thead><tr><th>E-mail</th><th>Nom</th><th>Société</th><th>Poste</th><th>Statut</th><th>Source</th></tr></thead>
          <tbody>
            {data!.items.map((c) => (
              <tr key={c.id}>
                <td>{c.email}</td>
                <td>{[c.firstName, c.lastName].filter(Boolean).join(" ")}</td>
                <td>{c.company}</td>
                <td>{c.title}</td>
                <td><Badge value={c.status} /></td>
                <td className="muted">{c.source}</td>
              </tr>
            ))}
            {data!.items.length === 0 && <tr><td colSpan={6} className="muted">Aucun contact.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
