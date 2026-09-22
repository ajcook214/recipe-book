// @ts-check
import { displayUnit, formatQty } from './quantity.js';

/**
 * Combining amounts for one shopping row. Lines that share a key are summed
 * per unit; weights and volumes are converted within their family, but only
 * when a row actually mixes units - "5 tbsp" stays "5 tbsp", it never turns
 * into a surprising "⅓ cup".
 *
 * Pints are deliberately absent: "2 pints cherry tomatoes" is a container,
 * not a fluid volume.
 */

/** Each family in its smallest unit. */
const FAMILIES = /** @type {const} */ ({
  volume: { tsp: 1, tbsp: 3, cup: 48 },
  weight: { oz: 1, lb: 16 },
});

/** Largest first, for choosing how to display a total. */
const ORDER = /** @type {const} */ ({
  volume: ['cup', 'tbsp', 'tsp'],
  weight: ['lb', 'oz'],
});

/** @typedef {keyof typeof FAMILIES} Family */

/**
 * @param {string|null} unit
 * @returns {Family|null}
 */
function familyOf(unit) {
  if (!unit) return null;
  for (const family of /** @type {Family[]} */ (Object.keys(FAMILIES))) {
    if (unit in FAMILIES[family]) return family;
  }
  return null;
}

/**
 * @param {Family} family
 * @param {string} unit
 * @returns {number}
 */
function factor(family, unit) {
  return /** @type {Record<string, number>} */ (FAMILIES[family])[unit] ?? 1;
}

/** A total that reads as a kitchen fraction rather than a decimal. */
/** @param {number} qty */
function isClean(qty) {
  const text = formatQty(qty);
  return text !== '' && !text.includes('.');
}

/**
 * The largest unit in which the total is at least 1 and reads cleanly:
 * 36 oz -> 2¼ lb, but 15 tsp -> 5 tbsp rather than 0.31 cup.
 *
 * @param {Family} family
 * @param {number} base  total in the family's smallest unit
 * @returns {{ qty: number, unit: string }}
 */
function bestUnit(family, base) {
  for (const unit of ORDER[family]) {
    const qty = base / factor(family, unit);
    if (qty >= 1 && isClean(qty)) return { qty, unit };
  }
  const smallest = ORDER[family][ORDER[family].length - 1] ?? 'tsp';
  return { qty: base / factor(family, smallest), unit: smallest };
}

/**
 * Display text for the combined amount of lines sharing a key.
 *
 *   [20 oz, 1 lb]      -> "2¼ lb"
 *   [4 tbsp, 1 tbsp]   -> "5 tbsp"
 *   [¼ tsp, (none)]    -> "¼ tsp + more"
 *   [(none), (none)]   -> ""
 *
 * @param {ReadonlyArray<{ qty: number|null, unit: string|null }>} lines
 * @returns {string}
 */
export function combineAmount(lines) {
  /** @type {Map<string|null, number>} */
  const perUnit = new Map();
  let unquantified = false;

  for (const line of lines) {
    if (line.qty === null || !Number.isFinite(line.qty)) {
      unquantified = true;
      continue;
    }
    perUnit.set(line.unit, (perUnit.get(line.unit) ?? 0) + line.qty);
  }

  // Keep parts in first-seen order; a family occupies the slot of its first unit.
  /** @type {Array<{ qty: number, unit: string|null } | { family: Family }>} */
  const slots = [];
  /** @type {Map<Family, Array<{ qty: number, unit: string }>>} */
  const families = new Map();

  for (const [unit, qty] of perUnit) {
    const family = familyOf(unit);
    if (!family || unit === null) {
      slots.push({ qty, unit });
      continue;
    }
    if (!families.has(family)) {
      families.set(family, []);
      slots.push({ family });
    }
    families.get(family)?.push({ qty, unit });
  }

  const parts = slots.map((slot) => {
    if (!('family' in slot)) return slot;
    const entries = families.get(slot.family) ?? [];
    if (entries.length === 1 && entries[0]) return entries[0];
    const base = entries.reduce((sum, e) => sum + e.qty * factor(slot.family, e.unit), 0);
    return bestUnit(slot.family, base);
  });

  const text = parts.map((p) =>
    [formatQty(p.qty), displayUnit(p.unit, p.qty)].filter(Boolean).join(' '),
  );
  if (unquantified && text.length) text.push('more');
  return text.join(' + ');
}
