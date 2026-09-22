// @ts-check
import { scaledQty } from './quantity.js';
import { slugify } from './recipe.js';

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
