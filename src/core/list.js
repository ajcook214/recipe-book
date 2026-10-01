// @ts-check
import { scaledQty } from './quantity.js';
import { isSafeId, slugify } from './recipe.js';
import { combineAmount } from './units.js';

/**
 * Building shopping list items from their three sources: a recipe, the
 * common-items catalog, and free-form text. Every item is stored one line per
 * source; combining same-key lines is a display concern (see docs/schema.md).
 *
 * @typedef {import('./types.js').Recipe} Recipe
 * @typedef {import('./types.js').ListItem} ListItem
 * @typedef {import('./types.js').CatalogItem} CatalogItem
 */

/** Gap between sort values, so an item can be moved by writing one number. */
export const SORT_STEP = 100;

/**
 * @typedef {object} ItemOptions
 * @property {() => string} [newId]
 * @property {() => string} [now]
 * @property {number} [sort]   sort value for the first new item
 */

/** @param {ItemOptions} options */
function defaults(options) {
  return {
    newId: options.newId ?? (() => crypto.randomUUID()),
    now: options.now ?? (() => new Date().toISOString()),
    sort: options.sort ?? SORT_STEP,
  };
}

/**
 * The next free sort slot after everything already on the list.
 *
 * @param {readonly ListItem[]} items
 * @returns {number}
 */
export function nextSort(items) {
  let max = 0;
  for (const item of items) if (typeof item.sort === 'number' && item.sort > max) max = item.sort;
  return max + SORT_STEP;
}

/**
 * One list item per ingredient, scaled to the requested servings and tagged
 * with the recipe it came from, so that recipe's contribution can later be
 * removed exactly.
 *
 * @param {Recipe} recipe
 * @param {number} servings
 * @param {ItemOptions} [options]
 * @returns {ListItem[]}
 */
export function itemsFromRecipe(recipe, servings, options = {}) {
  const { newId, now, sort } = defaults(options);
  const scale = servings / recipe.servings;
  const at = now();

  return recipe.ingredients.map((ing, i) => ({
    id: newId(),
    text: ing.item,
    key: ing.key,
    qty: scaledQty(ing, scale),
    unit: ing.unit,
    checked: false,
    checkedAt: null,
    sort: sort + i * SORT_STEP,
    updatedAt: at,
    deleted: false,
    from: { recipeId: recipe.id, recipeTitle: recipe.title, scale },
  }));
}

/**
 * A hand-added item: tapped from the catalog, or typed free-form. Free-form
 * text still gets a key, which is what lets it combine with matching lines
 * and self-populate the catalog.
 *
 * @param {string} text
 * @param {{ qty?: number|null, unit?: string|null, key?: string } & ItemOptions} [options]
 * @returns {ListItem}
 */
export function newItem(text, options = {}) {
  const { newId, now, sort } = defaults(options);
  return {
    id: newId(),
    text,
    key: options.key ?? (slugify(text) || null),
    qty: options.qty ?? null,
    unit: options.unit ?? null,
    checked: false,
    checkedAt: null,
    sort,
    updatedAt: now(),
    deleted: false,
    from: null,
  };
}

// --- lists and rows --------------------------------------------------------

/**
 * A new list's id, and so its file name: when it was made, to the second, in
 * local time. "2026-09-30-143205" -> lists/2026-09-30-143205.json. Lists are
 * named "Shopping Sep 30" and renamed freely, so the time says more than the
 * name would. One made in the same second as a list already here, deleted or
 * not, gets "-2", "-3".
 *
 * @param {Date} date
 * @param {ReadonlySet<string>} taken  the id of every list here, deleted ones included
 * @returns {string}
 */
