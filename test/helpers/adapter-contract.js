// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NotFoundError, VersionConflictError } from '../../src/core/errors.js';

/**
 * The StorageAdapter contract. This file is the specification adapters are
 * written against, and every adapter runs it:
 *
 *   test/adapter-contract.test.js   the in-memory reference implementation
 *   test/drive-adapter.test.js      DriveAdapter over a fake Drive
 *   test/drive/                     DriveAdapter over real Google Drive
 *
 * Only the public interface is used, so the same tests hold against a network
 * service. Files are put in place with an unconditional write.
 *
 * Contract:
 *   list(prefix, { modifiedSince }) -> [{ path, modifiedTime, version }]
 *       Every file whose path starts with `prefix`, sorted by path. When
 *       `modifiedSince` is set, only files modified strictly after it.
 *   read(path)  -> the parsed JSON document. Throws NotFoundError.
 *   write(path, data, { expectedVersion }) -> { version, modifiedTime }
 *       expectedVersion: a string means the stored version must match exactly;
 *       null means the caller expects no file to exist yet; undefined means
 *       write unconditionally. A mismatch throws VersionConflictError, which
 *       is the check that stops a push from clobbering a newer remote edit.
 *   remove(path) -> void. Silent when already absent.
 *
 * @typedef {object} ContractTarget
 * @property {() => any} create  An adapter over empty storage.
 * @property {(adapter: any) => any} [sibling]
 *   A second device on the same storage as `adapter`, with nothing cached.
 *   An adapter that caches nothing can pass itself back.
 * @property {() => Promise<void>} [settle]
 *   Waits long enough for a real service to finish anything it does in the
 *   background after a write. Instant by default.
 */

const DOC = { id: 'r1', updatedAt: '2026-09-20T10:00:00.000Z', title: 'Chili' };
const PATH = 'recipes/r1.json';

/**
 * @param {string} label  prefixed to each test name
 * @param {ContractTarget} target
 */
