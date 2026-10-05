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

/**
 * The sort values that put a moved row where it was dropped. `rows` are
 * already in their new order, with the moved one at `index`.
 *
 * Every line behind the moved row takes the same value, because a row sits
 * where its lowest line does. Usually that is the only change: the value
 * halfway to its neighbours, or a step past the end. When the neighbours
 * leave no whole number between them, every row is renumbered instead.
 * Lines already at their value are left out, so nothing is written for them.
 *
 * @param {readonly Row[]} rows
 * @param {number} index
 * @returns {Map<string, number>}  item id -> new sort
 */
export function sortsForMove(rows, index) {
  const moved = rows[index];
  const before = rows[index - 1]?.sort;
  const after = rows[index + 1]?.sort;
  if (!moved || (before === undefined && after === undefined)) return new Map();

  /** @type {number|undefined} undefined when there is no room, and every row is renumbered */
  let sort;
  if (before === undefined) sort = /** @type {number} */ (after) - SORT_STEP;
  else if (after === undefined) sort = before + SORT_STEP;
  else if (after - before >= 2) sort = Math.floor((before + after) / 2);

  /** @type {Map<string, number>} */
  const sorts = new Map();
  rows.forEach((row, i) => {
    if (sort !== undefined && row !== moved) return;
    for (const line of row.lines) {
      const value = sort ?? (i + 1) * SORT_STEP;
      if (line.sort !== value) sorts.set(line.id, value);
    }
  });
  return sorts;
}

// --- catalog ---------------------------------------------------------------

/**
 * Record a use of a catalog entry, so what you actually add drifts to the
 * top. Only an entry that exists counts. Adding something new to a list never
 * creates one, or a typo or a one-off purchase would be remembered for good;
 * entries arrive by import instead, from recipes and from reviewing lists
 * (docs/schema.md). A deleted entry stays deleted.
 *
 * @param {import('./types.js').Catalog} catalog
 * @param {string} key
 * @param {string} now
 * @returns {import('./types.js').Catalog}  the catalog as it was when nothing has that key
 */
export function countUse(catalog, key, now) {
  const i = catalog.items.findIndex((c) => c.key === key && !c.deleted);
  const existing = catalog.items[i];
  if (!existing) return catalog;
  const items = [...catalog.items];
  items[i] = { ...existing, useCount: existing.useCount + 1, lastUsedAt: now, updatedAt: now };
  return { ...catalog, updatedAt: now, items };
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

/**
 * The quick-add buttons: what you usually buy, minus what is already on the
 * list. Only entries pinned or added before. Recipe ingredients and starter
 * items join at no uses, and would otherwise fill the buttons in alphabetical
 * order; they wait among the suggestions until first added.
 *
 * @param {import('./types.js').Catalog|undefined|null} catalog
 * @param {ReadonlySet<string>} onList  keys already on the list
 * @param {number} [limit]
 * @returns {CatalogItem[]}
 */
export function quickAdd(catalog, onList, limit = 10) {
  return rankCatalog(catalog)
    .filter((c) => (c.pinned || c.useCount > 0) && !onList.has(c.key))
    .slice(0, limit);
}

/**
 * The catalog entry a typed name means, if any. A rename changes an entry's
 * label and keeps its key, so it answers to both: "Kitchen roll", renamed
 * from "Paper towels", is found by either name, and the lines already on a
 * list still match it. Labels are checked first. Deleted entries never match.
 *
 * @param {import('./types.js').Catalog|undefined|null} catalog
 * @param {string} name
 * @param {string} [exceptKey]  leave this entry out, to check a rename for a clash
 * @returns {CatalogItem|undefined}
 */
export function findCatalogEntry(catalog, name, exceptKey) {
  const slug = slugify(name);
  if (!slug) return undefined;
  const live = (catalog?.items ?? []).filter((c) => !c.deleted && c.key !== exceptKey);
  return live.find((c) => slugify(c.label) === slug) ?? live.find((c) => c.key === slug);
}

/**
 * Change one catalog entry: rename, default unit, pin, delete. The entry is
 * stamped, so the change wins the per-entry merge. Its key never changes.
 *
 * @param {import('./types.js').Catalog|undefined|null} catalog
 * @param {string} key
 * @param {Partial<Pick<CatalogItem, 'label'|'defaultUnit'|'pinned'|'deleted'>>} changes
 * @param {string} now
 * @returns {import('./types.js').Catalog}
 */
export function editCatalogEntry(catalog, key, changes, now) {
  const items = (catalog?.items ?? []).map((c) => (c.key === key ? { ...c, ...changes, updatedAt: now } : c));
  return { schemaVersion: 1, updatedAt: now, items };
}

// --- common items from recipes ---------------------------------------------

/**
 * The time on a common item that only fills a gap. Older than any real edit,
 * so in the per-entry merge an entry already on another device always wins,
 * renamed, pinned, counted or deleted, and only a missing one is added.
 */
export const NEVER = new Date(0).toISOString();

/**
 * A new common item's label. The recipe's own wording when it names the key
 * exactly, so "Yukon Gold potatoes" keeps its capitals; otherwise the key
 * ("yellow-onion" -> "Yellow onion"), since "large onion" or "kosher salt"
 * would name one recipe's ingredient, not what is bought.
 *
 * @param {string} key
 * @param {string} [item]
 * @returns {string}
 */
export function labelFor(key, item) {
  const words = item && slugify(item) === key ? item.trim() : key.replace(/-+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A common item for every ingredient of these recipes, stamped NEVER, so a
 * merge adds the missing ones and leaves every entry that exists as it is.
 *
 * @param {readonly any[]} recipes
 * @param {ReadonlyMap<string, string>} [labels]  key -> a label already settled, used before labelFor
 * @returns {import('./types.js').Catalog}
 */
export function recipeAdditions(recipes, labels = new Map()) {
  /** @type {Map<string, CatalogItem>} */
  const items = new Map();
  for (const recipe of recipes) {
    for (const ing of recipe.ingredients ?? []) {
      const key = ing?.key;
      if (typeof key !== 'string' || key === '' || items.has(key)) continue;
      items.set(key, {
        key,
        label: labels.get(key) ?? labelFor(key, typeof ing.item === 'string' ? ing.item : undefined),
        defaultUnit: null,
        useCount: 0,
        lastUsedAt: null,
        pinned: false,
        deleted: false,
        updatedAt: NEVER,
      });
    }
  }
  return { schemaVersion: 1, updatedAt: NEVER, items: [...items.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * Every recipe ingredient is a common item, so importing a recipe adds the
 * ones the catalog lacks. An entry with the key stays as it is, deleted ones
 * included, and so does one that answers to the key by a rename, so no two
 * entries answer to one name. The new ones are stamped NEVER: if another
 * device has the key, its copy wins on sync.
 *
 * @param {import('./types.js').Catalog|undefined|null} catalog
 * @param {Recipe} recipe
 * @param {string} now
 * @returns {{ catalog: import('./types.js').Catalog, added: CatalogItem[] }}  nothing added: nothing to save
 */
export function withRecipeItems(catalog, recipe, now) {
  const base = catalog ?? { schemaVersion: 1, updatedAt: now, items: [] };
  const added = recipeAdditions([recipe]).items.filter(
    (c) => !base.items.some((e) => e.key === c.key) && !findCatalogEntry(base, c.key),
  );
  if (added.length === 0) return { catalog: base, added };
  return { catalog: { ...base, updatedAt: now, items: [...base.items, ...added] }, added };
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
