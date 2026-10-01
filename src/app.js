// @ts-check
import { changes, countDirty, openDatabase } from './core/db.js';
import { h } from './ui/dom.js';
import * as recipesView from './ui/views/recipes.js';
import * as recipeView from './ui/views/recipe.js';
import * as importView from './ui/views/import.js';
import * as listsView from './ui/views/lists.js';
import * as listView from './ui/views/list.js';
import * as catalogView from './ui/views/catalog.js';
import * as syncView from './ui/views/sync.js';

/**
 * App shell: opens the working copy and routes hash URLs to views.
 * Hash routing keeps every URL servable as a static file on Pages.
 */

/** @type {Array<[RegExp, (ctx: any, params: string[]) => Promise<HTMLElement>, string]>} */
const ROUTES = [
  [/^#?\/?$/, recipesView.render, 'recipes'],
  [/^#\/recipe\/([^/]+)$/, recipeView.render, 'recipes'],
  [/^#\/lists$/, listsView.render, 'lists'],
  [/^#\/list\/([^/]+)$/, listView.render, 'lists'],
  [/^#\/catalog$/, catalogView.render, 'lists'],
  [/^#\/import$/, importView.render, 'import'],
  [/^#\/sync$/, syncView.render, 'sync'],
];

const main = /** @type {HTMLElement} */ (document.querySelector('main'));
const toast = /** @type {HTMLElement} */ (document.querySelector('#toast'));
const syncLink = /** @type {HTMLElement} */ (document.querySelector('nav a[data-section="sync"]'));
const pendingBadge = /** @type {HTMLElement} */ (document.querySelector('#pending'));

/** @type {ReturnType<typeof setTimeout>|undefined} */
let toastTimer;

/** @param {string} message */
function flash(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2200);
}

/** @param {string} hash */
function navigate(hash) {
  if (location.hash === hash) void route();
  else location.hash = hash;
}

/** @type {IDBDatabase} */
let db;

async function route() {
  const hash = location.hash || '#/';
  const match = ROUTES.map(([re, view, section]) => ({ m: hash.match(re), view, section })).find(
    (r) => r.m,
  );

  for (const link of document.querySelectorAll('nav a')) {
    link.toggleAttribute('aria-current', link.getAttribute('data-section') === match?.section);
  }

  try {
    const view = match
      ? await match.view({ db, navigate, flash }, match.m?.slice(1) ?? [])
      : h('section', { class: 'empty' }, h('h1', null, 'Not found'), h('a', { class: 'button', href: '#/' }, 'Recipes'));
    main.replaceChildren(view);
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    main.replaceChildren(
      h('section', { class: 'empty' }, h('h1', null, 'Something went wrong'), h('pre', null, String(err))),
    );
  }
}

let counting = false;

/**
 * The pending-change count on the Sync link, so it is in sight on every
 * screen, shopping included. Recounted at most every 100 ms, since a sync
 * writes many records in a row. A timer rather than a frame callback, which
 * stops while the page is hidden, as it is behind Google's sign-in window.
 */
function showPending() {
  if (counting) return;
  counting = true;
  setTimeout(async () => {
    counting = false;
    try {
      const n = await countDirty(db);
      pendingBadge.textContent = String(n);
      pendingBadge.hidden = n === 0;
      syncLink.setAttribute('aria-label', n ? `Sync, ${n} change${n === 1 ? '' : 's'} waiting` : 'Sync');
    } catch (err) {
      console.warn('Could not count pending changes.', err);
    }
  }, 100);
}

async function start() {
  try {
    db = await openDatabase();
  } catch (err) {
    main.replaceChildren(
      h('section', { class: 'empty' }, h('h1', null, 'Storage unavailable'), h('p', null, String(err))),
    );
    return;
  }
  changes.addEventListener('change', showPending);
  showPending();
  window.addEventListener('hashchange', route);
  await route();
}

/** The new version is already cached; the next open uses it either way. */
function offerReload() {
  if (document.querySelector('.update-ready')) return;
  document.querySelector('.topbar')?.after(
    h(
      'div',
      { class: 'update-ready', role: 'status' },
      h('span', null, 'A new version is ready.'),
      h('button', { type: 'button', onclick: () => location.reload() }, 'Reload'),
    ),
  );
}

/**
 * Registers the service worker (sw.js) that lets the app open with no signal.
 *
 * On localhost it is opt-in with `?sw`, because a cache-first worker shows
 * each edit one reload late. Without `?sw`, a worker left over from an earlier
 * `?sw` visit is removed, along with its cache.
 */
async function setUpOffline() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local && !new URLSearchParams(location.search).has('sw')) {
    const scope = new URL('./', location.href).href;
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      if (registration.scope === scope) await registration.unregister();
    }
    for (const name of await caches.keys()) {
      if (name.startsWith('recipe-book-shell-')) await caches.delete(name);
    }
    return;
  }

  // The worker looks for a newer version by itself each time the app opens.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data === 'updated') offerReload();
  });
  // addEventListener, unlike onmessage, does not start delivery by itself.
  navigator.serviceWorker.startMessages();
  await navigator.serviceWorker.register('sw.js');
}

void start();
setUpOffline().catch((err) => console.warn('Offline support is unavailable.', err));
