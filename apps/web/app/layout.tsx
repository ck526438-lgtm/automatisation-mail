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
      <body>{children}</body>
    </html>
  );
}
