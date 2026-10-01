// @ts-check
/**
 * Service worker: keeps the app shell in a cache so the page opens with no
 * signal, and swaps in a new version only once all of it has arrived.
 *
 * There is no build step, so no file name carries a hash and nothing bumps a
 * version on deploy. Instead the shell is downloaded as a set, and a hash of
 * the whole set names the cache:
 *
 * - The page always loads cache-first. That is instant, and it is the same on
 *   one bar of signal in a shop as it is with none.
 * - A few seconds after each open, the worker checks for a new version. Every
 *   file is fetched again, with cheap conditional requests. If all of them
 *   arrive and the hash differs, the new cache replaces the old in one step
 *   and the page is told a new version is ready. A check that fails part way
 *   changes nothing.
 *
 * So a load never mixes files from two versions, and a deploy is picked up by
 * the next load after one that saw it, with nothing to remember on deploy.
 *
 * Only the app page is served from the cache. Anything else in scope, such as
 * the browser test page and the files it imports, goes to the network as if
 * this worker were not here.
 */

const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

/**
 * Every file the app needs to start, relative to this script. Keep in step
 * with src/: test/shell.test.js fails if a file is missing here, or listed
 * here but gone.
 */
const SHELL = [
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'src/adapters/drive.js',
  'src/app.js',
  'src/config.js',
  'src/core/db.js',
  'src/core/errors.js',
  'src/core/list.js',
  'src/core/merge.js',
  'src/core/quantity.js',
  'src/core/recipe.js',
  'src/core/sync.js',
  'src/core/types.js',
  'src/core/units.js',
  'src/ui/auth.js',
  'src/ui/dom.js',
  'src/ui/views/catalog.js',
  'src/ui/views/import.js',
  'src/ui/views/list.js',
  'src/ui/views/lists.js',
  'src/ui/views/recipe.js',
  'src/ui/views/recipes.js',
  'src/ui/views/sync.js',
];

/**
 * Cache names are per origin, and every Pages site on the account shares
 * one origin, so the prefix has to be specific to this app.
 */
const PREFIX = 'recipe-book-shell-';

/**
 * A check waits this long after the page is served, so the page finishes
 * loading from one version before a check can swap in the next.
 */
const CHECK_DELAY_MS = 3_000;

/** Give up on a check that hangs on a weak signal; the next load tries again. */
const CHECK_TIMEOUT_MS = 30_000;

const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, sw.location.href).href));
const SCOPE_PATH = new URL('./', sw.location.href).pathname;

/** @param {URL} url */
function isAppPage(url) {
  return (
    url.origin === sw.location.origin &&
    (url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`)
  );
}

/** @type {Promise<string|undefined>|undefined} */
let current;

/**
 * The cache in use: the newest one holding every shell file. Checking
 * completeness means a worker stopped half way through writing a new version
 * leaves the old one in charge.
 *
 * @returns {Promise<string|undefined>}
 */
function currentName() {
  current ??= (async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith(PREFIX)).reverse();
    for (const name of names) {
      const cache = await caches.open(name);
      const hits = await Promise.all(SHELL.map((path) => cache.match(path)));
      if (hits.every(Boolean)) return name;
    }
    return undefined;
  })();
  return current;
}

/**
 * @param {ArrayBuffer[]} bodies  in SHELL order
 * @returns {Promise<string>}
 */
async function hashShell(bodies) {
  // Each body is framed by its path and length, so moving text from the end
  // of one file to the start of the next still counts as a change.
  const framed = new Blob(SHELL.flatMap((path, i) => [`${path} ${bodies[i]?.byteLength}\n`, bodies[i] ?? '']));
  const digest = await crypto.subtle.digest('SHA-256', await framed.arrayBuffer());
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Downloads the whole shell and makes it the cache in use, unless it matches
 * the one already in use. Old caches are left for the caller to remove, so
 * an installing worker never deletes what the active one is serving from.
 *
 * @returns {Promise<boolean>}  true if a new version was stored
 */
async function refresh() {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const files = await Promise.all(
    SHELL.map(async (path) => {
      // no-cache revalidates with the server; unchanged files come back as 304s.
      const response = await fetch(path, { cache: 'no-cache', signal });
      if (!response.ok) throw new Error(`${response.status} fetching ${path}`);
      // Read each body as soon as it arrives. Collecting unread responses
      // first stalled installing after four files: the rest never left.
      const { status, statusText, headers } = response;
      return { path, body: await response.arrayBuffer(), init: { status, statusText, headers } };
    }),
  );
  const name = PREFIX + (await hashShell(files.map((file) => file.body)));
  if (name === (await currentName())) return false;

  const cache = await caches.open(name);
  await Promise.all(files.map(({ path, body, init }) => cache.put(path, new Response(body, init))));
  current = Promise.resolve(name);
  return true;
}

async function removeOldCaches() {
  const keep = await currentName();
  const old = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== keep);
  await Promise.all(old.map((name) => caches.delete(name)));
}

async function tellPages() {
  for (const client of await sw.clients.matchAll({ type: 'window' })) client.postMessage('updated');
}

/** @type {Promise<void>|undefined} */
let checking;

/** One check at a time; a load while one is running just waits on it. */
function check() {
  checking ??= refresh()
    .then(async (changed) => {
      if (!changed) return;
      await removeOldCaches();
      await tellPages();
    })
    .catch((err) => console.warn('Update check failed; keeping the cached version.', err))
    .finally(() => (checking = undefined));
  return checking;
}

/**
 * @param {string} url
 * @param {Request} request
 */
async function fromShell(url, request) {
  const cacheName = await currentName();
  // CacheStorage.match, unlike caches.open, never recreates a deleted cache.
  const hit = cacheName && (await caches.match(url, { cacheName }));
  return hit || fetch(request);
}

/** @param {FetchEvent} event */
async function forClient(event) {
  const client = event.clientId ? await sw.clients.get(event.clientId) : undefined;
  if (client && !isAppPage(new URL(client.url))) return fetch(event.request);
  return fromShell(event.request.url, event.request);
}

/** Set when installing stored a new shell over an earlier one, so activating can say so. */
let replaced = false;

sw.addEventListener('install', (event) => {
  // If the shell cannot be fetched in full, installing fails and the browser
  // tries again later. A worker never starts without a complete cache.
  event.waitUntil(
    (async () => {
      const hadOld = (await caches.keys()).some((name) => name.startsWith(PREFIX));
      replaced = (await refresh()) && hadOld;
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await removeOldCaches();
      // Only pages this worker now controls are told, so the uncontrolled
      // page that registered it on a first visit is not.
      if (replaced) await tellPages();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    if (!isAppPage(url)) return;
    event.respondWith(fromShell(new URL('index.html', sw.location.href).href, request));
    // Each open of the app looks for a newer version. The worker does this
    // itself rather than waiting to be asked, because a version that fails to
    // start could never ask, and would stay on the phone for good.
    event.waitUntil(new Promise((resolve) => setTimeout(resolve, CHECK_DELAY_MS)).then(check));
    return;
  }
  if (SHELL_URLS.has(url.href)) event.respondWith(forClient(event));
});
