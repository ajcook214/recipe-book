// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countUse,
  editCatalogEntry,
  findCatalogEntry,
  groupItems,
  isOnHand,
  itemsFromRecipe,
  labelFor,
  listIdFor,
  NEVER,
  newItem,
  newList,
  nextSort,
  normalizeCatalog,
  normalizeList,
  quickAdd,
  rankCatalog,
  recipeAdditions,
  SORT_STEP,
  sortsForMove,
  withRecipeItems,
} from '../src/core/list.js';
import { mergeCatalog } from '../src/core/merge.js';
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

/** @param {string} key @param {number} useCount @param {boolean} [pinned] @param {string} [label] */
const entry = (key, useCount, pinned = false, label = key) => ({
  key, label, defaultUnit: null, useCount, lastUsedAt: null, pinned, deleted: false, updatedAt: 'T',
});
/** @param {any[]} items */
const catalogOf = (items) => ({ schemaVersion: 1, updatedAt: 'T', items });

test('the catalog ranks pinned first, then by use', () => {
  const ranked = rankCatalog(catalogOf([entry('a', 9), entry('b', 1, true), entry('c', 20), { ...entry('d', 99), deleted: true }]));
  assert.deepEqual(ranked.map((c) => c.key), ['b', 'c', 'a']);
});

test('quick-add offers pinned and used entries, never ones only waiting in the suggestions', () => {
  const catalog = catalogOf([entry('apples', 0), entry('milk', 2), entry('eggs', 0, true), entry('bread', 5)]);
  assert.deepEqual(quickAdd(catalog, new Set(['bread'])).map((c) => c.key), ['eggs', 'milk']);
});

test('a use of a common item counts, and stamps it so the count wins a merge', () => {
  const once = countUse(catalogOf([entry('milk', 3, true, 'Milk')]), 'milk', 'T2');
  assert.deepEqual(once.items[0], {
    key: 'milk', label: 'Milk', defaultUnit: null, useCount: 4, lastUsedAt: 'T2', pinned: true, deleted: false, updatedAt: 'T2',
  });
});

test('adding something that is not a common item never creates one', () => {
  const catalog = catalogOf([entry('milk', 3)]);
  assert.equal(countUse(catalog, 'bananna', 'T2'), catalog, 'unchanged, so nothing is saved');
});

test('a deleted common item stays deleted when its name is added to a list', () => {
  const catalog = catalogOf([{ ...entry('milk', 14), deleted: true }]);
  assert.equal(countUse(catalog, 'milk', 'T2'), catalog);
});

test('a renamed catalog entry answers to its new name and its old key', () => {
  const towels = entry('paper-towels', 3, false, 'Kitchen roll');
  const catalog = catalogOf([towels, entry('milk', 9, false, 'Milk'), { ...entry('eggs', 2, false, 'Eggs'), deleted: true }]);
  assert.equal(findCatalogEntry(catalog, 'kitchen roll'), towels);
  assert.equal(findCatalogEntry(catalog, 'Paper Towels'), towels);
  assert.equal(findCatalogEntry(catalog, 'MILK!')?.key, 'milk');
  assert.equal(findCatalogEntry(catalog, 'eggs'), undefined, 'deleted entries never match');
  assert.equal(findCatalogEntry(catalog, '!!!'), undefined);
});

test('a rename is checked against every entry but its own', () => {
  const catalog = catalogOf([entry('mlik', 1, false, 'Mlik'), entry('milk', 9, false, 'Milk')]);
  assert.equal(findCatalogEntry(catalog, 'Milk', 'mlik')?.key, 'milk', 'the typo cannot take a name in use');
  assert.equal(findCatalogEntry(catalog, 'MILK', 'milk'), undefined, 'an entry can change its own case');
});

test('editing a catalog entry stamps it and keeps its key', () => {
  const catalog = catalogOf([entry('paper-towels', 3, false, 'Paper towels'), entry('milk', 9)]);
  const next = editCatalogEntry(catalog, 'paper-towels', { label: 'Kitchen roll', pinned: true }, 'T2');
  assert.deepEqual(next.items[0], { ...entry('paper-towels', 3, true, 'Kitchen roll'), updatedAt: 'T2' });
  assert.equal(next.items[1], catalog.items[1], 'the others are untouched, so they lose no merge');
  assert.equal(next.updatedAt, 'T2');
});

