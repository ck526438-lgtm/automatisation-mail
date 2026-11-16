import type { MetadataRoute } from "next";

/** Manifeste d'application web : permet d'installer l'interface sur Android, iPhone/iPad et ChromeOS. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Automatisation Mail",
    short_name: "Auto Mail",
    description: "Séquences d'e-mails B2B, délivrabilité et conformité.",
    lang: "fr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f6f8fb",
    theme_color: "#1f5fbf",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Campagnes", url: "/campagnes" },
      { name: "Contacts", url: "/contacts" },
      { name: "Boîtes d'envoi", url: "/boites" },
    ],
  };
}
