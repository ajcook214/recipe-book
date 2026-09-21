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

  let id = textOrNull(raw.id);
  if (!id) {
    id = newId();
    warnings.push('no id, assigned a new one');
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
