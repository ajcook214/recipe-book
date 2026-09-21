// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRecipe, slugify } from '../src/core/recipe.js';
import { displayUnit, formatAmount, formatQty } from '../src/core/quantity.js';

const fixed = { now: () => '2026-09-21T00:00:00.000Z', newId: () => 'new-id' };

/** @param {Partial<any>} [over] */
function raw(over = {}) {
  return {
    id: 'r1',
    updatedAt: '2026-09-20T10:00:00.000Z',
    title: 'Corn Chowder',
    rating: null,
    tags: ['Soup'],
    servings: 8,
    ingredients: [{ qty: 1.5, unit: 'Cup', item: 'milk', note: null, scalable: true }],
    steps: ['Stir.'],
    ...over,
  };
}

// --- import validation -----------------------------------------------------

test('a well-formed recipe imports without warnings', () => {
  const { recipe, warnings } = normalizeRecipe(raw(), fixed);
  assert.deepEqual(warnings, []);
  assert.equal(recipe.id, 'r1');
  assert.equal(recipe.updatedAt, '2026-09-20T10:00:00.000Z', 'an existing timestamp is kept');
  assert.equal(recipe.schemaVersion, 1);
  assert.equal(recipe.deleted, false);
});

test('things that are not recipes are rejected outright', () => {
  assert.throws(() => normalizeRecipe(null), /recipe object/);
  assert.throws(() => normalizeRecipe([raw()]), /recipe object/);
  assert.throws(() => normalizeRecipe(raw({ title: '  ' })), /no title/);
  assert.throws(() => normalizeRecipe(raw({ ingredients: undefined })), /no ingredients/);
});

test('a missing id is assigned, with a warning', () => {
  const { recipe, warnings } = normalizeRecipe(raw({ id: undefined }), fixed);
  assert.equal(recipe.id, 'new-id');
  assert.equal(warnings.length, 1);
});

test('an out-of-range rating is cleared, not clamped', () => {
  const { recipe, warnings } = normalizeRecipe(raw({ rating: 11 }), fixed);
  assert.equal(recipe.rating, null);
  assert.match(warnings[0] ?? '', /rating/);
});

test('tags and units are normalized; keys are derived when missing', () => {
  const { recipe } = normalizeRecipe(raw({ tags: ['Soup', 'soup', ' Dinner '] }), fixed);
  assert.deepEqual(recipe.tags, ['soup', 'dinner']);
  assert.equal(recipe.ingredients[0]?.unit, 'cup');
  assert.equal(recipe.ingredients[0]?.key, 'milk');
});

test('bad ingredients are repaired or dropped, never imported broken', () => {
  const { recipe, warnings } = normalizeRecipe(
    raw({
      ingredients: [
        { qty: 2, unit: 'tsp', item: 'salt' },
        { qty: 'two', unit: 'cup', item: 'flour' },
        { qty: 1, unit: 'cup' },
        'not an object',
      ],
    }),
    fixed,
  );
  assert.equal(recipe.ingredients.length, 2);
  assert.equal(recipe.ingredients[1]?.qty, null, 'an unparseable qty is cleared');
  assert.equal(recipe.ingredients[1]?.scalable, false, 'and nothing unquantified scales');
  assert.equal(warnings.length, 3);
});

test('slugify makes stable shared keys', () => {
  assert.equal(slugify('Yukon Gold Potatoes'), 'yukon-gold-potatoes');
  assert.equal(slugify('  Jalapeño (fresh) '), 'jalapeno-fresh');
});

// --- quantities ------------------------------------------------------------

test('decimals render as kitchen fractions', () => {
  assert.equal(formatQty(1.5), '1½');
  assert.equal(formatQty(0.25), '¼');
  assert.equal(formatQty(1 / 3), '⅓');
  assert.equal(formatQty(2), '2');
  assert.equal(formatQty(2.9999999), '3');
});

test('scaled thirds come back whole', () => {
  assert.equal(formatQty((1 / 3) * 3), '1');
  assert.equal(formatQty((2 / 3) * 1.5), '1');
});

test('amounts that are not near a fraction show as short decimals', () => {
  assert.equal(formatQty(0.07), '0.07');
  assert.equal(formatQty(1.42), '1.42');
});

test('units pluralize only where English does', () => {
  assert.equal(displayUnit('cup', 2), 'cups');
  assert.equal(displayUnit('cup', 1), 'cup');
  assert.equal(displayUnit('tsp', 3), 'tsp');
});

test('formatAmount scales scalable ingredients only', () => {
  const beef = { qty: 1.5, unit: 'lb', item: 'beef', key: 'beef', note: null, scalable: true };
  const leaf = { qty: 1, unit: null, item: 'bay leaf', key: 'bay-leaf', note: null, scalable: false };
  assert.equal(formatAmount(beef, 2), '3 lb');
  assert.equal(formatAmount(leaf, 2), '1');
  assert.equal(formatAmount({ ...beef, qty: null }, 2), '');
});
