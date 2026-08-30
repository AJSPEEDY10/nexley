/* Nexley — service worker
 *
 * Offline is a hard requirement: the iPad this is aimed at has no network, so once the
 * app is on the device it has to run with nothing behind it.
 *
 * Strategy — network-first with a short timeout, falling back to cache:
 *   - online  → always the freshest files, so edits during the build show up immediately
 *   - offline → fetch rejects straight away and the precached shell is served
 *   - flaky   → the timeout stops a half-open connection hanging the app
 *
 * This deliberately avoids plain cache-first. That is what burned the Tovo PWA: index.html
 * came from cache forever and edits never appeared no matter how often it was refreshed.
 * Here the network always wins when it is actually available.
 *
 * When releasing a change: bump CACHE. skipWaiting + clients.claim mean the new worker
 * takes over on the next load rather than waiting for every tab to close.
 */

var CACHE = 'nexley-v1';
var NET_TIMEOUT = 3000;

/* The shell is precached at install so the very first offline launch works, even if the
   user has never visited these URLs individually. supabase-js is precached too — auth and
   sync calls fail gracefully offline (see sync.js's navigator.onLine guard), but the shell
   itself, including the sign-in screen for an already-authenticated session, must load. */
var SHELL = [
  './',
  './index.html',
  './app.css',
  './legal.html',
  './config.js',
  './auth.js',
  './sync.js',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // addAll is all-or-nothing; cache individually so one bad entry can't
      // stop the whole worker installing
      return Promise.all(SHELL.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' })).catch(function () {});
      })).then(function () {
        // Activate straight away rather than sitting in "waiting". The client
        // (setupUpdates in app.js) reloads once on controllerchange, and notes
        // are in IndexedDB + flushed on visibilitychange, so nothing is lost.
        return self.skipWaiting();
      });
    })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function fromNetwork(req) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('network timeout')); }
    }, NET_TIMEOUT);

    fetch(req).then(function (res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // stash a fresh copy for the next offline launch
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      resolve(res);
    }).catch(function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fromNetwork(req).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        // a navigation with nothing cached for that exact URL still gets the app
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('Offline and not cached.', {
          status: 504,
          headers: { 'Content-Type': 'text/plain' }
        });
      });
    })
  );
});
