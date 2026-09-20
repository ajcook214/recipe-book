// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonical,
  isSame,
  pickNewer,
  mergeRecipe,
  mergeList,
  mergeCatalog,
} from '../src/core/merge.js';

// Tests are deliberately flat (no nested t.test / subtests) so this same file
// runs unmodified in the browser via test/browser/index.html, where `node:test`
// is shimmed through an import map.

const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-20T11:00:00.000Z';
const T3 = '2026-09-20T12:00:00.000Z';

/** @param {Partial<any>} [over] */
function recipe(over = {}) {
  return {
    id: 'r1',
    schemaVersion: 1,
    updatedAt: T1,
    deleted: false,
    title: 'Weeknight Chili',
    rating: 8,
    tags: ['dinner'],
    servings: 4,
    prepMinutes: 15,
    cookMinutes: 45,
    source: null,
    notes: null,
    ingredients: [],
    steps: [],
    ...over,
  };
}

/** @param {Partial<any>} [over] */
function item(over = {}) {
  return {
    id: 'i1',
    text: 'flour',
    key: 'flour',
    qty: 1,
    unit: 'cup',
    checked: false,
    checkedAt: null,
    sort: 100,
    updatedAt: T1,
    deleted: false,
    from: null,
    ...over,
  };
}

/** @param {any[]} items @param {Partial<any>} [over] */
function list(items, over = {}) {
  return {
    id: 'l1',
    schemaVersion: 1,
    updatedAt: T1,
    deleted: false,
    name: 'Week of Sep 21',
    archived: false,
    items,
    ...over,
  };
}

/** @param {Partial<any>} [over] */
function catItem(over = {}) {
  return {
    key: 'paper-towels',
    label: 'Paper towels',
    defaultUnit: null,
    useCount: 1,
    lastUsedAt: T1,
    pinned: false,
    deleted: false,
    updatedAt: T1,
    ...over,
  };
}

/** @param {any[]} items @param {Partial<any>} [over] */
function catalog(items, over = {}) {
  return { schemaVersion: 1, updatedAt: T1, items, ...over };
}

// --- canonical / isSame ----------------------------------------------------

