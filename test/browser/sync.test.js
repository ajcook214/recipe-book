// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countDirty,
  deleteDatabase,
  getEnvelope,
  getMeta,
  getRecord,
  listRecords,
  openDatabase,
  saveFromSync,
  saveLocal,
  setMeta,
} from '../../src/core/db.js';
import { AuthError } from '../../src/core/errors.js';
import { LAST_SYNC_KEY, sync } from '../../src/core/sync.js';
import { createMemoryAdapter } from '../helpers/memory-adapter.js';

/**
 * Sync needs a real IndexedDB, so this suite is browser-only. The adapter is
 * in-memory, which keeps every scenario here about the algorithm rather than
 * about a filesystem or a network.
 */
const inBrowser = typeof globalThis.window !== 'undefined';
const browserOnly = inBrowser ? false : 'browser only';

const T1 = '2026-09-20T10:00:00.000Z';
const T2 = '2026-09-20T11:00:00.000Z';
const T3 = '2026-09-20T12:00:00.000Z';
const NOW = '2026-09-20T13:00:00.000Z';

/** A fixed clock, so syncedAt never varies between runs. */
const clock = { now: () => NOW };

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

/** @param {any[]} [items] @param {Partial<any>} [over] */
function shoppingList(items = [], over = {}) {
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

/** @param {any[]} [items] @param {Partial<any>} [over] */
function catalog(items = [], over = {}) {
  return { schemaVersion: 1, updatedAt: T1, items, ...over };
}

/** @param {Partial<any>} [over] */
function catItem(over = {}) {
  return {
    key: 'flour',
    label: 'Flour',
    defaultUnit: 'cup',
    useCount: 1,
    lastUsedAt: T1,
    pinned: false,
    deleted: false,
    updatedAt: T1,
    ...over,
  };
}

/**
 * @param {(db: IDBDatabase) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withDb(fn) {
  const name = `sync-test-${crypto.randomUUID()}`;
  const db = await openDatabase(name);
  try {
    await fn(db);
  } finally {
    db.close();
    await deleteDatabase(name);
  }
}

/**
 * Two working copies over one storage backend: the desktop and the phone.
 *
 * @param {(a: IDBDatabase, b: IDBDatabase, adapter: any) => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function withTwoDevices(fn) {
  const nameA = `sync-a-${crypto.randomUUID()}`;
  const nameB = `sync-b-${crypto.randomUUID()}`;
  const a = await openDatabase(nameA);
  const b = await openDatabase(nameB);
  try {
    await fn(a, b, createMemoryAdapter());
  } finally {
    a.close();
    b.close();
    await deleteDatabase(nameA);
    await deleteDatabase(nameB);
  }
}

// --- nothing to do ---------------------------------------------------------

test('syncing two empty sides does nothing', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    const result = await sync(db, adapter, clock);

    assert.equal(result.pulled, 0);
    assert.equal(result.pushed, 0);
    assert.equal(result.errors.length, 0);
    assert.equal(result.lastSync, null);
    assert.equal(await getMeta(db, LAST_SYNC_KEY), undefined);
  });
});

// --- pulling ---------------------------------------------------------------

test('a remote record is pulled into the working copy, clean', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    adapter._seed('recipes/r1.json', recipe({ title: 'From Storage' }));

    const result = await sync(db, adapter, clock);
    assert.equal(result.pulled, 1);
    assert.equal(result.pushed, 0);

    const env = await getEnvelope(db, 'recipes/r1.json');
    assert.equal(env?.record.title, 'From Storage');
    assert.equal(env?.dirty, 0, 'a pulled record has nothing to push back');
    assert.equal(env?.version, adapter._meta('recipes/r1.json')?.version);
    assert.equal(env?.syncedAt, NOW);
  });
});

test('files the working copy does not mirror are skipped', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    adapter._seed('manifest.json', { schemaVersion: 1, lastModified: T1 });
    adapter._seed('images/photo.jpg', { blobish: true });
    adapter._seed('recipes/r1.json', recipe());

    const result = await sync(db, adapter, clock);
    assert.equal(result.pulled, 1);
    assert.equal(result.skipped, 2);
    assert.equal(result.errors.length, 0);
  });
});

test('a record whose id disagrees with its path is reported, not stored', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    adapter._seed('recipes/r1.json', recipe({ id: 'somethingelse' }));
    adapter._seed('recipes/r2.json', recipe({ id: 'r2', title: 'Fine' }));

    const result = await sync(db, adapter, clock);
    assert.equal(result.pulled, 1, 'the good file still syncs');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.path, 'recipes/r1.json');
    assert.equal(result.errors[0]?.phase, 'pull');
    assert.equal(await getEnvelope(db, 'recipes/r1.json'), undefined);
  });
});

test('the watermark only advances to times storage reported', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    const seeded = adapter._seed('recipes/r1.json', recipe());

    const result = await sync(db, adapter, clock);
    assert.equal(result.lastSync, seeded.modifiedTime);
    assert.notEqual(result.lastSync, NOW, 'never this device clock');
    assert.equal(await getMeta(db, LAST_SYNC_KEY), seeded.modifiedTime);
  });
});

test('a second sync pulls nothing new', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    adapter._seed('recipes/r1.json', recipe());

    await sync(db, adapter, clock);
    const second = await sync(db, adapter, clock);

    assert.equal(second.pulled, 0);
    assert.equal(second.pushed, 0);
    assert.equal(second.errors.length, 0);
  });
});

// --- pushing ---------------------------------------------------------------

test('a local record is pushed and marked clean', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    await saveLocal(db, 'recipe', recipe({ title: 'Local Only' }));
    assert.equal(await countDirty(db), 1);

    const result = await sync(db, adapter, clock);
    assert.equal(result.pushed, 1);
    assert.equal(result.dirtyRemaining, 0);
    assert.equal(adapter._read('recipes/r1.json')?.title, 'Local Only');

    const env = await getEnvelope(db, 'recipes/r1.json');
    assert.equal(env?.dirty, 0);
    assert.equal(env?.version, adapter._meta('recipes/r1.json')?.version);
  });
});

test('every record type round-trips', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    await saveLocal(db, 'recipe', recipe());
    await saveLocal(db, 'list', shoppingList([item()]));
    await saveLocal(db, 'catalog', catalog([catItem()]));

    const result = await sync(db, adapter, clock);
    assert.equal(result.pushed, 3);
    assert.deepEqual(adapter._paths(), ['catalog.json', 'lists/l1.json', 'recipes/r1.json']);
  });
});

test('a delete travels as a tombstone, not a removal', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    await saveLocal(db, 'recipe', recipe());
    await sync(db, adapter, clock);

    await saveLocal(db, 'recipe', recipe({ deleted: true, updatedAt: T2 }));
    const result = await sync(db, adapter, clock);

    assert.equal(result.pushed, 1);
    assert.deepEqual(adapter._paths(), ['recipes/r1.json'], 'the file stays');
    assert.equal(adapter._read('recipes/r1.json')?.deleted, true);
    assert.equal(adapter._calls().remove, 0, 'sync never calls remove');
  });
});

test('a push failure leaves the record dirty for next time', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    await saveLocal(db, 'recipe', recipe());
    adapter._failWrites('recipes/r1.json', 1);

    const first = await sync(db, adapter, clock);
    assert.equal(first.pushed, 0);
    assert.equal(first.errors.length, 1);
    assert.equal(first.dirtyRemaining, 1);

    const second = await sync(db, adapter, clock);
    assert.equal(second.pushed, 1);
    assert.equal(second.dirtyRemaining, 0);
  });
});

test('one bad record does not stop the rest of the push', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    await saveLocal(db, 'recipe', recipe({ id: 'good' }));
    await saveLocal(db, 'recipe', recipe({ id: 'bad' }));
    adapter._failWrites('recipes/bad.json', 5);

    const result = await sync(db, adapter, clock);
    assert.equal(result.pushed, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.dirtyRemaining, 1);
    assert.ok(adapter._read('recipes/good.json'));
  });
});

test('an expired sign-in stops the pass, and signing in again finishes it', { skip: browserOnly }, async () => {
  // Expiring part way through the pull, and part way through the push.
  for (const phase of /** @type {const} */ (['read', 'write'])) {
    await withDb(async (db) => {
      const adapter = createMemoryAdapter();
      adapter._seed('recipes/r1.json', recipe({ id: 'r1' }));
      adapter._seed('recipes/r2.json', recipe({ id: 'r2' }));
      await saveLocal(db, 'recipe', recipe({ id: 'r3' }));
      await saveLocal(db, 'recipe', recipe({ id: 'r4' }));

      let calls = 0;
      const expiring = {
        ...adapter,
        /** @param {any[]} args */
        [phase]: async (...args) => {
          calls += 1;
          if (calls === 2) throw new AuthError();
          return /** @type {any} */ (adapter[phase])(...args);
        },
      };

      await assert.rejects(() => sync(db, expiring, clock), AuthError, `${phase}: rejects as AuthError`);
      assert.equal(calls, 2, `${phase}: nothing more was tried after the refusal`);
      assert.equal(await getMeta(db, LAST_SYNC_KEY), undefined, `${phase}: the watermark did not move`);
      assert.ok((await countDirty(db)) >= 1, `${phase}: unpushed edits are still waiting`);

      const result = await sync(db, adapter, clock);
      assert.deepEqual(result.errors, [], `${phase}: the second pass is clean`);
      assert.equal(result.dirtyRemaining, 0);
      assert.deepEqual(adapter._paths(), ['recipes/r1.json', 'recipes/r2.json', 'recipes/r3.json', 'recipes/r4.json']);
      assert.ok(await getRecord(db, 'recipe', 'r2'), `${phase}: the pull finished too`);
    });
  }
});

