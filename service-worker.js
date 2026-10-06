// KORVA service worker
// Bump CACHE_VERSION whenever index.html (or other cached assets) change,
// so users get the new version instead of a stale cached one.
//
// FIX: this was never bumped past 'korva-v1' despite many index.html updates
// throughout development. Because the app-shell fetch handler below is
// cache-first (serves the cached copy instantly, only refreshes the cache in
// the background for NEXT time), every redeploy was invisible on first load -
// the browser kept serving the old cached index.html, and only a second
// reload (after the background revalidation fetch landed) picked up the new
// code. That's exactly what made the account-switch fix look like it
// "transferred back, then cleared up on refresh": the first load after
// deploying was still running the OLD pre-fix code. Bump this version string
// with every index.html change from here on - it's what forces activate() to
// drop the old cache and install() to pre-cache the new files, so a redeploy
// takes effect on the very next load instead of needing an extra refresh.
const CACHE_VERSION = 'korva-v64';


const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './css/quote.css',
  './js/quote.js',
  './js/treatment.js',
  './js/business-sync.js',
  './js/telemetry.js',
  './js/vendor/sentry-11.4.0.min.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

const APP_SHELL_PATHS = new Set(APP_SHELL.map((path) => new URL(path, self.location).pathname));

// External resources the app needs (jsPDF + fonts) - cached so PDF
// generation and styling keep working offline after first load.
const EXTERNAL_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

// ── INSTALL: pre-cache the app shell ────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // cache: 'reload' skips the browser's HTTP cache. GitHub Pages lets files
      // sit there for up to 10 minutes, so without it a new cache could pair a
      // fresh index.html with a stale script from the last version, and the
      // app would load blank.
      const fresh = (url) => new Request(url, { cache: 'reload' });
      // Externals go in separately: addAll is all-or-nothing, so one CDN
      // hiccup used to leave the app shell uncached too.
      return Promise.all([
        cache.addAll(APP_SHELL.map(fresh)),
        cache.addAll(EXTERNAL_ASSETS.map(fresh)),
      ]).catch((err) => {
        console.warn('Service worker: some assets failed to pre-cache', err);
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean up old cache versions ───────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH: cache-first for app shell & known externals, network-first otherwise ──
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Match whole paths. An endsWith('') check on './' used to match every
  // request, Supabase included, and served it all cache-first.
  const isAppShell = url.origin === self.location.origin &&
    APP_SHELL_PATHS.has(url.pathname) && !url.search;
  const isExternal = EXTERNAL_ASSETS.includes(request.url);
  const isFont = url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com');

  if (isAppShell || isExternal || isFont) {
    // Cache-first: serve instantly from cache, update cache in background
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(request).then((cached) => {
          // no-cache revalidates with the server instead of reusing a stale copy.
          // By URL, because a navigation Request can't take extra options.
          const networkFetch = (isAppShell ? fetch(request.url, { cache: 'no-cache' }) : fetch(request))
            .then((response) => {
              if (response.ok) cache.put(request, response.clone());
              return response;
            })
            .catch(() => cached); // offline fallback to cache if network fails

          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // Everything else (e.g. navigation requests to index.html with query params):
  // network-first with cache fallback, so the app still loads offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && request.url.startsWith(self.location.origin)) {
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
