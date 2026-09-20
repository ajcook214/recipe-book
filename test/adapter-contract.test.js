// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryAdapter } from './helpers/memory-adapter.js';
import { NotFoundError, VersionConflictError } from '../src/core/errors.js';

/**
 * The StorageAdapter contract, exercised against the in-memory reference
 * implementation. DriveAdapter and LocalFolderAdapter have to satisfy these
 * same expectations, so this file is the specification they are written
 * against - not just a test of the fake.
 *
 * No IndexedDB here, so this suite runs under Node as well as in the browser.
 */

const DOC = { id: 'r1', updatedAt: '2026-09-20T10:00:00.000Z', title: 'Chili' };

// --- list ------------------------------------------------------------------

test('list returns every file, sorted by path', async () => {
  const adapter = createMemoryAdapter();
  adapter._seed('recipes/b.json', DOC);
  adapter._seed('catalog.json', DOC);
  adapter._seed('recipes/a.json', DOC);

  const paths = (await adapter.list()).map((e) => e.path);
  assert.deepEqual(paths, ['catalog.json', 'recipes/a.json', 'recipes/b.json']);
});

test('list entries carry a path, a version and a modifiedTime', async () => {
  const adapter = createMemoryAdapter();
  const seeded = adapter._seed('recipes/r1.json', DOC);

  const [entry] = await adapter.list();
  assert.equal(entry?.path, 'recipes/r1.json');
  assert.equal(entry?.version, seeded.version);
  assert.equal(entry?.modifiedTime, seeded.modifiedTime);
});

test('list narrows to a prefix', async () => {
  const adapter = createMemoryAdapter();
  adapter._seed('recipes/r1.json', DOC);
  adapter._seed('lists/l1.json', DOC);

  assert.deepEqual((await adapter.list('recipes/')).map((e) => e.path), ['recipes/r1.json']);
  assert.deepEqual((await adapter.list('lists/l1.json')).map((e) => e.path), ['lists/l1.json']);
  assert.deepEqual(await adapter.list('nothing/'), []);
});

test('modifiedSince is exclusive', async () => {
  const adapter = createMemoryAdapter();
  const first = adapter._seed('recipes/a.json', DOC);
  const second = adapter._seed('recipes/b.json', DOC);

  const since = await adapter.list('', { modifiedSince: first.modifiedTime });
  assert.deepEqual(since.map((e) => e.path), ['recipes/b.json'], 'the boundary file is excluded');

  const all = await adapter.list('', { modifiedSince: null });
  assert.equal(all.length, 2, 'a null watermark means everything');
  assert.equal((await adapter.list('', { modifiedSince: second.modifiedTime })).length, 0);
});

// --- read ------------------------------------------------------------------

test('read returns the stored document', async () => {
  const adapter = createMemoryAdapter({ seed: { 'recipes/r1.json': DOC } });
  assert.deepEqual(await adapter.read('recipes/r1.json'), DOC);
});

test('read throws NotFoundError for a missing path', async () => {
  const adapter = createMemoryAdapter();
  await assert.rejects(() => adapter.read('recipes/nope.json'), NotFoundError);
});

test('read hands back a copy, not the stored object', async () => {
  const adapter = createMemoryAdapter({ seed: { 'recipes/r1.json': DOC } });
  const got = await adapter.read('recipes/r1.json');
  got.title = 'Mutated';
  assert.equal((await adapter.read('recipes/r1.json')).title, 'Chili');
});

// --- write -----------------------------------------------------------------

test('write creates a file and reports its version', async () => {
  const adapter = createMemoryAdapter();
  const written = await adapter.write('recipes/r1.json', DOC, { expectedVersion: null });

  assert.ok(written.version);
  assert.ok(written.modifiedTime);
  assert.deepEqual(await adapter.read('recipes/r1.json'), DOC);
});

