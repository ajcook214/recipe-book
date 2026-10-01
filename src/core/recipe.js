// @ts-check

/**
 * Import validation. This is where outside data - LLM-produced JSON, hand
 * edits - enters the working copy, so it is strict about shape and forgiving
 * about detail: it fixes what it safely can, reports what it changed, and
 * rejects only what it cannot make sense of.
 *
 * @typedef {import('./types.js').Recipe} Recipe
 * @typedef {import('./types.js').Ingredient} Ingredient
 */

/**
 * "Ground Beef" -> "ground-beef". The shared key between recipe ingredients,
 * shopping list items and catalog entries.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Longest a recipe id is made, so its file name stays readable. */
const ID_MAX = 60;

/**
 * A new recipe's id, and so its file name: the title as a slug.
 * "Tomato Soup" -> "tomato-soup" -> recipes/tomato-soup.json.
 *
 * Fixed once the recipe exists. Renaming a recipe later keeps its file, so
 * the lines on shopping lists that point at it keep working, and the file
 * name, a little out of date, is still recognisable. Cut at a word break past
 * ID_MAX characters. Empty when the title has nothing a slug can keep.
 *
 * @param {string} title
 * @returns {string}
 */
export function recipeIdFor(title) {
  const slug = slugify(title);
  if (slug.length <= ID_MAX) return slug;
  const cut = slug.slice(0, ID_MAX + 1).lastIndexOf('-');
  return slug.slice(0, cut > 0 ? cut : ID_MAX).replace(/-+$/, '');
}

/**
 * Whether an id can be used as a file name as it stands. Ids from a file are
 * kept, so a backup imports back onto the records it came from, but one
 * with a slash in it would land in another folder.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isSafeId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id);
}

/**
 * The URL in a source like "Serious Eats - https://...", else the text itself.
 *
 * @param {string|null} source
 * @returns {string|null}
 */
function sourceKey(source) {
  return source?.match(/https?:\/\/\S+/)?.[0] ?? source?.trim() ?? null;
}

/**
 * Where an imported recipe lands among the ones already here.
 *
 * - `new`: nothing here has its id or its name.
 * - `update`: the recipe at its id came from the same source, so this is the
 *   same recipe imported again.
 * - `clash`: a recipe here has its id or its name, and is not known to be the
 *   same one. The user chooses to cancel, replace it, or keep both.
 *
 * Names compare as slugs, so "Tomato Soup" and "tomato soup!" clash. Deleted
 * recipes hold neither their id nor their name.
 *
 * @param {Recipe} incoming
 * @param {readonly Recipe[]} existing
 * @returns {{ kind: 'new' } | { kind: 'update' | 'clash', existing: Recipe }}
 */
export function placeRecipe(incoming, existing) {
  const live = existing.filter((r) => !r.deleted);
  const atId = live.find((r) => r.id === incoming.id);
  if (atId) {
    const source = sourceKey(incoming.source);
    return { kind: source !== null && source === sourceKey(atId.source) ? 'update' : 'clash', existing: atId };
  }
  const name = slugify(incoming.title);
  const named = live.find((r) => slugify(r.title) === name);
  return named ? { kind: 'clash', existing: named } : { kind: 'new' };
}

/**
 * An imported recipe renamed to sit beside one it clashed with: "Tomato
 * Soup 2", or the next number free. The number goes on the id as well as the
 * title, after any cut, so a long title cannot lose it.
 *
 * @param {Recipe} incoming
 * @param {readonly Recipe[]} existing
 * @returns {Recipe}
 */
export function keepBoth(incoming, existing) {
  const live = existing.filter((r) => !r.deleted);
  const ids = new Set(live.map((r) => r.id));
  const names = new Set(live.map((r) => slugify(r.title)));
  const base = recipeIdFor(incoming.title) || 'recipe';
  for (let n = 2; ; n += 1) {
    const title = `${incoming.title} ${n}`;
    const id = `${base}-${n}`;
    if (!ids.has(id) && !names.has(slugify(title))) return { ...incoming, id, title };
  }
}