test('an ingredient is on hand only when its live common item says so', () => {
  const catalog = catalogOf([
    { ...entry('salt', 0), onHand: true },
    { ...entry('water', 0, false, 'Tap water'), onHand: true },
    entry('milk', 4),
    { ...entry('black-pepper', 0), onHand: true, deleted: true },
  ]);
  assert.equal(isOnHand(catalog, 'salt'), true);
  assert.equal(isOnHand(catalog, 'water'), true, 'a renamed entry still answers to its key');
  assert.equal(isOnHand(catalog, 'milk'), false, 'an entry from before onHand existed is bought');
  assert.equal(isOnHand(catalog, 'black-pepper'), false, 'a deleted entry is forgotten');
  assert.equal(isOnHand(catalog, 'saffron'), false, 'no entry: bought like anything else');
  assert.equal(isOnHand(undefined, 'salt'), false, 'no catalog yet');
});

test('importing common items keeps which are on hand', () => {
  const { catalog } = normalizeCatalog(catalogOf([{ ...entry('salt', 0), onHand: true }, entry('milk', 2)]));
  assert.deepEqual(catalog.items.map((c) => [c.key, c.onHand]), [['salt', true], ['milk', false]]);
});

// --- common items from recipes ---------------------------------------------

/** @param {Array<[string, string]>} pairs  [item, key] */
const recipeWith = (pairs) => ({
  ...recipe,
  ingredients: pairs.map(([item, key]) => ({ qty: 1, unit: null, item, key, note: null, scalable: true })),
});

test('importing a recipe adds its missing ingredients as common items that only fill a gap', () => {
  const catalog = catalogOf([entry('salt', 7, false, 'Salt')]);
  const { catalog: next, added } = withRecipeItems(
    catalog,
    recipeWith([['large onion', 'onion'], ['kosher salt', 'salt'], ['Yukon Gold potatoes', 'yukon-gold-potatoes'], ['onion', 'onion']]),
    'T2',
  );
  assert.deepEqual(
    added.map((c) => [c.key, c.label, c.useCount, c.pinned, c.updatedAt]),
    [
      ['onion', 'Onion', 0, false, NEVER],
      ['yukon-gold-potatoes', 'Yukon Gold potatoes', 0, false, NEVER],
    ],
    'labelled from the item only when it names the key, so "large onion" is not a common item',
  );
  assert.equal(next.items[0], catalog.items[0], 'salt as it was');
  assert.equal(next.items.length, 3);
  assert.equal(next.updatedAt, 'T2', 'the catalog is saved, to push');
});

test('importing a recipe never changes a common item that exists, renamed, pinned or deleted', () => {
  const towels = entry('paper-towels', 3, true, 'Kitchen roll');
  const salt = { ...entry('salt', 9, false, 'Salt'), deleted: true };
  const scallions = entry('scallions', 2, false, 'Green onions');
  const catalog = catalogOf([towels, salt, scallions]);
  const { catalog: next, added } = withRecipeItems(
    catalog,
    recipeWith([['paper towels', 'paper-towels'], ['salt', 'salt'], ['green onions', 'green-onions'], ['milk', 'milk']]),
    'T2',
  );
  assert.deepEqual(added.map((c) => c.key), ['milk'], 'green-onions would answer to the same name as the renamed scallions');
  assert.deepEqual(next.items.slice(0, 3), [towels, salt, scallions]);
});

test('a recipe with nothing new to add changes nothing, so nothing is saved', () => {
  const catalog = catalogOf([entry('milk', 1)]);
  const out = withRecipeItems(catalog, recipeWith([['milk', 'milk']]), 'T2');
  assert.deepEqual(out.added, []);
  assert.equal(out.catalog, catalog);
});

test("a common item a recipe added loses to another device's copy on sync", () => {
  const { catalog: here } = withRecipeItems(null, recipeWith([['onion', 'onion'], ['milk', 'milk']]), '2026-10-04T00:00:00.000Z');
  const gone = { ...entry('onion', 4, false, 'Onions'), deleted: true, updatedAt: '2026-09-01T00:00:00.000Z' };
  const there = { schemaVersion: 1, updatedAt: '2026-09-01T00:00:00.000Z', items: [gone] };
  const merged = mergeCatalog(here, there);
  assert.deepEqual(merged?.items.find((c) => c.key === 'onion'), gone, 'deleted there, so it stays deleted');
  assert.equal(merged?.items.find((c) => c.key === 'milk')?.updatedAt, NEVER, 'the one only here is kept');
});