test('write stores a copy, so later mutation of the input cannot leak in', async () => {
  const adapter = createMemoryAdapter();
  const doc = { ...DOC };
  await adapter.write('recipes/r1.json', doc, { expectedVersion: null });
  doc.title = 'Changed After Writing';
  assert.equal((await adapter.read('recipes/r1.json')).title, 'Chili');
});

test('each write advances both version and modifiedTime', async () => {
  const adapter = createMemoryAdapter();
  const first = await adapter.write('recipes/r1.json', DOC, { expectedVersion: null });
  const second = await adapter.write('recipes/r1.json', DOC, { expectedVersion: first.version });

  assert.notEqual(first.version, second.version);
  assert.ok(Date.parse(second.modifiedTime) > Date.parse(first.modifiedTime));
});

test('a matching expectedVersion is accepted', async () => {
  const adapter = createMemoryAdapter();
  const seeded = adapter._seed('recipes/r1.json', DOC);
  const written = await adapter.write(
    'recipes/r1.json',
    { ...DOC, title: 'Updated' },
    { expectedVersion: seeded.version },
  );
  assert.notEqual(written.version, seeded.version);
  assert.equal((await adapter.read('recipes/r1.json')).title, 'Updated');
});

test('a stale expectedVersion is rejected', async () => {
  const adapter = createMemoryAdapter();
  adapter._seed('recipes/r1.json', DOC);
  const current = adapter._touch('recipes/r1.json', { ...DOC, title: 'Newer' });

  await assert.rejects(
    () => adapter.write('recipes/r1.json', DOC, { expectedVersion: 'v1' }),
    VersionConflictError,
  );
  assert.equal(
    (await adapter.read('recipes/r1.json')).title,
    'Newer',
    'the rejected write must not have landed',
  );
  assert.equal(adapter._meta('recipes/r1.json')?.version, current.version);
});

test('expectedVersion null means the caller expects no file yet', async () => {
  const adapter = createMemoryAdapter();
  adapter._seed('recipes/r1.json', DOC);
  await assert.rejects(
    () => adapter.write('recipes/r1.json', DOC, { expectedVersion: null }),
    VersionConflictError,
  );
});

test('expectedVersion undefined writes unconditionally', async () => {
  // Distinct from null. Passing undefined explicitly must behave the same as
  // omitting the option, or a caller spreading an optional value silently gets
  // the "expect no file" rule instead.
  const adapter = createMemoryAdapter();
  adapter._seed('recipes/r1.json', DOC);

  await adapter.write('recipes/r1.json', { ...DOC, title: 'Forced' }, { expectedVersion: undefined });
  assert.equal((await adapter.read('recipes/r1.json')).title, 'Forced');

  await adapter.write('recipes/r1.json', { ...DOC, title: 'Also Forced' }, {});
  assert.equal((await adapter.read('recipes/r1.json')).title, 'Also Forced');
});

test('a version conflict reports what was expected and what was found', async () => {
  const adapter = createMemoryAdapter();
  const seeded = adapter._seed('recipes/r1.json', DOC);

  await assert.rejects(
    () => adapter.write('recipes/r1.json', DOC, { expectedVersion: 'bogus' }),
    (err) => {
      assert.ok(err instanceof VersionConflictError);
      assert.equal(err.path, 'recipes/r1.json');
      assert.equal(err.expected, 'bogus');
      assert.equal(err.actual, seeded.version);
      return true;
    },
  );
});

// --- remove ----------------------------------------------------------------

test('remove deletes a file', async () => {
  const adapter = createMemoryAdapter({ seed: { 'recipes/r1.json': DOC } });
  await adapter.remove('recipes/r1.json');
  assert.deepEqual(adapter._paths(), []);
  await assert.rejects(() => adapter.read('recipes/r1.json'), NotFoundError);
});

test('removing a missing file is silent', async () => {
  const adapter = createMemoryAdapter();
  await adapter.remove('recipes/nope.json');
  assert.deepEqual(adapter._paths(), []);
});
