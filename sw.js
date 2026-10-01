// Quick Bill — Service Worker (v2)
//
// Goal: the app ALWAYS opens, even with no internet, and even after it has
// been swiped away from the recent-apps list. Billing already works from data
// saved on the device; this file makes sure the app's own page, fonts and
// Firebase library are available offline too.
//
// What changed from v1 (why offline could show "You are offline"):
//  1. Redirect fix: some hosts (e.g. Cloudflare Pages) redirect /index.html to
//     /. A response that came through a redirect is REFUSED by the browser when
//     served for a page navigation, which showed the offline error even though
//     a saved copy existed. Saved copies are now cleaned of the redirect flag.
//  2. Timeout: on Wi-Fi/mobile data with no real internet, requests hang
//     instead of failing, so the saved copy was never used. Now the network
//     gets 3 seconds, then the saved copy is used.
//  3. Fonts and the Firebase library (loaded from Google) are saved too, so the
//     page no longer stalls waiting for them.
//  4. Precaching no longer fails as a whole if one file is missing.
//
// Data calls (your Apps Script, Firebase database, the registry Worker) are
// never touched here — that data must always be live, and the app already
// handles those calls failing.
//
// IMPORTANT: open the app once WITH internet after updating this file, so the
// new version can install and save everything.

const CACHE_NAME = 'quick-bill-shell-v2';
const NAV_TIMEOUT_MS = 3000;

const ROOT_URL = new URL('./', self.location).href;
const SHELL_URL = new URL('./index.html', self.location).href;
const PRECACHE = [ROOT_URL, SHELL_URL, new URL('./manifest.json', self.location).href];

// the only outside files the app needs just to start
function isStaticVendor(url){
  return url.hostname === 'fonts.googleapis.com' ||
         url.hostname === 'fonts.gstatic.com' ||
         (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'));
}

// page URL without ?query / #hash, so "app.html?source=pwa" matches the saved copy
function keyFor(urlStr){
  const u = new URL(urlStr);
  u.search = ''; u.hash = '';
  return u.href;
}

// a response that went through a redirect can't be used for a navigation —
// rebuild it as a plain response
async function cleanResponse(res){
  if(!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map(async (url) => {
      try{
        const res = await fetch(url, { cache: 'reload' });
        if(res.ok) await cache.put(url, (await cleanResponse(res)).clone());
      } catch(err){ /* one missing file must not stop the rest */ }
    }));
    // the home page and index.html are the same app — make sure both are saved
    const shell = (await cache.match(SHELL_URL)) || (await cache.match(ROOT_URL));
    if(shell){
      if(!(await cache.match(SHELL_URL))) await cache.put(SHELL_URL, shell.clone());
      if(!(await cache.match(ROOT_URL))) await cache.put(ROOT_URL, shell.clone());
    }
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// Opening the app: use the network if it answers within 3 seconds, otherwise
// (offline, or "connected" without real internet) open the saved copy.
async function handleNavigation(event){
  const request = event.request;
  const key = keyFor(request.url);
  const cache = await caches.open(CACHE_NAME);

  const fromNetwork = fetch(request).then(async (res) => {
    if(res.ok){
      const clean = await cleanResponse(res);
      cache.put(key, clean.clone());
      // keep the home page and index.html copies in step with each other
      if(key === ROOT_URL) cache.put(SHELL_URL, clean.clone());
      if(key === SHELL_URL) cache.put(ROOT_URL, clean.clone());
      return clean;
    }
    return res;
  }).catch(() => null);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  const first = await Promise.race([fromNetwork, timeout]);
  if(first && first.ok) return first;

  // only the app's own start pages fall back to the app; any other page that
  // happens to be on this site (like the admin dashboard) is never replaced
  const isAppPage = key === ROOT_URL || key === SHELL_URL;
  const cached = (await cache.match(key)) || (isAppPage ? await cache.match(SHELL_URL) : undefined);
  if(cached){
    event.waitUntil(fromNetwork); // let the refresh finish quietly in the background
    return cached;
  }
  if(first) return first;                       // e.g. a real 404 page, nothing saved to fall back on
  return (await fromNetwork) || Response.error();
}

// Fonts / Firebase library / the app's own icons and manifest: serve the saved
// copy instantly, refresh it in the background.
async function handleStatic(event, crossOrigin){
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: !crossOrigin });

  // outside files are fetched in CORS mode so the saved copy is a normal,
  // readable response (not an opaque one) — Google serves these with CORS open
  const netRequest = crossOrigin ? new Request(request.url, { mode: 'cors', credentials: 'omit' }) : request;
  const refresh = fetch(netRequest).then((res) => {
    if(res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  if(cached){ event.waitUntil(refresh); return cached; }
  return (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if(request.method !== 'GET') return;
  const url = new URL(request.url);

  if(url.origin === self.location.origin){
    if(request.mode === 'navigate'){
      event.respondWith(handleNavigation(event));
    } else {
      event.respondWith(handleStatic(event, false));
    }
    return;
  }

  if(isStaticVendor(url)){
    event.respondWith(handleStatic(event, true));
  }
  // anything else (Apps Script, Firebase database, registry Worker) is left alone
});