test('a review keeps a label already settled over the guess', () => {
  const additions = recipeAdditions([recipeWith([['yukon gold potatoes', 'yukon-gold-potatoes']])], new Map([['yukon-gold-potatoes', 'Yukon Gold potatoes']]));
  assert.deepEqual(additions.items.map((c) => c.label), ['Yukon Gold potatoes']);
  assert.equal(labelFor('yukon-gold-potatoes', 'yukon gold potatoes'), 'Yukon gold potatoes');
});

// --- moving rows -----------------------------------------------------------

/**
 * Rows in a given order, each with one line per sort value.
 * @param {...(number|number[])} sorts
 */
function rowsAt(...sorts) {
  return sorts.map((s, i) => {
    const lines = [s].flat().map((sort, j) => ({ ...newItem(`r${i}`, { ...opts, sort }), id: `r${i}.${j}` }));
    return groupItems(lines)[0] ?? assert.fail('fixture');
  });
}

test('a moved row takes the value halfway to its neighbours, and nothing else changes', () => {
  // [100, 400, 200, 300]: 400 was dragged up to second place.
  assert.deepEqual([...sortsForMove(rowsAt(100, 400, 200, 300), 1)], [['r1.0', 150]]);
});

test('a row moved to either end steps past it', () => {
  assert.deepEqual([...sortsForMove(rowsAt(300, 100, 200), 0)], [['r0.0', 0]]);
  assert.deepEqual([...sortsForMove(rowsAt(200, 300, 100), 2)], [['r2.0', 400]]);
});

test('every line behind a moved row moves with it', () => {
  // Beef from two recipes, at 500 and 900, dragged to the top.
  const sorts = sortsForMove(rowsAt([500, 900], 100, 200), 0);
  assert.deepEqual([...sorts], [['r0.0', 0], ['r0.1', 0]]);
});

test('with no whole number left between neighbours, the rows are renumbered in order', () => {
  // 400 dropped between 150 and 151.
  const rows = rowsAt(100, 150, 400, 151);
  const sorts = sortsForMove(rows, 2);
  assert.deepEqual([...sorts], [['r1.0', 200], ['r2.0', 300], ['r3.0', 400]], 'the first row was already at 100');
  const after = groupItems(rows.flatMap((r) => r.lines.map((l) => ({ ...l, sort: sorts.get(l.id) ?? l.sort }))));
  assert.deepEqual(after.map((r) => r.text), ['r0', 'r1', 'r2', 'r3']);
});

test('moving the only row changes nothing', () => {
  assert.equal(sortsForMove(rowsAt(100), 0).size, 0);
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

test('an imported list keeps its id, unless it cannot be a file name', () => {
  assert.equal(normalizeList({ id: '2026-09-21-090000', items: [] }, opts).list.id, '2026-09-21-090000');
  const { list, warnings } = normalizeList({ id: '../lists/x', items: [] }, opts);
  assert.match(list.id, /^id\d+$/);
  assert.match(warnings[0] ?? '', /file name/);
});

test('a new list is named by when it was made, to the second', () => {
  const at = new Date(2026, 8, 30, 14, 32, 5);
  assert.equal(listIdFor(at, new Set()), '2026-09-30-143205');
  assert.equal(listIdFor(new Date(2026, 0, 2, 3, 4, 5), new Set()), '2026-01-02-030405', 'zero-padded, so names sort by time');

  const list = newList('Shopping Sep 30', new Set(), { now: () => at.toISOString() });
  assert.equal(list.id, '2026-09-30-143205');
  assert.equal(list.updatedAt, at.toISOString());
});

test('two lists made in the same second never share a file', () => {
  // A double tap on New list, or a deleted list from that second.
  const at = new Date(2026, 8, 30, 14, 32, 5);
  const taken = new Set(['2026-09-30-143205', '2026-09-30-143205-2']);
  assert.equal(listIdFor(at, taken), '2026-09-30-143205-3');
});