// --- merging on pull -------------------------------------------------------

test('a newer remote edit wins over an older local one', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    const seeded = adapter._seed('recipes/r1.json', recipe({ title: 'Remote', updatedAt: T3 }));
    await saveFromSync(db, 'recipe', recipe({ title: 'Base' }), {
      version: seeded.version,
      modifiedTime: seeded.modifiedTime,
    });
    await saveLocal(db, 'recipe', recipe({ title: 'Local', updatedAt: T2 }));

    await sync(db, adapter, clock);
    assert.equal((await getRecord(db, 'recipe', 'r1'))?.title, 'Remote');
    assert.equal(await countDirty(db), 0, 'nothing left to push');
  });
});

test('a newer local edit survives the pull and is pushed', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    adapter._seed('recipes/r1.json', recipe({ title: 'Remote', updatedAt: T1 }));
    await saveLocal(db, 'recipe', recipe({ title: 'Local', updatedAt: T3 }));

    const result = await sync(db, adapter, clock);
    assert.equal(result.pulled, 1);
    assert.equal(result.pushed, 1);
    assert.equal(adapter._read('recipes/r1.json')?.title, 'Local');
    assert.equal(result.dirtyRemaining, 0);
  });
});

// --- version conflicts -----------------------------------------------------

test('a push that loses the version check is re-merged and retried', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    const seeded = adapter._seed('recipes/r1.json', recipe({ title: 'Original' }));

    await saveFromSync(db, 'recipe', recipe({ title: 'Original' }), {
      version: seeded.version,
      modifiedTime: seeded.modifiedTime,
    });
    await saveLocal(db, 'recipe', recipe({ title: 'Local Edit', updatedAt: T3 }));

    // Another device writes the same file, then our lastSync is set past it,
    // so the pull will not see the change and the push hits a stale version.
    const touched = adapter._touch('recipes/r1.json', recipe({ title: 'Other Device', updatedAt: T2 }));
    await setMeta(db, LAST_SYNC_KEY, touched.modifiedTime);

    const result = await sync(db, adapter, clock);

    assert.equal(result.pulled, 0, 'the pull was filtered out by the watermark');
    assert.deepEqual(result.conflicts, ['recipes/r1.json']);
    assert.equal(result.pushed, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(adapter._read('recipes/r1.json')?.title, 'Local Edit', 'T3 beats T2');
    assert.equal(result.dirtyRemaining, 0);
  });
});

