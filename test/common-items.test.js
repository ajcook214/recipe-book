// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCatalog } from '../src/core/list.js';
import { mergeCatalog } from '../src/core/merge.js';
import { looksAlike, reviewOf, stampReview } from '../tools/common-items.js';
import { NEVER } from '../tools/ingest.js';

/*
 * The common-items skill's review. Node only (tools/ reads the file
 * system), so it is not in the browser SUITES.
 */

const BACKUP = '2026-10-01T12:00:00.000Z';
const SINCE = '2026-10-02T12:00:00.000Z';
const NOW = '2026-10-03T12:00:00.000Z';

/** @param {string} key @param {Partial<any>} [over] */
const entry = (key, over = {}) => ({
  key,
  label: key.charAt(0).toUpperCase() + key.slice(1),
  defaultUnit: null,
  useCount: 3,
  lastUsedAt: BACKUP,
  pinned: false,
  deleted: false,
  updatedAt: BACKUP,
  ...over,
});

/** @param {any[]} items */
const catalogOf = (items) => ({ schemaVersion: 1, updatedAt: BACKUP, items });

/** @param {any} catalog @param {string} key */
const find = (catalog, key) => catalog.items.find((/** @type {any} */ c) => c.key === key);

// --- writing the reviewed list -------------------------------------------------

test('each entry is stamped for what the review did to it', () => {
  const base = [entry('milk'), entry('bananas'), entry('bananna')];
  const edited = [
    entry('milk'),
    { ...entry('bananas'), pinned: true },
    { key: 'paper-plates', label: 'Paper plates' },
    { ...entry('onion'), useCount: 0, updatedAt: NEVER },
  ];
  const { items, errors } = stampReview(base, edited, NOW);
  const out = catalogOf(items);
  assert.deepEqual(errors, []);
  assert.equal(find(out, 'milk').updatedAt, BACKUP, 'unchanged keeps its own time');
  assert.equal(find(out, 'bananas').updatedAt, NOW, 'changed is stamped now');
  assert.deepEqual(
    [find(out, 'bananna').deleted, find(out, 'bananna').updatedAt],
    [true, NOW],
    'taken out becomes a delete, stamped now',
  );
  assert.deepEqual(find(out, 'paper-plates'), {
    key: 'paper-plates', label: 'Paper plates', defaultUnit: null, useCount: 0, lastUsedAt: null, pinned: false, deleted: false, updatedAt: NOW,
  });
  assert.equal(find(out, 'onion').updatedAt, NEVER, 'a recipe ingredient only fills a gap');
});

test('a field left out of the copy is left alone', () => {
  const { items } = stampReview([entry('milk', { pinned: true })], [{ key: 'milk', label: 'Milk' }], NOW);
  assert.deepEqual(items[0], entry('milk', { pinned: true }));
});

test('a reviewed list that the app would misread is refused', () => {
  const { errors } = stampReview(
    [entry('milk')],
    [
      { key: 'Paper Plates', label: 'Paper plates' },
      { key: 'milk', label: 'Milk' },
      { key: 'milk', label: 'Milk again' },
      { key: 'whole-milk', label: 'milk' },
    ],
    NOW,
  );
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors.join('\n'), /not a slug/);
  assert.match(errors.join('\n'), /in the list twice/);
  assert.match(errors.join('\n'), /both answer to "milk"/);
});

test('importing a review keeps what changed in the app since the backup', () => {
  // The backup, then the app moves on: milk added to a list, eggs deleted.
  const base = [entry('milk'), entry('eggs'), entry('bananas'), entry('bananna')];
  const app = catalogOf([
    entry('milk', { useCount: 4, lastUsedAt: SINCE, updatedAt: SINCE }),
    entry('eggs', { deleted: true, updatedAt: SINCE }),
    entry('bananas'),
    entry('bananna'),
  ]);
  // The review, from the backup: a rename, a typo out, two new entries.
  const edited = [
    entry('milk'),
    entry('eggs'),
    { ...entry('bananas'), label: 'Bananas (bunch)' },
    { key: 'paper-plates', label: 'Paper plates' },
    { ...entry('onion'), useCount: 0, updatedAt: NEVER },
  ];
  const { items } = stampReview(base, edited, NOW);
  const merged = mergeCatalog(app, normalizeCatalog(catalogOf(items)).catalog);

  assert.equal(find(merged, 'milk').useCount, 4, 'the use made since the backup survives');
  assert.equal(find(merged, 'eggs').deleted, true, 'the delete made since the backup survives');
  assert.equal(find(merged, 'bananas').label, 'Bananas (bunch)');
  assert.equal(find(merged, 'bananna').deleted, true);
  assert.equal(find(merged, 'paper-plates').deleted, false);
  assert.equal(find(merged, 'onion').deleted, false);
});

// --- the report ----------------------------------------------------------------

test('plurals and small typos look alike; different things do not', () => {
  assert.equal(looksAlike('egg', 'eggs'), true);
  assert.equal(looksAlike('bananna', 'bananas'), true);
  assert.equal(looksAlike('tomato', 'tomatoes'), true);
  assert.equal(looksAlike('onion', 'red-onion'), false);
  assert.equal(looksAlike('salt', 'salmon'), false);
});

test('the review finds what is bought but not common, typos, and what to pin', () => {
  /** @param {string} id @param {string[]} keys */
  const list = (id, keys) => ({
    id,
    name: id,
    deleted: false,
    items: keys.map((key, i) => ({ id: `${id}-${i}`, key, text: key, deleted: false, from: null, updatedAt: BACKUP })),
  });
  const backup = {
    catalog: catalogOf([entry('milk'), entry('bananas'), entry('bananna', { useCount: 1 })]),
    lists: [
      list('2026-09-01-090000', ['milk', 'paper-plates']),
      list('2026-09-08-090000', ['milk', 'paper-plates']),
      list('2026-09-15-090000', ['milk']),
      list('2026-09-22-090000', ['bananas']),
    ],
    recipes: [{ id: 'soup', title: 'Soup', ingredients: [{ key: 'onion' }, { key: 'milk' }] }],
  };
  const { report, working } = reviewOf(backup);
  const text = report.join('\n');

  assert.match(text, /paper-plates: "paper-plates", on 2 lists, last 2026-09-08/);
  assert.match(text, /bananna "Bananna": added once.*looks like bananas/);
  assert.match(text, /milk: on 3 of 4/);
  assert.deepEqual(
    working.map((c) => [c.key, c.updatedAt]),
    [['bananas', BACKUP], ['bananna', BACKUP], ['milk', BACKUP], ['onion', NEVER]],
    'the copy is the common items plus recipe ingredients that are not common yet',
  );
});
