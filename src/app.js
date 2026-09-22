// @ts-check
import { openDatabase } from './core/db.js';
import { h } from './ui/dom.js';
import * as recipesView from './ui/views/recipes.js';
import * as recipeView from './ui/views/recipe.js';
import * as importView from './ui/views/import.js';
import * as listsView from './ui/views/lists.js';
import * as listView from './ui/views/list.js';

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
  [/^#\/import$/, importView.render, 'import'],
];

const main = /** @type {HTMLElement} */ (document.querySelector('main'));
const toast = /** @type {HTMLElement} */ (document.querySelector('#toast'));

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

async function start() {
  try {
    db = await openDatabase();
  } catch (err) {
    main.replaceChildren(
      h('section', { class: 'empty' }, h('h1', null, 'Storage unavailable'), h('p', null, String(err))),
    );
    return;
  }
  window.addEventListener('hashchange', route);
  await route();
}

void start();