export function adapterContract(label, target) {
  const { create } = target;
  const sibling = target.sibling ?? ((/** @type {any} */ adapter) => adapter);
  const settle = target.settle ?? (async () => {});

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const check = (name, fn) => test(`${label}: ${name}`, fn);

  // --- list ----------------------------------------------------------------

  check('list returns every file, sorted by path', async () => {
    const adapter = create();
    await adapter.write('recipes/b.json', DOC);
    await adapter.write('catalog.json', DOC);
    await adapter.write('recipes/a.json', DOC);

    const paths = (await adapter.list()).map((/** @type {any} */ e) => e.path);
    assert.deepEqual(paths, ['catalog.json', 'recipes/a.json', 'recipes/b.json']);
  });

  check('list entries carry a path, a version and a modifiedTime', async () => {
    const adapter = create();
    const written = await adapter.write(PATH, DOC);

    const [entry] = await adapter.list();
    assert.equal(entry?.path, PATH);
    assert.equal(entry?.version, written.version);
    assert.equal(entry?.modifiedTime, written.modifiedTime);
  });

  check('list narrows to a prefix', async () => {
    const adapter = create();
    await adapter.write(PATH, DOC);
    await adapter.write('lists/l1.json', DOC);

    const paths = async (/** @type {string} */ prefix) =>
      (await adapter.list(prefix)).map((/** @type {any} */ e) => e.path);
    assert.deepEqual(await paths('recipes/'), [PATH]);
    assert.deepEqual(await paths('lists/l1.json'), ['lists/l1.json']);
    assert.deepEqual(await paths('nothing/'), []);
  });

  check('modifiedSince is exclusive', async () => {
    const adapter = create();
    const first = await adapter.write('recipes/a.json', DOC);
    const second = await adapter.write('recipes/b.json', DOC);

    const since = await adapter.list('', { modifiedSince: first.modifiedTime });
    assert.deepEqual(since.map((/** @type {any} */ e) => e.path), ['recipes/b.json'], 'the boundary file is excluded');

    const all = await adapter.list('', { modifiedSince: null });
    assert.equal(all.length, 2, 'a null watermark means everything');
    assert.equal((await adapter.list('', { modifiedSince: second.modifiedTime })).length, 0);
  });

  // --- read ----------------------------------------------------------------

  check('read returns the stored document', async () => {
    const adapter = create();
    await adapter.write(PATH, DOC);
    assert.deepEqual(await adapter.read(PATH), DOC);
  });

  check('read throws NotFoundError for a missing path', async () => {
    const adapter = create();
    await assert.rejects(() => adapter.read('recipes/nope.json'), NotFoundError);
  });

  check('read hands back a copy, not the stored object', async () => {
    const adapter = create();
    await adapter.write(PATH, DOC);
    const got = await adapter.read(PATH);
    got.title = 'Mutated';
    assert.equal((await adapter.read(PATH)).title, 'Chili');
  });

  // --- write ---------------------------------------------------------------

  check('write creates a file and reports its version', async () => {
    const adapter = create();
    const written = await adapter.write(PATH, DOC, { expectedVersion: null });

    assert.ok(written.version);
    assert.ok(written.modifiedTime);
    assert.deepEqual(await adapter.read(PATH), DOC);
  });

  check('write stores a copy, so later mutation of the input cannot leak in', async () => {
    const adapter = create();
    const doc = { ...DOC };
    await adapter.write(PATH, doc, { expectedVersion: null });
    doc.title = 'Changed After Writing';
    assert.equal((await adapter.read(PATH)).title, 'Chili');
  });

  check('each write advances both version and modifiedTime', async () => {
    const adapter = create();
    const first = await adapter.write(PATH, DOC, { expectedVersion: null });
    const second = await adapter.write(PATH, DOC, { expectedVersion: first.version });

    assert.notEqual(first.version, second.version);
    assert.ok(Date.parse(second.modifiedTime) > Date.parse(first.modifiedTime));
  });

  check('a matching expectedVersion is accepted', async () => {
    const adapter = create();
    const seeded = await adapter.write(PATH, DOC);
    const written = await adapter.write(PATH, { ...DOC, title: 'Updated' }, { expectedVersion: seeded.version });
    assert.notEqual(written.version, seeded.version);
    assert.equal((await adapter.read(PATH)).title, 'Updated');
  });

  check('a stale expectedVersion is rejected', async () => {
    const adapter = create();
    const seeded = await adapter.write(PATH, DOC);
    const current = await adapter.write(PATH, { ...DOC, title: 'Newer' });

    await assert.rejects(() => adapter.write(PATH, DOC, { expectedVersion: seeded.version }), VersionConflictError);
    assert.equal((await adapter.read(PATH)).title, 'Newer', 'the rejected write must not have landed');
    const [entry] = await adapter.list(PATH);
    assert.equal(entry?.version, current.version);
  });

  check('only a write moves the version', async () => {
    // Sync stores the version a push or a pull saw, and checks the next push
    // against it. A version that moved by itself would turn every later push
    // into a conflict. Real Drive's own `version` field does exactly that.
    const adapter = create();
    const seeded = await adapter.write(PATH, DOC);
    const written = await adapter.write(PATH, { ...DOC, title: 'Updated' }, { expectedVersion: seeded.version });

    await adapter.read(PATH);
    await adapter.list();
    await settle();
    await adapter.read(PATH);

    const [entry] = await adapter.list(PATH);
    assert.equal(entry?.version, written.version, 'reading, listing and waiting moved the version');
    await adapter.write(PATH, DOC, { expectedVersion: written.version });
  });

  check('expectedVersion null means the caller expects no file yet', async () => {
    const adapter = create();
    await adapter.write(PATH, DOC);
    await assert.rejects(() => adapter.write(PATH, DOC, { expectedVersion: null }), VersionConflictError);
  });

  check('expectedVersion undefined writes unconditionally', async () => {
    // Distinct from null. Passing undefined explicitly must behave the same as
    // omitting the option, or a caller spreading an optional value silently gets
    // the "expect no file" rule instead.
    const adapter = create();
    await adapter.write(PATH, DOC);

    await adapter.write(PATH, { ...DOC, title: 'Forced' }, { expectedVersion: undefined });
    assert.equal((await adapter.read(PATH)).title, 'Forced');

    await adapter.write(PATH, { ...DOC, title: 'Also Forced' }, {});
    assert.equal((await adapter.read(PATH)).title, 'Also Forced');
  });

  check('a version conflict reports what was expected and what was found', async () => {
    const adapter = create();
    const seeded = await adapter.write(PATH, DOC);

    await assert.rejects(
      () => adapter.write(PATH, DOC, { expectedVersion: 'bogus' }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof VersionConflictError);
        assert.equal(err.path, PATH);
        assert.equal(err.expected, 'bogus');
        assert.equal(err.actual, seeded.version);
        return true;
      },
    );
  });

  // --- remove --------------------------------------------------------------

  check('remove deletes a file', async () => {
    const adapter = create();
    await adapter.write(PATH, DOC);
    await adapter.remove(PATH);
    assert.deepEqual(await adapter.list(), []);
    await assert.rejects(() => adapter.read(PATH), NotFoundError);
  });

  check('removing a missing file is silent', async () => {
    const adapter = create();
    await adapter.remove('recipes/nope.json');
    assert.deepEqual(await adapter.list(), []);
  });

  // --- another device ------------------------------------------------------
  //
  // What the version check is for. An adapter that remembers anything between
  // calls - DriveAdapter keeps a path index - must still see what another
  // device did since.

  check("another device's write is caught by the version check", async () => {
    const here = create();
    const first = await here.write(PATH, DOC);
    await here.list();

    const theirs = await sibling(here).write(PATH, { ...DOC, title: 'From Elsewhere' }, {
      expectedVersion: first.version,
    });

    await assert.rejects(
      () => here.write(PATH, DOC, { expectedVersion: first.version }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof VersionConflictError);
        assert.equal(err.actual, theirs.version);
        return true;
      },
    );
    assert.equal((await here.read(PATH)).title, 'From Elsewhere');
  });

  check('a file another device created is caught by expectedVersion null', async () => {
    // A neighbour first, so this device already knows the folder, as it will
    // after the first sync. Then only a lookup of this one file can find it.
    const here = create();
    await here.write('recipes/r0.json', DOC);
    await here.list();

    const theirs = await sibling(here).write(PATH, DOC);

    await assert.rejects(
      () => here.write(PATH, { ...DOC, title: 'Mine' }, { expectedVersion: null }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof VersionConflictError);
        assert.equal(err.actual, theirs.version);
        return true;
      },
    );
    assert.deepEqual((await here.list()).map((/** @type {any} */ e) => e.path), ['recipes/r0.json', PATH]);
    assert.deepEqual(await here.read(PATH), DOC);
  });

  check('a file another device created in a new folder is caught too', async () => {
    const here = create();
    assert.deepEqual(await here.list(), []);

    const theirs = await sibling(here).write(PATH, DOC);

    await assert.rejects(
      () => here.write(PATH, { ...DOC, title: 'Mine' }, { expectedVersion: null }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof VersionConflictError);
        assert.equal(err.actual, theirs.version);
        return true;
      },
    );
  });

  check('a file another device removed is gone here too', async () => {
    const here = create();
    const written = await here.write(PATH, DOC);
    await here.list();

    await sibling(here).remove(PATH);

    // Sync relies on this: a push that finds the file gone gets a conflict
    // reporting no file, and writes its copy back as a creation.
    await assert.rejects(
      () => here.write(PATH, DOC, { expectedVersion: written.version }),
      (/** @type {any} */ err) => {
        assert.ok(err instanceof VersionConflictError);
        assert.equal(err.actual, null);
        return true;
      },
    );
    assert.deepEqual(await here.list(), []);
    await assert.rejects(() => here.read(PATH), NotFoundError);
  });
}
