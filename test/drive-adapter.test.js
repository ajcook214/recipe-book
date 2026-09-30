// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriveAdapter } from '../src/adapters/drive.js';
import { AuthError } from '../src/core/errors.js';
import { adapterContract } from './helpers/adapter-contract.js';
import { createFakeDrive } from './helpers/fake-drive.js';

/**
 * DriveAdapter over a fake Drive (helpers/fake-drive.js). First the shared
 * adapter contract, then what only Drive has: folders, duplicate names,
 * paged listings, the trash, tokens and rate limits.
 *
 * The same contract runs against real Drive at test/drive/, which needs a
 * Google sign-in, so it is run by hand.
 *
 * @typedef {import('./helpers/fake-drive.js').FakeDrive} FakeDrive
 */

/** @type {WeakMap<object, { drive: FakeDrive, root: string|undefined }>} */
const made = new WeakMap();

/**
 * @param {FakeDrive} drive
 * @param {Partial<import('../src/adapters/drive.js').DriveAdapterOptions>} [options]
 */
function adapterOn(drive, options = {}) {
  const adapter = createDriveAdapter({
    getToken: () => 'token',
    fetch: drive.fetch,
    sleep: async () => {},
    ...options,
  });
  made.set(adapter, { drive, root: options.root });
  return adapter;
}

adapterContract('drive (fake)', {
  create: () => adapterOn(createFakeDrive()),
  sibling: (adapter) => {
    const origin = made.get(adapter);
    assert.ok(origin);
    return adapterOn(origin.drive, { root: origin.root });
  },
});

const DOC = { id: 'r1', updatedAt: '2026-09-20T10:00:00.000Z', title: 'Chili' };
const PATH = 'recipes/r1.json';

/** @param {any} adapter @returns {Promise<string[]>} */
async function paths(adapter) {
  return (await adapter.list()).map((/** @type {any} */ e) => e.path);
}

// --- layout ----------------------------------------------------------------

test('drive: files land in RecipeApp/ as JSON a person can read', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  await adapter.write(PATH, DOC);
  await adapter.write('catalog.json', DOC);

  const file = drive.find('RecipeApp/recipes/r1.json');
  assert.equal(file?.mimeType, 'application/json');
  assert.equal(file?.content, `${JSON.stringify(DOC, null, 2)}\n`);
  assert.ok(drive.find('RecipeApp/catalog.json'));
  assert.deepEqual(drive.find('RecipeApp')?.parents, ['root'], 'the app folder is at the top of My Drive');
});

test('drive: folders are made once and reused, by every device', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  await adapter.write('recipes/a.json', DOC);
  await adapter.write('recipes/b.json', DOC);
  await adapterOn(drive).write('recipes/c.json', DOC);

  assert.deepEqual(drive.folders(), ['RecipeApp', 'RecipeApp/recipes']);
});

test('drive: a folder another device made since the last listing is used, not duplicated', async () => {
  const drive = createFakeDrive();
  const here = adapterOn(drive);
  await here.write('catalog.json', DOC);

  await adapterOn(drive).write('recipes/a.json', DOC);
  await here.write('recipes/b.json', DOC);

  assert.deepEqual(drive.folders(), ['RecipeApp', 'RecipeApp/recipes']);
  assert.deepEqual(await paths(here), ['catalog.json', 'recipes/a.json', 'recipes/b.json']);
});

test('drive: only files under the root are listed, and a root can be nested', async () => {
  const drive = createFakeDrive();
  drive.add({ name: 'loose.json', content: '{}' });
  await adapterOn(drive, { root: 'Other' }).write(PATH, DOC);

  const nested = adapterOn(drive, { root: 'RecipeApp-tests/run-1' });
  await nested.write('catalog.json', DOC);
  assert.ok(drive.find('RecipeApp-tests/run-1/catalog.json'));

  const adapter = adapterOn(drive);
  assert.deepEqual(await paths(adapter), []);
  assert.deepEqual(await paths(nested), ['catalog.json']);
  assert.deepEqual(await paths(adapterOn(drive, { root: 'RecipeApp-tests' })), ['run-1/catalog.json']);
});

// --- duplicates --------------------------------------------------------------

test('drive: two folders with the same path read as one', async () => {
  const drive = createFakeDrive();
  const app = drive.add({ name: 'RecipeApp', folder: true });
  const older = drive.add({ name: 'recipes', parent: app.id, folder: true });
  const newer = drive.add({ name: 'recipes', parent: app.id, folder: true });
  drive.add({ name: 'a.json', parent: older.id, content: JSON.stringify(DOC) });
  drive.add({ name: 'b.json', parent: newer.id, content: JSON.stringify(DOC) });

  const adapter = adapterOn(drive);
  assert.deepEqual(await paths(adapter), ['recipes/a.json', 'recipes/b.json']);

  await adapter.write('recipes/c.json', DOC);
  assert.deepEqual(drive.find('RecipeApp/recipes/c.json')?.parents, [older.id], 'new files go in the older folder');
});

