import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { api, clearSession, sessionToken, tryApi, type Me } from "@/lib/api";
import { ApiDown } from "@/app/ui";

const ROLE_LABELS = { owner: "Propriétaire", admin: "Administrateur", member: "Membre" } as const;

async function logout() {
  "use server";
  const token = await sessionToken();
  if (token) await api("/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
  await clearSession();
  redirect("/connexion");
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await tryApi<Me>("/v1/me");
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.jpg" alt="" />
          <div>
            <b>AUTOMATISATION</b>
            <span>MAIL</span>
          </div>
        </div>
        <nav className="nav">
          <a href="/">Tableau de bord</a>
          <a href="/campagnes">Campagnes</a>
          <a href="/contacts">Contacts</a>
          <a href="/boites">Boîtes d&apos;envoi</a>
          <a href="/domaines">Domaines &amp; DNS</a>
          <a href="/equipe">Équipe &amp; réglages</a>
        </nav>
        {me.data?.user && (
          <div className="whoami">
            <b>{me.data.user.name ?? me.data.user.email}</b>
            <span className="muted">{me.data.org.name} · {ROLE_LABELS[me.data.role]}</span>
            <form action={logout}><button className="linkbtn">Se déconnecter</button></form>
          </div>
        )}
      </aside>
      <main>{me.error ? <ApiDown error={me.error} /> : children}</main>
    </div>
  );
}
