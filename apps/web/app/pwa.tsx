"use client";

import { useEffect } from "react";

/** Enregistre le service worker (page « hors connexion ») : requis pour proposer l'installation sur mobile. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    // HTTPS ou localhost uniquement : ailleurs, le navigateur refuse l'enregistrement.
    if (!window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