test('the conflict retry keeps the remote side when it is newer', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    const seeded = adapter._seed('recipes/r1.json', recipe({ title: 'Original' }));
    await saveFromSync(db, 'recipe', recipe(), {
      version: seeded.version,
      modifiedTime: seeded.modifiedTime,
    });
    await saveLocal(db, 'recipe', recipe({ title: 'Local Edit', updatedAt: T1 }));

    const touched = adapter._touch('recipes/r1.json', recipe({ title: 'Other Device', updatedAt: T3 }));
    await setMeta(db, LAST_SYNC_KEY, touched.modifiedTime);

    const result = await sync(db, adapter, clock);
    assert.deepEqual(result.conflicts, ['recipes/r1.json']);
    assert.equal(adapter._read('recipes/r1.json')?.title, 'Other Device');
    assert.equal((await getRecord(db, 'recipe', 'r1'))?.title, 'Other Device');
  });
});

test('a record deleted remotely is recreated from the local copy', { skip: browserOnly }, async () => {
  await withDb(async (db) => {
    const adapter = createMemoryAdapter();
    const seeded = adapter._seed('recipes/r1.json', recipe());
    await saveFromSync(db, 'recipe', recipe(), {
      version: seeded.version,
      modifiedTime: seeded.modifiedTime,
    });
    await saveLocal(db, 'recipe', recipe({ title: 'Still Here', updatedAt: T2 }));

    await adapter.remove('recipes/r1.json');
    await setMeta(db, LAST_SYNC_KEY, T3);

    const result = await sync(db, adapter, clock);
    assert.deepEqual(result.conflicts, ['recipes/r1.json']);
    assert.equal(result.pushed, 1);
    assert.equal(adapter._read('recipes/r1.json')?.title, 'Still Here');
  });
});

// --- two devices -----------------------------------------------------------

