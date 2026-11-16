import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "./pwa";
import "./globals.css";

export const metadata: Metadata = {
  title: "Automatisation Mail",
  description: "Séquences d'e-mails B2B, délivrabilité et conformité.",
  applicationName: "Automatisation Mail",
  icons: {
    icon: [
      { url: "/icons/favicon.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
  },
  // iPhone / iPad : « Sur l'écran d'accueil » ouvre l'interface en plein écran, comme une application.
  appleWebApp: { capable: true, title: "Auto Mail", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#1f5fbf" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1524" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