/** @param {unknown} v @returns {string|null} */
function textOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** @param {unknown} v @returns {number|null} */
function nonNegativeOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * @param {any} raw
 * @param {number} index
 * @param {string[]} warnings
 * @returns {Ingredient|null}
 */
function normalizeIngredient(raw, index, warnings) {
  const where = `ingredient ${index + 1}`;
  if (raw === null || typeof raw !== 'object') {
    warnings.push(`${where}: not an object, dropped`);
    return null;
  }

  const item = textOrNull(raw.item);
  if (!item) {
    warnings.push(`${where}: no item name, dropped`);
    return null;
  }

  let qty = null;
  if (typeof raw.qty === 'number' && Number.isFinite(raw.qty) && raw.qty > 0) {
    qty = raw.qty;
  } else if (raw.qty !== null && raw.qty !== undefined) {
    warnings.push(`${where} (${item}): quantity ${JSON.stringify(raw.qty)} is not a positive number, cleared`);
  }

  const unit = textOrNull(raw.unit)?.toLowerCase() ?? null;
  const key = textOrNull(raw.key) ? slugify(raw.key) : slugify(item);

  return {
    qty,
    unit,
    item,
    key,
    note: textOrNull(raw.note),
    // An unquantified ingredient has nothing to scale, whatever the file says.
    scalable: qty === null ? false : raw.scalable !== false,
  };
}

/**
 * Validate and normalize a recipe for import.
 *
 * @param {any} raw
 * @param {{ now?: () => string, newId?: () => string }} [options]
 * @returns {{ recipe: Recipe, warnings: string[] }}
 * @throws {Error} when the input is not recognisably a recipe
 */
export function normalizeRecipe(raw, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => crypto.randomUUID());

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected a recipe object');
  }

  const title = textOrNull(raw.title);
  if (!title) throw new Error('Recipe has no title');
  if (!Array.isArray(raw.ingredients)) throw new Error(`"${title}" has no ingredients list`);

  /** @type {string[]} */
  const warnings = [];

  // A file's own id is kept, so a re-import or a backup lands on the record
  // it came from. Without one, the id comes from the title.
  let id = textOrNull(raw.id);
  if (id && !isSafeId(id)) {
    warnings.push(`id ${JSON.stringify(id)} cannot be a file name, so it was replaced`);
    id = null;
  }
  if (!id) {
    id = recipeIdFor(title);
    if (!id) {
      id = newId();
      warnings.push('the title has nothing a file name can use, so the id is random');
    }
  }

  let updatedAt = textOrNull(raw.updatedAt);
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) updatedAt = now();

  let rating = null;
  if (raw.rating !== null && raw.rating !== undefined) {
    if (Number.isInteger(raw.rating) && raw.rating >= 1 && raw.rating <= 10) rating = raw.rating;
    else warnings.push(`rating ${JSON.stringify(raw.rating)} is not 1-10, cleared`);
  }

  let servings = 1;
  if (typeof raw.servings === 'number' && Number.isFinite(raw.servings) && raw.servings > 0) {
    servings = raw.servings;
  } else {
    warnings.push('no usable servings count, assumed 1 - scaling will be off until it is set');
  }

  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map(textOrNull).filter(Boolean).map((/** @type {string} */ t) => t.toLowerCase()))]
    : [];

  const ingredients = /** @type {any[]} */ (raw.ingredients)
    .map((ing, i) => normalizeIngredient(ing, i, warnings))
    .filter((ing) => ing !== null);

  const steps = Array.isArray(raw.steps)
    ? raw.steps.map(textOrNull).filter((/** @type {string|null} */ s) => s !== null)
    : [];

  return {
    recipe: {
      id,
      schemaVersion: 1,
      updatedAt,
      deleted: raw.deleted === true,
      title,
      rating,
      tags,
      servings,
      prepMinutes: nonNegativeOrNull(raw.prepMinutes),
      cookMinutes: nonNegativeOrNull(raw.cookMinutes),
      source: textOrNull(raw.source),
      notes: textOrNull(raw.notes),
      ingredients,
      steps,
    },
    warnings,
  };
}