export function listIdFor(date, taken) {
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const base = `${day}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * @param {string} name
 * @param {ReadonlySet<string>} taken  the id of every list here, deleted ones included
 * @param {ItemOptions} [options]
 * @returns {import('./types.js').ShoppingList}
 */
export function newList(name, taken, options = {}) {
  const { now } = defaults(options);
  const at = now();
  return {
    id: listIdFor(new Date(at), taken),
    schemaVersion: 1,
    updatedAt: at,
    deleted: false,
    name,
    archived: false,
    items: [],
  };
}

/**
 * @typedef {object} Row
 * @property {string} key        grouping key (item key, or the id when keyless)
 * @property {string} text       display name, from the first line
 * @property {ListItem[]} lines  the stored lines behind this row
 * @property {boolean} checked   true only when every line is checked
 * @property {string} amount     combined amount, e.g. "2¼ lb"
 * @property {string[]} sources  recipe titles that contributed
 * @property {number} sort
 */

/**
 * Combine stored lines into the rows a shopper sees: one per key, amounts
 * summed, tombstones dropped. Rows still to get come first, then the cart.
 *
 * @param {readonly ListItem[]} items
 * @returns {Row[]}
 */
export function groupItems(items) {
  /** @type {Map<string, { key: string, text: string, lines: ListItem[], sort: number }>} */
  const groups = new Map();

  for (const item of items) {
    if (item.deleted) continue;
    const key = item.key ?? `id:${item.id}`;
    const group = groups.get(key);
    if (group) {
      group.lines.push(item);
      group.sort = Math.min(group.sort, item.sort);
    } else {
      groups.set(key, { key, text: item.text, lines: [item], sort: item.sort });
    }
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      checked: g.lines.every((l) => l.checked),
      amount: combineAmount(g.lines),
      sources: [...new Set(g.lines.map((l) => l.from?.recipeTitle).filter((t) => typeof t === 'string'))],
    }))
    .sort((a, b) => Number(a.checked) - Number(b.checked) || a.sort - b.sort);
}

// --- catalog ---------------------------------------------------------------

/**
 * Record a use of a catalog item, creating it when new. This is how the
 * catalog fills itself: whatever you actually add drifts to the top.
 *
 * @param {import('./types.js').Catalog|undefined|null} catalog
 * @param {{ key: string, label: string, defaultUnit?: string|null }} entry
 * @param {string} now
 * @returns {import('./types.js').Catalog}
 */
export function touchCatalog(catalog, entry, now) {
  const items = [...(catalog?.items ?? [])];
  const i = items.findIndex((c) => c.key === entry.key);
  const existing = i >= 0 ? items[i] : undefined;

  const next = existing
    ? { ...existing, useCount: existing.useCount + 1, lastUsedAt: now, deleted: false, updatedAt: now }
    : {
        key: entry.key,
        label: entry.label,
        defaultUnit: entry.defaultUnit ?? null,
        useCount: 1,
        lastUsedAt: now,
        pinned: false,
        deleted: false,
        updatedAt: now,
      };

  if (i >= 0) items[i] = next;
  else items.push(next);
  return { schemaVersion: 1, updatedAt: now, items };
}

/**
 * Catalog entries for the quick-add chips: pinned first, then most used.
 *
 * @param {import('./types.js').Catalog|undefined|null} catalog
 * @returns {CatalogItem[]}
 */
export function rankCatalog(catalog) {
  return (catalog?.items ?? [])
    .filter((c) => !c.deleted)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.useCount - a.useCount ||
        a.label.localeCompare(b.label),
    );
}

// --- import validation -----------------------------------------------------

/** @param {unknown} v @returns {string|null} */
function textOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Validate a shopping list file for import. Same stance as recipes: repair
 * what is safe to repair, report it, reject only what makes no sense.
 *
 * @param {any} raw
 * @param {ItemOptions} [options]
 * @returns {{ list: import('./types.js').ShoppingList, warnings: string[] }}
 */
export function normalizeList(raw, options = {}) {
  const { newId, now } = defaults(options);
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    throw new Error('Expected a shopping list with an items array');
  }

  /** @type {string[]} */
  const warnings = [];
  const at = now();

  let id = textOrNull(raw.id);
  if (id && !isSafeId(id)) {
    warnings.push(`id ${JSON.stringify(id)} cannot be a file name, so it was replaced`);
    id = null;
  }

  /** @type {ListItem[]} */
  const items = [];
  raw.items.forEach((/** @type {any} */ it, /** @type {number} */ i) => {
    const text = textOrNull(it?.text);
    if (!text) {
      warnings.push(`item ${i + 1}: no text, dropped`);
      return;
    }
    const qty = typeof it.qty === 'number' && Number.isFinite(it.qty) && it.qty > 0 ? it.qty : null;
    const from =
      it.from && typeof it.from.recipeId === 'string'
        ? {
            recipeId: it.from.recipeId,
            recipeTitle: textOrNull(it.from.recipeTitle) ?? 'Recipe',
            scale: typeof it.from.scale === 'number' ? it.from.scale : 1,
          }
        : null;
    items.push({
      id: textOrNull(it.id) ?? newId(),
      text,
      key: textOrNull(it.key) ? slugify(it.key) : slugify(text) || null,
      qty,
      unit: textOrNull(it.unit)?.toLowerCase() ?? null,
      checked: it.checked === true,
      checkedAt: it.checked === true ? (textOrNull(it.checkedAt) ?? at) : null,
      sort: typeof it.sort === 'number' ? it.sort : (i + 1) * SORT_STEP,
      updatedAt: textOrNull(it.updatedAt) && !Number.isNaN(Date.parse(it.updatedAt)) ? it.updatedAt : at,
      deleted: it.deleted === true,
      from,
    });
  });

  return {
    list: {
      id: id ?? newId(),
      schemaVersion: 1,
      updatedAt: at,
      deleted: raw.deleted === true,
      name: textOrNull(raw.name) ?? 'Shopping list',
      archived: raw.archived === true,
      items,
    },
    warnings,
  };
}

/**
 * @param {any} raw
 * @param {ItemOptions} [options]
 * @returns {{ catalog: import('./types.js').Catalog, warnings: string[] }}
 */
export function normalizeCatalog(raw, options = {}) {
  const { now } = defaults(options);
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    throw new Error('Expected a catalog with an items array');
  }

  /** @type {string[]} */
  const warnings = [];
  const at = now();
  /** @type {CatalogItem[]} */
  const items = [];

  raw.items.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const label = textOrNull(c?.label) ?? textOrNull(c?.key);
    if (!label) {
      warnings.push(`entry ${i + 1}: no label, dropped`);
      return;
    }
    items.push({
      key: textOrNull(c.key) ? slugify(c.key) : slugify(label),
      label,
      defaultUnit: textOrNull(c.defaultUnit)?.toLowerCase() ?? null,
      useCount: Number.isInteger(c.useCount) && c.useCount >= 0 ? c.useCount : 0,
      lastUsedAt: textOrNull(c.lastUsedAt),
      pinned: c.pinned === true,
      deleted: c.deleted === true,
      updatedAt: textOrNull(c.updatedAt) && !Number.isNaN(Date.parse(c.updatedAt)) ? c.updatedAt : at,
    });
  });

  return { catalog: { schemaVersion: 1, updatedAt: at, items }, warnings };
}
