/*
 * Service worker minimal de l'application installée (Android, iOS, ChromeOS).
 * Il ne met en cache AUCUNE donnée de l'application (contacts, campagnes…) : uniquement la page
 * « hors connexion », affichée quand le serveur est injoignable.
 */
const CACHE = "am-offline-v1";
const OFFLINE_URL = "/hors-connexion.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE_URL, "/icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
