import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Automatisation Mail",
  description: "Séquences d'e-mails B2B, délivrabilité et conformité.",
  icons: { icon: "/logo.jpg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
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
            </nav>
          </aside>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
