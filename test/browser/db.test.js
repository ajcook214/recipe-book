// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_ID,
  clearAll,
  countDirty,
  deleteDatabase,
  forget,
  getEnvelope,
  getMeta,
  getRecord,
  idOf,
  listDirty,
  listEnvelopes,
  listRecords,
  markSynced,
  openDatabase,
  pathFor,
  saveLocal,
  saveSynced,
  setMeta,
} from '../../src/core/db.js';

/**
 * IndexedDB only exists in a browser, so this whole suite skips under
 * `node --test`. Run it at http://localhost:8123/test/browser/.
 */
const inBrowser = typeof globalThis.window !== 'undefined';
const browserOnly = inBrowser ? false : 'browser only';

const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-20T11:00:00.000Z';

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
    prepMinutes: null,
    cookMinutes: null,
    source: null,
    notes: null,
    ingredients: [],
    steps: [],
    ...over,
  };
}

/** @param {Partial<any>} [over] */
function shoppingList(over = {}) {
  return {
    id: 'l1',
    schemaVersion: 1,
    updatedAt: T1,
    deleted: false,
    name: 'Week of Sep 21',
    archived: false,
    items: [],
    ...over,
  };
}

/** @param {Partial<any>} [over] */
function catalog(over = {}) {
  return { schemaVersion: 1, updatedAt: T1, items: [], ...over };
}

/**
 * Each test gets its own database, so ordering and leftover state can never
 * couple one test to another.
 *
 * @param {(db: IDBDatabase) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withDb(fn) {
  const name = `recipe-book-test-${crypto.randomUUID()}`;
  const db = await openDatabase(name);
  try {
    await fn(db);
  } finally {
    db.close();
    await deleteDatabase(name);
  }
}

// --- pure helpers (these would pass under Node too, but keep the suite whole)

test('pathFor mirrors the storage layout', { skip: browserOnly }, () => {
  assert.equal(pathFor('recipe', 'abc'), 'recipes/abc.json');
  assert.equal(pathFor('list', 'abc'), 'lists/abc.json');
  assert.equal(pathFor('catalog', CATALOG_ID), 'catalog.json');
});

test('pathFor rejects an unknown type', { skip: browserOnly }, () => {
  assert.throws(() => pathFor(/** @type {any} */ ('sandwich'), 'x'));
});

test('idOf reads the record id, and is constant for the catalog', { skip: browserOnly }, () => {
  assert.equal(idOf('recipe', recipe({ id: 'xyz' })), 'xyz');
  assert.equal(idOf('catalog', catalog()), CATALOG_ID);
});

test('idOf rejects a record with no usable id', { skip: browserOnly }, () => {
  assert.throws(() => idOf('recipe', { id: '' }));
  assert.throws(() => idOf('list', {}));
});

// --- saving ----------------------------------------------------------------

test('saveLocal stores a record and marks it dirty', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const env = await saveLocal(db, 'recipe', recipe());
    assert.equal(env.path, 'recipes/r1.json');
    assert.equal(env.dirty, 1);

    const found = await getEnvelope(db, 'recipes/r1.json');
    assert.equal(found?.record.title, 'Weeknight Chili');
    assert.equal(found?.dirty, 1);
  });
});

test('saveLocal keeps the record byte-for-byte', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const original = recipe({ tags: ['a', 'b'], ingredients: [{ qty: 1.5, item: 'beef' }] });
    await saveLocal(db, 'recipe', original);
    const stored = await getRecord(db, 'recipe', 'r1');
    assert.deepEqual(stored, original);
  });
});

test('saveLocal preserves sync bookkeeping from a previous sync', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveSynced(db, 'recipe', recipe(), {
      version: 'v7',
      modifiedTime: T1,
      syncedAt: T1,
    });

    const edited = await saveLocal(db, 'recipe', recipe({ title: 'Edited', updatedAt: T2 }));
    assert.equal(edited.dirty, 1, 'the edit is pending');
    assert.equal(edited.version, 'v7', 'the last-known remote version must survive');
    assert.equal(edited.remoteModifiedTime, T1);
    assert.equal(edited.syncedAt, T1);
  });
});

test('a tombstone is an ordinary dirty record', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveSynced(db, 'recipe', recipe());
    await saveLocal(db, 'recipe', recipe({ deleted: true, updatedAt: T2 }));

    const dirty = await listDirty(db);
    assert.equal(dirty.length, 1, 'the delete has to be pushed like any other change');
    assert.equal(dirty[0]?.record.deleted, true);
  });
});

test('saveSynced stores a clean record with its remote version', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const env = await saveSynced(db, 'list', shoppingList(), {
      version: 'v2',
      modifiedTime: T2,
      syncedAt: T2,
    });
    assert.equal(env.dirty, 0);
    assert.equal(env.version, 'v2');
    assert.equal(await countDirty(db), 0);
  });
});

test('saving the same path twice overwrites rather than duplicating', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe({ title: 'First' }));
    await saveLocal(db, 'recipe', recipe({ title: 'Second' }));
    const all = await listEnvelopes(db, 'recipe');
    assert.equal(all.length, 1);
    assert.equal(all[0]?.record.title, 'Second');
  });
});

// --- markSynced ------------------------------------------------------------

