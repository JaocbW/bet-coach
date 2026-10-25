/* Service worker: makes the app work offline.
   IMPORTANT: when you change any file, bump VERSION (v1 -> v2) so phones pick up the new version. */
const VERSION = "v1";
const CACHE = "bet-coach-" + VERSION;
const APP_FILES = ["./", "./index.html", "./styles.css", "./teams.js", "./app.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-180.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("bet-coach-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if(e.request.method !== "GET" || url.hostname === "api.anthropic.com") return;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if(url.origin !== location.origin && !isFont) return;
  // Network first for app files (so edits show up), falling back to the cache when offline.
  e.respondWith(
    fetch(e.request).then(res => {
      if(res.ok || res.type === "opaque"){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
