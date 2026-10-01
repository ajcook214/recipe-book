// @ts-check

/**
 * Display and scaling of ingredient amounts. Quantities are stored as
 * decimals; this is the one place that turns them into kitchen fractions.
 *
 * @typedef {import('./types.js').Ingredient} Ingredient
 */

/**
 * Fractions a cook actually measures, nearest-match targets for snapping.
 * @type {ReadonlyArray<{ value: number, glyph: string }>}
 */
const FRACTIONS = [
  { value: 0, glyph: '' },
  { value: 1 / 8, glyph: '⅛' },
  { value: 1 / 4, glyph: '¼' },
  { value: 1 / 3, glyph: '⅓' },
  { value: 3 / 8, glyph: '⅜' },
  { value: 1 / 2, glyph: '½' },
  { value: 5 / 8, glyph: '⅝' },
  { value: 2 / 3, glyph: '⅔' },
  { value: 3 / 4, glyph: '¾' },
  { value: 7 / 8, glyph: '⅞' },
  { value: 1, glyph: '' },
];

/** How far off a fraction may be and still snap. Tighter than the ⅛/⅓ gap. */
const TOLERANCE = 0.03;

/**
 * 1.5 -> "1½", 0.333 -> "⅓", 3 -> "3". Values that do not sit near a kitchen
 * fraction fall back to a short decimal rather than a misleading fraction.
 *
 * @param {number} qty
 * @returns {string}
 */
export function formatQty(qty) {
  if (!Number.isFinite(qty) || qty <= 0) return '';

  // Big amounts are not measured in eighths.
  if (qty >= 20) return String(Math.round(qty));

  const whole = Math.floor(qty);
  const frac = qty - whole;

  let best = { value: 0, glyph: '' };
  for (const candidate of FRACTIONS) {
    if (Math.abs(frac - candidate.value) < Math.abs(frac - best.value)) best = candidate;
  }

  if (Math.abs(frac - best.value) > TOLERANCE) {
    return String(Math.round(qty * 100) / 100);
  }
  if (best.value === 1) return String(whole + 1);
  if (best.value === 0) return String(whole);
  return whole === 0 ? best.glyph : `${whole}${best.glyph}`;
}

/** Glyph -> value, for reading back an amount formatQty wrote. */
const GLYPHS = new Map(FRACTIONS.filter((f) => f.glyph).map((f) => [f.glyph, f.value]));

/**
 * An amount as a person types it, as the decimal that is stored: "2", "1.5",
 * "1,5", "3/4", "1 1/2", "1½". Blank is null, meaning no amount. Anything
 * else, zero included, is undefined, so the caller can say so rather than
 * guess.
 *
 * @param {string} text
 * @returns {number|null|undefined}
 */
export function parseQty(text) {
  // A decimal comma, but not a thousands one: "1,5" is 1.5, "1,000" is refused.
  const s = text.trim().replace(/^(\d*),(\d{1,2})$/, '$1.$2');
  if (s === '') return null;

  let qty;
  const glyph = s.match(/^(\d*)\s*(\S)$/);
  const fraction = s.match(/^(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/);
  if (glyph?.[2] && GLYPHS.has(glyph[2])) {
    qty = Number(glyph[1] || 0) + (GLYPHS.get(glyph[2]) ?? 0);
  } else if (fraction) {
    qty = Number(fraction[1] ?? 0) + Number(fraction[2]) / Number(fraction[3]);
  } else if (/^(\d+\.?\d*|\.\d+)$/.test(s)) {
    qty = Number(s);
  }
  return qty !== undefined && Number.isFinite(qty) && qty > 0 ? qty : undefined;
}

/** Units that take a plural. Abbreviations (tsp, oz, lb, g) never do. */
const PLURALS = {
  cup: 'cups',
  stalk: 'stalks',
  clove: 'cloves',
  can: 'cans',
  slice: 'slices',
  pinch: 'pinches',
  bunch: 'bunches',
  sprig: 'sprigs',
  head: 'heads',
  package: 'packages',
  jar: 'jars',
  stick: 'sticks',
  quart: 'quarts',
  pint: 'pints',
  piece: 'pieces',
  gallon: 'gallons',
  loaf: 'loaves',
  bag: 'bags',
  box: 'boxes',
  bottle: 'bottles',
};

/** Suggested wherever a unit is typed. Anything else can still be typed. */
export const COMMON_UNITS = [
  'tsp', 'tbsp', 'cup', 'oz', 'lb', 'g', 'kg', 'ml', 'l',
  'can', 'jar', 'bag', 'box', 'bottle', 'package', 'bunch', 'head', 'clove',
  'loaf', 'stick', 'slice', 'piece', 'dozen', 'pint', 'quart', 'gallon',
];

/** Spelled out or plural, to the form the app stores. */
const UNIT_ALIASES = new Map([
  ...Object.entries(PLURALS).map(([one, many]) => /** @type {[string, string]} */ ([many, one])),
  ['teaspoon', 'tsp'], ['teaspoons', 'tsp'], ['tsps', 'tsp'],
  ['tablespoon', 'tbsp'], ['tablespoons', 'tbsp'], ['tbsps', 'tbsp'], ['tbs', 'tbsp'],
  ['ounce', 'oz'], ['ounces', 'oz'],
  ['pound', 'lb'], ['pounds', 'lb'], ['lbs', 'lb'],
  ['gram', 'g'], ['grams', 'g'],
]);

/**
 * A unit as typed, in the form stored: lowercase, singular, abbreviated
 * where the app abbreviates. "Cups" -> "cup", "lbs." -> "lb". That matters
 * beyond looks: only stored forms combine on a list, 1 lb with 8 oz. Blank is
 * null, for a bare count.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function normalizeUnit(text) {
  const unit = text.trim().toLowerCase().replace(/\.$/, '');
  if (!unit) return null;
  return UNIT_ALIASES.get(unit) ?? unit;
}

/**
 * @param {string|null} unit
 * @param {number|null} qty
 * @returns {string}
 */
export function displayUnit(unit, qty) {
  if (!unit) return '';
  if (qty !== null && qty > 1 && unit in PLURALS) {
    return PLURALS[/** @type {keyof typeof PLURALS} */ (unit)];
  }
  return unit;
}

/**
 * The quantity to show for an ingredient at a given scale factor.
 *
 * @param {Ingredient} ingredient
 * @param {number} factor  target servings / base servings
 * @returns {number|null}
 */
export function scaledQty(ingredient, factor) {
  if (ingredient.qty === null) return null;
  return ingredient.scalable ? ingredient.qty * factor : ingredient.qty;
}

/**
 * "1½ cups" for an ingredient at a scale factor, or "" when unquantified.
 *
 * @param {Ingredient} ingredient
 * @param {number} [factor]
 * @returns {string}
 */
export function formatAmount(ingredient, factor = 1) {
  const qty = scaledQty(ingredient, factor);
  if (qty === null) return '';
  return [formatQty(qty), displayUnit(ingredient.unit, qty)].filter(Boolean).join(' ');
}