test('markSynced clears the dirty flag without touching the record', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe({ title: 'Pending' }));
    const updated = await markSynced(db, 'recipes/r1.json', {
      version: 'v3',
      modifiedTime: T2,
      syncedAt: T2,
    });

    assert.equal(updated?.dirty, 0);
    assert.equal(updated?.version, 'v3');
    assert.equal(updated?.record.title, 'Pending', 'the record must be left alone');
    assert.equal(await countDirty(db), 0);
  });
});

test('markSynced on an unknown path is a no-op', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const result = await markSynced(db, 'recipes/nope.json', { version: 'v1' });
    assert.equal(result, undefined);
    assert.equal((await listEnvelopes(db, 'recipe')).length, 0);
  });
});

test('markSynced keeps existing values when none are supplied', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveSynced(db, 'recipe', recipe(), { version: 'v1', modifiedTime: T1, syncedAt: T1 });
    await saveLocal(db, 'recipe', recipe({ title: 'Edited' }));
    const updated = await markSynced(db, 'recipes/r1.json');
    assert.equal(updated?.dirty, 0);
    assert.equal(updated?.version, 'v1');
  });
});

// --- querying --------------------------------------------------------------

test('the dirty count is what the Sync button shows', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    assert.equal(await countDirty(db), 0);

    await saveLocal(db, 'recipe', recipe({ id: 'r1' }));
    await saveLocal(db, 'recipe', recipe({ id: 'r2' }));
    await saveSynced(db, 'list', shoppingList());
    assert.equal(await countDirty(db), 2);

    await markSynced(db, 'recipes/r1.json');
    assert.equal(await countDirty(db), 1);
  });
});

test('listDirty returns only pending records', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveSynced(db, 'recipe', recipe({ id: 'clean' }));
    await saveLocal(db, 'recipe', recipe({ id: 'pending' }));

    const dirty = await listDirty(db);
    assert.equal(dirty.length, 1);
    assert.equal(dirty[0]?.id, 'pending');
  });
});

test('listDirty spans every record type', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe());
    await saveLocal(db, 'list', shoppingList());
    await saveLocal(db, 'catalog', catalog());

    const paths = (await listDirty(db)).map((e) => e.path).sort();
    assert.deepEqual(paths, ['catalog.json', 'lists/l1.json', 'recipes/r1.json']);
  });
});

test('listEnvelopes is scoped to one type', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe());
    await saveLocal(db, 'list', shoppingList());

    assert.equal((await listEnvelopes(db, 'recipe')).length, 1);
    assert.equal((await listEnvelopes(db, 'list')).length, 1);
    assert.equal((await listEnvelopes(db, 'catalog')).length, 0);
  });
});

test('listRecords hides tombstones by default', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe({ id: 'alive' }));
    await saveLocal(db, 'recipe', recipe({ id: 'gone', deleted: true }));

    const visible = await listRecords(db, 'recipe');
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.id, 'alive');

    const all = await listRecords(db, 'recipe', { includeDeleted: true });
    assert.equal(all.length, 2, 'the tombstone is still stored, just not shown');
  });
});

test('getRecord finds a record by type and id', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe({ id: 'abc', title: 'Found' }));
    assert.equal((await getRecord(db, 'recipe', 'abc'))?.title, 'Found');
    assert.equal(await getRecord(db, 'recipe', 'missing'), undefined);
  });
});

test('the catalog is reachable without naming an id', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'catalog', catalog({ items: [{ key: 'flour' }] }));
    const stored = await getRecord(db, 'catalog');
    assert.equal(stored?.items[0]?.key, 'flour');
  });
});

// --- removal and meta ------------------------------------------------------

test('forget removes a path outright', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe());
    await forget(db, 'recipes/r1.json');
    assert.equal(await getEnvelope(db, 'recipes/r1.json'), undefined);
  });
});

test('meta values round-trip', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    assert.equal(await getMeta(db, 'lastSync'), undefined);
    await setMeta(db, 'lastSync', T2);
    assert.equal(await getMeta(db, 'lastSync'), T2);

    await setMeta(db, 'adapter', { kind: 'local', label: 'RecipeApp' });
    assert.deepEqual(await getMeta(db, 'adapter'), { kind: 'local', label: 'RecipeApp' });
  });
});

test('clearAll empties both stores', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    await saveLocal(db, 'recipe', recipe());
    await setMeta(db, 'lastSync', T2);

    await clearAll(db);
    assert.equal((await listEnvelopes(db, 'recipe')).length, 0);
    assert.equal(await getMeta(db, 'lastSync'), undefined);
  });
});

test('data survives closing and reopening the database', { skip: browserOnly }, async () => {
  const name = `recipe-book-test-${crypto.randomUUID()}`;
  try {
    const first = await openDatabase(name);
    await saveLocal(first, 'recipe', recipe({ title: 'Persisted' }));
    await setMeta(first, 'lastSync', T1);
    first.close();

    const second = await openDatabase(name);
    assert.equal((await getRecord(second, 'recipe', 'r1'))?.title, 'Persisted');
    assert.equal(await getMeta(second, 'lastSync'), T1);
    assert.equal(await countDirty(second), 1, 'pending changes survive a restart');
    second.close();
  } finally {
    await deleteDatabase(name);
  }
});