test('canonical ignores key insertion order', () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test('canonical recurses into nested objects and arrays', () => {
  const x = { outer: [{ a: 1, b: 2 }] };
  const y = { outer: [{ b: 2, a: 1 }] };
  assert.equal(canonical(x), canonical(y));
});

test('canonical still distinguishes different values', () => {
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});

test('isSame compares structurally, not by reference', () => {
  assert.equal(isSame({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
  assert.equal(isSame({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(isSame({ a: 1 }, { a: 2 }), false);
});

// --- pickNewer -------------------------------------------------------------

test('pickNewer returns the newer updatedAt', () => {
  const older = { id: 'x', updatedAt: T1 };
  const newer = { id: 'x', updatedAt: T2 };
  assert.deepEqual(pickNewer(older, newer), newer);
  assert.deepEqual(pickNewer(newer, older), newer);
});

test('pickNewer treats a missing side as absent', () => {
  const only = { id: 'x', updatedAt: T1 };
  assert.deepEqual(pickNewer(null, only), only);
  assert.deepEqual(pickNewer(only, null), only);
  assert.deepEqual(pickNewer(undefined, only), only);
  assert.equal(pickNewer(null, null), null);
  assert.equal(pickNewer(undefined, undefined), null);
});

test('pickNewer is commutative on a timestamp tie', () => {
  const a = { id: 'x', updatedAt: T1, title: 'aaa' };
  const b = { id: 'x', updatedAt: T1, title: 'bbb' };
  assert.deepEqual(pickNewer(a, b), pickNewer(b, a));
});

test('pickNewer returns a stable winner on a tie, not just either side', () => {
  const a = { id: 'x', updatedAt: T1, title: 'aaa' };
  const b = { id: 'x', updatedAt: T1, title: 'bbb' };
  const first = pickNewer(a, b);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(pickNewer(a, b), first);
    assert.deepEqual(pickNewer(b, a), first);
  }
});

test('pickNewer keeps identical values intact on a tie', () => {
  const a = { id: 'x', updatedAt: T1, title: 'same' };
  const b = { id: 'x', updatedAt: T1, title: 'same' };
  assert.deepEqual(pickNewer(a, b), a);
});

test('a corrupt timestamp never beats a well-formed one', () => {
  const good = { id: 'x', updatedAt: T1 };
  assert.deepEqual(pickNewer({ id: 'x', updatedAt: 'not-a-date' }, good), good);
  assert.deepEqual(pickNewer({ id: 'x' }, good), good);
  assert.deepEqual(pickNewer({ id: 'x', updatedAt: 42 }, good), good);
  assert.deepEqual(pickNewer(good, { id: 'x', updatedAt: null }), good);
});

// --- mergeRecipe -----------------------------------------------------------

test('mergeRecipe takes the newer whole record', () => {
  const local = recipe({ title: 'Old Title', updatedAt: T1 });
  const remote = recipe({ title: 'New Title', rating: 9, updatedAt: T2 });
  assert.deepEqual(mergeRecipe(local, remote), remote);
});

test('mergeRecipe does not field-merge', () => {
  const local = recipe({ rating: 10, updatedAt: T1 });
  const remote = recipe({ title: 'Renamed', updatedAt: T2 });
  const merged = mergeRecipe(local, remote);
  assert.equal(merged?.rating, 8, 'the losing rating must not survive');
  assert.equal(merged?.title, 'Renamed');
});

test('a recipe tombstone wins when it is newer', () => {
  const local = recipe({ updatedAt: T1 });
  const remote = recipe({ deleted: true, updatedAt: T2 });
  assert.equal(mergeRecipe(local, remote)?.deleted, true);
});

test('a newer edit beats an older tombstone', () => {
  const local = recipe({ deleted: true, updatedAt: T1 });
  const remote = recipe({ title: 'Revived', updatedAt: T2 });
  assert.equal(mergeRecipe(local, remote)?.deleted, false);
});

test('mergeRecipe handles a record present on only one side', () => {
  const only = recipe();
  assert.deepEqual(mergeRecipe(null, only), only);
  assert.deepEqual(mergeRecipe(only, undefined), only);
});

// --- mergeList -------------------------------------------------------------

test('mergeList unions items from both sides', () => {
  const local = list([item({ id: 'a', sort: 100 })]);
  const remote = list([item({ id: 'b', text: 'milk', key: 'milk', sort: 200 })]);
  const merged = mergeList(local, remote);
  assert.equal(merged?.items.length, 2);
  assert.deepEqual(
    merged?.items.map((i) => i.id),
    ['a', 'b'],
  );
});

test('the real-world case: check off on the phone, add on the desktop', () => {
  // Phone checks off flour at T2. Desktop, which never saw that, adds milk at T2.
  const phone = list([item({ id: 'a', checked: true, checkedAt: T2, updatedAt: T2 })]);
  const desktop = list([
    item({ id: 'a', updatedAt: T1 }),
    item({ id: 'b', text: 'milk', key: 'milk', sort: 200, updatedAt: T2 }),
  ]);

  const merged = mergeList(phone, desktop);
  assert.equal(merged?.items.length, 2);
  assert.equal(merged?.items[0]?.checked, true, 'the check-off must survive');
  assert.equal(merged?.items[1]?.text, 'milk', 'the new item must survive');
});

test('a deleted item does not come back from the dead', () => {
  const local = list([item({ id: 'a', deleted: true, updatedAt: T2 })]);
  const remote = list([item({ id: 'a', deleted: false, updatedAt: T1 })]);
  const merged = mergeList(local, remote);
  assert.equal(merged?.items.length, 1);
  assert.equal(merged?.items[0]?.deleted, true);
});

test('an item edited after deletion is restored', () => {
  const local = list([item({ id: 'a', deleted: true, updatedAt: T1 })]);
  const remote = list([item({ id: 'a', qty: 3, updatedAt: T2 })]);
  const merged = mergeList(local, remote);
  assert.equal(merged?.items[0]?.deleted, false);
  assert.equal(merged?.items[0]?.qty, 3);
});

test('mergeList resolves scalar fields by whole-record LWW', () => {
  const local = list([], { name: 'Old Name', archived: true, updatedAt: T1 });
  const remote = list([], { name: 'New Name', archived: false, updatedAt: T2 });
  const merged = mergeList(local, remote);
  assert.equal(merged?.name, 'New Name');
  assert.equal(merged?.archived, false);
});

test('mergeList orders items by sort, then by id', () => {
  const local = list([
    item({ id: 'z', sort: 300 }),
    item({ id: 'b', sort: 100 }),
  ]);
  const remote = list([
    item({ id: 'a', sort: 100 }),
    item({ id: 'm', sort: 200 }),
  ]);
  const merged = mergeList(local, remote);
  assert.deepEqual(
    merged?.items.map((i) => i.id),
    ['a', 'b', 'm', 'z'],
  );
});

test('mergeList is commutative', () => {
  const local = list([
    item({ id: 'a', checked: true, updatedAt: T2 }),
    item({ id: 'c', sort: 300, updatedAt: T1 }),
  ]);
  const remote = list(
    [
      item({ id: 'a', updatedAt: T1 }),
      item({ id: 'b', sort: 200, updatedAt: T3 }),
    ],
    { name: 'Renamed', updatedAt: T2 },
  );
  assert.equal(canonical(mergeList(local, remote)), canonical(mergeList(remote, local)));
});

test('mergeList is idempotent', () => {
  const local = list([item({ id: 'a', checked: true, updatedAt: T2 })]);
  const remote = list([item({ id: 'a', updatedAt: T1 }), item({ id: 'b', sort: 200 })]);
  const once = mergeList(local, remote);
  const twice = mergeList(once, remote);
  assert.equal(canonical(once), canonical(twice));
});

test('mergeList collapses duplicate ids within one side', () => {
  const local = list([
    item({ id: 'a', qty: 1, updatedAt: T1 }),
    item({ id: 'a', qty: 5, updatedAt: T2 }),
  ]);
  const merged = mergeList(local, list([]));
  assert.equal(merged?.items.length, 1);
  assert.equal(merged?.items[0]?.qty, 5);
});

test('mergeList skips items with no usable id', () => {
  const local = list([item({ id: 'a' }), item({ id: '' }), item({ id: null })]);
  const merged = mergeList(local, list([]));
  assert.equal(merged?.items.length, 1);
  assert.equal(merged?.items[0]?.id, 'a');
});

test('mergeList handles a list present on only one side', () => {
  const only = list([item()]);
  assert.deepEqual(mergeList(null, only), only);
  assert.deepEqual(mergeList(only, undefined), only);
  assert.equal(mergeList(null, null), null);
});

test('mergeList tolerates a missing items array', () => {
  const merged = mergeList(list([item({ id: 'a' })]), /** @type {any} */ ({
    id: 'l1',
    schemaVersion: 1,
    updatedAt: T2,
    deleted: false,
    name: 'Week of Sep 21',
    archived: false,
  }));
  assert.equal(merged?.items.length, 1);
});

test('merging a list with itself changes nothing', () => {
  const l = list([item({ id: 'a' }), item({ id: 'b', sort: 200 })]);
  assert.equal(canonical(mergeList(l, structuredClone(l))), canonical(l));
});

// --- mergeCatalog ----------------------------------------------------------

test('mergeCatalog unions entries by key', () => {
  const local = catalog([catItem({ key: 'flour', label: 'Flour' })]);
  const remote = catalog([catItem({ key: 'milk', label: 'Milk' })]);
  const merged = mergeCatalog(local, remote);
  assert.deepEqual(
    merged?.items.map((i) => i.key),
    ['flour', 'milk'],
  );
});

test('mergeCatalog resolves a same-key collision by LWW', () => {
  const local = catalog([catItem({ useCount: 2, updatedAt: T1 })]);
  const remote = catalog([catItem({ useCount: 9, pinned: true, updatedAt: T2 })]);
  const merged = mergeCatalog(local, remote);
  assert.equal(merged?.items.length, 1);
  assert.equal(merged?.items[0]?.useCount, 9);
  assert.equal(merged?.items[0]?.pinned, true);
});

test('mergeCatalog keeps tombstoned entries', () => {
  const local = catalog([catItem({ deleted: true, updatedAt: T2 })]);
  const remote = catalog([catItem({ updatedAt: T1 })]);
  const merged = mergeCatalog(local, remote);
  assert.equal(merged?.items.length, 1);
  assert.equal(merged?.items[0]?.deleted, true);
});

test('mergeCatalog sorts entries by key', () => {
  const local = catalog([catItem({ key: 'zucchini' }), catItem({ key: 'apples' })]);
  const remote = catalog([catItem({ key: 'milk' })]);
  assert.deepEqual(
    mergeCatalog(local, remote)?.items.map((i) => i.key),
    ['apples', 'milk', 'zucchini'],
  );
});

test('mergeCatalog is commutative', () => {
  const local = catalog([catItem({ key: 'flour', useCount: 3, updatedAt: T2 })]);
  const remote = catalog(
    [catItem({ key: 'flour', useCount: 1, updatedAt: T1 }), catItem({ key: 'milk' })],
    { updatedAt: T3 },
  );
  assert.equal(
    canonical(mergeCatalog(local, remote)),
    canonical(mergeCatalog(remote, local)),
  );
});

test('mergeCatalog handles a catalog present on only one side', () => {
  const only = catalog([catItem()]);
  assert.deepEqual(mergeCatalog(null, only), only);
  assert.deepEqual(mergeCatalog(only, undefined), only);
  assert.equal(mergeCatalog(null, null), null);
});
