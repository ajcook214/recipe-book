// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemsFromRecipe, newItem, nextSort, SORT_STEP } from '../src/core/list.js';

let n = 0;
const opts = { newId: () => `id${++n}`, now: () => '2026-09-21T00:00:00.000Z' };

const recipe = {
  id: 'r1',
  schemaVersion: 1,
  updatedAt: '2026-09-20T00:00:00.000Z',
  deleted: false,
  title: 'Meatballs',
  rating: null,
  tags: [],
  servings: 2,
  prepMinutes: null,
  cookMinutes: null,
  source: null,
  notes: null,
  ingredients: [
    { qty: 10, unit: 'oz', item: 'ground beef', key: 'ground-beef', note: null, scalable: true },
    { qty: 1, unit: null, item: 'bay leaf', key: 'bay-leaf', note: null, scalable: false },
    { qty: null, unit: null, item: 'salt', key: 'salt', note: 'to taste', scalable: false },
  ],
  steps: [],
};

test('recipe items are scaled and remember where they came from', () => {
  const items = itemsFromRecipe(recipe, 4, opts);
  assert.equal(items.length, 3);
  assert.equal(items[0]?.qty, 20, 'doubled');
  assert.equal(items[1]?.qty, 1, 'unscalable stays put');
  assert.equal(items[2]?.qty, null, 'unquantified stays unquantified');
  assert.deepEqual(items[0]?.from, { recipeId: 'r1', recipeTitle: 'Meatballs', scale: 2 });
  assert.equal(items[0]?.key, 'ground-beef');
});

test('recipe items take consecutive sort slots from a starting point', () => {
  const items = itemsFromRecipe(recipe, 2, { ...opts, sort: 500 });
  assert.deepEqual(items.map((i) => i.sort), [500, 600, 700]);
});

test('a free-form item still gets a key, but no provenance', () => {
  const item = newItem('Paper Towels', opts);
  assert.equal(item.key, 'paper-towels');
  assert.equal(item.from, null);
  assert.equal(item.checked, false);
});

test('nextSort lands after the last item', () => {
  assert.equal(nextSort([]), SORT_STEP);
  const items = itemsFromRecipe(recipe, 2, { ...opts, sort: 100 });
  assert.equal(nextSort(items), 400);
});