test('drive: when two files share a path, every device uses the one made first', async () => {
  const drive = createFakeDrive();
  const app = drive.add({ name: 'RecipeApp', folder: true });
  const here = adapterOn(drive);
  await here.list();

  // Made after `here` listed, so its write has to find them by name.
  const older = drive.add({ name: 'catalog.json', parent: app.id, content: JSON.stringify({ ...DOC, title: 'Older' }) });
  const newer = drive.add({ name: 'catalog.json', parent: app.id, content: JSON.stringify({ ...DOC, title: 'Newer' }) });

  await here.write('catalog.json', { ...DOC, title: 'Updated' });
  assert.equal(JSON.parse(older.content).title, 'Updated');
  assert.equal(JSON.parse(newer.content).title, 'Newer', 'the later copy is left alone');

  const fresh = adapterOn(drive);
  assert.equal((await fresh.read('catalog.json')).title, 'Updated', 'a device listing from scratch agrees');
  assert.equal((await fresh.list())[0]?.version, older.headRevisionId);
});

// --- requests ----------------------------------------------------------------

test('drive: the version is fetched immediately before the upload', async () => {
  // Drive has no conditional write, so this gap is the one a concurrent
  // write can slip through. Nothing may sit between the check and the upload.
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  const first = await adapter.write(PATH, DOC);
  await adapter.list();
  const id = drive.find('RecipeApp/recipes/r1.json')?.id;

  drive.requests.length = 0;
  await adapter.write(PATH, DOC, { expectedVersion: first.version });
  assert.deepEqual(drive.requests, [`GET files/${id}`, `PATCH upload/${id}`]);
});

test('drive: a listing that runs to several pages is read in full', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  for (const name of ['a', 'b', 'c', 'd', 'e']) await adapter.write(`recipes/${name}.json`, DOC);

  drive.pageLimit = 2;
  drive.requests.length = 0;
  assert.equal((await adapterOn(drive).list()).length, 5);
  assert.equal(drive.requests.length, 4, 'seven files and folders, two to a page');
});

test('drive: remove moves the file to the trash, where it can be recovered', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  await adapter.write(PATH, DOC);
  await adapter.remove(PATH);

  const file = drive.find('RecipeApp/recipes/r1.json');
  assert.equal(file?.trashed, true);
  assert.deepEqual(JSON.parse(file?.content ?? ''), DOC, 'the content is still there');
  assert.deepEqual(await paths(adapterOn(drive)), []);
});

test('drive: a file that is not valid JSON names itself in the error', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  await adapter.write(PATH, DOC);
  const file = drive.find('RecipeApp/recipes/r1.json');
  assert.ok(file);
  file.content = '{ "id": "r1", ';

  await assert.rejects(() => adapter.read(PATH), /recipes\/r1\.json is not valid JSON/);
});

// --- sign-in -----------------------------------------------------------------

test('drive: a refused token is an AuthError from every call, not retried', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  await adapter.write(PATH, DOC);

  const calls = [
    () => adapter.list(),
    () => adapter.read(PATH),
    () => adapter.write(PATH, DOC),
    () => adapter.remove(PATH),
  ];
  for (const call of calls) {
    // Only the next request fails. Had it been retried, the call would pass.
    drive.fail({ status: 401 });
    await assert.rejects(call, AuthError);
  }
});

test('drive: the token is asked for on every request, so a renewed one is used at once', async () => {
  const drive = createFakeDrive();
  let token = 'first';
  const adapter = adapterOn(drive, { getToken: () => token });
  await adapter.list();
  token = 'second';
  await adapter.write(PATH, DOC);

  assert.equal(drive.tokens[0], 'Bearer first');
  assert.ok(drive.tokens.length > 2);
  assert.ok(drive.tokens.slice(1).every((t) => t === 'Bearer second'));
});

// --- retries -----------------------------------------------------------------

test('drive: rate limits are waited out and retried', async () => {
  const drive = createFakeDrive();
  /** @type {number[]} */
  const waits = [];
  const adapter = adapterOn(drive, { sleep: async (ms) => void waits.push(ms) });

  drive.fail({ status: 429 });
  drive.fail({ status: 403, reason: 'userRateLimitExceeded' });
  await adapter.write(PATH, DOC);

  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(await adapter.read(PATH), DOC);
});

test('drive: a rate limit that does not lift fails the call', async () => {
  const drive = createFakeDrive();
  /** @type {number[]} */
  const waits = [];
  const adapter = adapterOn(drive, { sleep: async (ms) => void waits.push(ms) });

  for (let i = 0; i < 4; i += 1) drive.fail({ status: 429 });
  await assert.rejects(() => adapter.list(), /Google Drive 429/);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('drive: a permission refusal is not mistaken for a rate limit', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  drive.fail({ status: 403, reason: 'appNotAuthorizedToFile' });
  await assert.rejects(() => adapter.list(), /Google Drive 403 \(appNotAuthorizedToFile\)/, 'the reason is in the message');
  assert.equal(drive.requests.length, 1);
});

test('drive: an upload that fails on the server is not repeated', async () => {
  // It may have landed anyway. Uploading again could leave two files.
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  drive.fail({ status: 503, when: (_method, url) => url.pathname.startsWith('/upload/') });

  await assert.rejects(() => adapter.write(PATH, DOC), /Google Drive 503/);
  assert.equal(drive.requests.filter((r) => r.startsWith('POST upload')).length, 1);
});

test('drive: a read that fails on the server or the network is retried', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  await adapter.write(PATH, DOC);

  drive.fail({ status: 503 });
  drive.fail({ network: true });
  assert.deepEqual(await adapter.read(PATH), DOC);
});

test('drive: with no connection at all, the error says so', async () => {
  const drive = createFakeDrive();
  const adapter = adapterOn(drive);
  for (let i = 0; i < 4; i += 1) drive.fail({ network: true });
  await assert.rejects(() => adapter.list(), /Could not reach Google Drive/);
});