test('an edit on one device reaches the other', { skip: browserOnly }, async () => {
  await withTwoDevices(async (a, b, adapter) => {
    await saveLocal(a, 'recipe', recipe({ title: 'Written on A' }));
    await sync(a, adapter, clock);

    await sync(b, adapter, clock);
    assert.equal((await getRecord(b, 'recipe', 'r1'))?.title, 'Written on A');
    assert.equal(await countDirty(b), 0);
  });
});

test('a delete on one device hides the recipe on the other', { skip: browserOnly }, async () => {
  await withTwoDevices(async (a, b, adapter) => {
    await saveLocal(a, 'recipe', recipe());
    await sync(a, adapter, clock);
    await sync(b, adapter, clock);

    await saveLocal(a, 'recipe', recipe({ deleted: true, updatedAt: T2 }));
    await sync(a, adapter, clock);
    await sync(b, adapter, clock);

    assert.equal((await listRecords(b, 'recipe')).length, 0, 'hidden from the UI');
    assert.equal((await listRecords(b, 'recipe', { includeDeleted: true })).length, 1, 'tombstone kept');
  });
});

test('checking off in the store while the desktop adds an item', { skip: browserOnly }, async () => {
  // The scenario the whole per-item merge design exists for.
  await withTwoDevices(async (phone, desktop, adapter) => {
    await saveLocal(phone, 'list', shoppingList([item({ id: 'a' })]));
    await sync(phone, adapter, clock);
    await sync(desktop, adapter, clock);

    // Phone checks flour off in the aisle.
    await saveLocal(phone, 'list', shoppingList([
      item({ id: 'a', checked: true, checkedAt: T2, updatedAt: T2 }),
    ]));

    // Desktop, which has not seen that, adds milk.
    await saveLocal(desktop, 'list', shoppingList([
      item({ id: 'a' }),
      item({ id: 'b', text: 'milk', key: 'milk', sort: 200, updatedAt: T2 }),
    ]));

    await sync(phone, adapter, clock);
    await sync(desktop, adapter, clock);
    await sync(phone, adapter, clock);

    for (const [label, db] of [['phone', phone], ['desktop', desktop]]) {
      const list = await getRecord(/** @type {IDBDatabase} */ (db), 'list', 'l1');
      assert.equal(list.items.length, 2, `${label} has both items`);
      assert.equal(list.items[0]?.checked, true, `${label} kept the check-off`);
      assert.equal(list.items[1]?.text, 'milk', `${label} kept the new item`);
    }

    assert.equal(await countDirty(phone), 0);
    assert.equal(await countDirty(desktop), 0);
  });
});

test('catalog entries from both devices survive', { skip: browserOnly }, async () => {
  await withTwoDevices(async (a, b, adapter) => {
    await saveLocal(a, 'catalog', catalog([catItem({ key: 'flour' })]));
    await sync(a, adapter, clock);
    await sync(b, adapter, clock);

    await saveLocal(a, 'catalog', catalog([
      catItem({ key: 'flour', useCount: 5, updatedAt: T2 }),
    ]));
    await saveLocal(b, 'catalog', catalog([
      catItem({ key: 'flour' }),
      catItem({ key: 'paper-towels', label: 'Paper towels', updatedAt: T2 }),
    ]));

    await sync(a, adapter, clock);
    await sync(b, adapter, clock);
    await sync(a, adapter, clock);

    const merged = await getRecord(a, 'catalog');
    assert.deepEqual(merged.items.map((/** @type {any} */ i) => i.key), ['flour', 'paper-towels']);
    assert.equal(merged.items[0]?.useCount, 5);
  });
});

test('repeated syncing settles instead of ping-ponging', { skip: browserOnly }, async () => {
  await withTwoDevices(async (a, b, adapter) => {
    await saveLocal(a, 'list', shoppingList([item({ id: 'a' })]));
    await saveLocal(b, 'list', shoppingList([item({ id: 'b', sort: 200 })]));

    await sync(a, adapter, clock);
    await sync(b, adapter, clock);
    await sync(a, adapter, clock);
    await sync(b, adapter, clock);

    const quietA = await sync(a, adapter, clock);
    const quietB = await sync(b, adapter, clock);

    assert.equal(quietA.pushed, 0, 'A has nothing left to say');
    assert.equal(quietB.pushed, 0, 'B has nothing left to say');
    assert.equal(quietA.errors.length, 0);
    assert.equal(quietB.errors.length, 0);

    const fromA = await getRecord(a, 'list', 'l1');
    const fromB = await getRecord(b, 'list', 'l1');
    assert.deepEqual(fromA, fromB, 'both devices converged on the same list');
    assert.equal(fromA.items.length, 2);
  });
});
