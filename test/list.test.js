// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupItems,
  itemsFromRecipe,
  newItem,
  nextSort,
  normalizeList,
  rankCatalog,
  SORT_STEP,
  touchCatalog,
} from '../src/core/list.js';
import { combineAmount } from '../src/core/units.js';

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

// --- combining amounts -----------------------------------------------------


/** @param {number|null} qty @param {string|null} unit */
const line = (qty, unit) => ({ qty, unit });

test('mixed weights convert to the unit that reads best', () => {
  assert.equal(combineAmount([line(20, 'oz'), line(1, 'lb')]), '2¼ lb');
  assert.equal(combineAmount([line(10, 'oz'), line(1, 'lb')]), '1⅝ lb');
});

test('mixed volumes convert, but never into an ugly larger unit', () => {
  assert.equal(combineAmount([line(1, 'cup'), line(2, 'tbsp')]), '1⅛ cups');
  assert.equal(combineAmount([line(2, 'tbsp'), line(1, 'tsp')]), '2⅓ tbsp');
});

test('a single unit is left alone, even when it could convert', () => {
  assert.equal(combineAmount([line(4, 'tbsp'), line(1, 'tbsp')]), '5 tbsp');
  assert.equal(combineAmount([line(10, 'oz'), line(10, 'oz')]), '20 oz');
});

test('counts sum, and unquantified lines show as "more"', () => {
  assert.equal(combineAmount([line(3, 'clove'), line(2, 'clove')]), '5 cloves');
  assert.equal(combineAmount([line(0.25, 'tsp'), line(null, null)]), '¼ tsp + more');
  assert.equal(combineAmount([line(null, null), line(null, null)]), '');
});

test('units that do not convert are listed side by side', () => {
  assert.equal(combineAmount([line(2, 'pint'), line(4, 'oz')]), '2 pints + 4 oz');
});

// --- rows ------------------------------------------------------------------

test('lines group into rows by key, with sources and a cart at the bottom', () => {
  const a = itemsFromRecipe(recipe, 2, opts);
  const b = itemsFromRecipe({ ...recipe, id: 'r2', title: 'Goulash' }, 2, { ...opts, sort: 1000 });
  const towels = { ...newItem('Paper towels', { ...opts, sort: 2000 }), checked: true };
  const gone = { ...newItem('Mistake', { ...opts, sort: 3000 }), deleted: true };

  const rows = groupItems([...a, ...b, towels, gone]);
  assert.deepEqual(rows.map((r) => r.text), ['ground beef', 'bay leaf', 'salt', 'Paper towels']);
  assert.equal(rows[0]?.amount, '20 oz');
  assert.deepEqual(rows[0]?.sources, ['Meatballs', 'Goulash']);
  assert.equal(rows[3]?.checked, true, 'the cart sorts last');
});

test('a row is only checked when every line behind it is', () => {
  const [beef] = itemsFromRecipe(recipe, 2, opts);
  const [beef2] = itemsFromRecipe({ ...recipe, id: 'r2' }, 2, opts);
  if (!beef || !beef2) throw new Error('fixture');
  assert.equal(groupItems([{ ...beef, checked: true }, beef2])[0]?.checked, false);
});

// --- catalog ---------------------------------------------------------------

test('touching the catalog creates an entry, then bumps it', () => {
  const once = touchCatalog(undefined, { key: 'milk', label: 'Milk' }, 'T1');
  assert.equal(once.items[0]?.useCount, 1);
  const twice = touchCatalog(once, { key: 'milk', label: 'Milk' }, 'T2');
  assert.equal(twice.items.length, 1);
  assert.equal(twice.items[0]?.useCount, 2);
  assert.equal(twice.items[0]?.lastUsedAt, 'T2');
});

test('the catalog ranks pinned first, then by use', () => {
  const entry = (key, useCount, pinned = false) => ({
    key, label: key, defaultUnit: null, useCount, lastUsedAt: null, pinned, deleted: false, updatedAt: 'T',
  });
  const ranked = rankCatalog({
    schemaVersion: 1,
    updatedAt: 'T',
    items: [entry('a', 9), entry('b', 1, true), entry('c', 20), { ...entry('d', 99), deleted: true }],
  });
  assert.deepEqual(ranked.map((c) => c.key), ['b', 'c', 'a']);
});

// --- list import -----------------------------------------------------------

test('list import repairs items and rejects non-lists', () => {
  assert.throws(() => normalizeList({ name: 'x' }), /items array/);
  const { list, warnings } = normalizeList(
    { name: 'Week', items: [{ text: 'Milk', qty: 'lots' }, { qty: 1 }, { text: 'Eggs', checked: true }] },
    opts,
  );
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0]?.qty, null);
  assert.equal(list.items[0]?.key, 'milk');
  assert.ok(list.items[1]?.checkedAt, 'a checked item gets a checkedAt');
  assert.equal(warnings.length, 1);
});
