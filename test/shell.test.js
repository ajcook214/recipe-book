// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

/*
 * The service worker caches a hand-kept list of files. One missing from it
 * still works online and only breaks with no signal, which is exactly when it
 * cannot be fixed. One listed but gone makes installing fail, so nothing is
 * cached at all. Both are silent until you are in a shop.
 *
 * Node only (it reads the file system), so it is not in the browser SUITES.
 */

const root = new URL('../', import.meta.url);

/** @returns {string[]} */
function listedInWorker() {
  const source = readFileSync(new URL('sw.js', root), 'utf8');
  const block = source.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js should declare `const SHELL = [...]`');
  return [.../** @type {string} */ (block[1]).matchAll(/'([^']+)'/g)].map((m) => /** @type {string} */ (m[1]));
}

/**
 * @param {string} dir  relative to the repo root, with a trailing slash
 * @returns {string[]}
 */
function filesUnder(dir) {
  return readdirSync(new URL(dir, root), { recursive: true })
    .map((name) => dir + String(name).replaceAll('\\', '/'))
    .filter((path) => statSync(new URL(path, root)).isFile())
    // Gitignored dev overrides never reach Pages, so they cannot be cached.
    .filter((path) => !path.endsWith('.local.js'));
}

test('the service worker caches every file the app is made of, and nothing else', () => {
  const listed = listedInWorker();
  const expected = [
    'index.html',
    'styles.css',
    'manifest.webmanifest',
    ...filesUnder('icons/'),
    ...filesUnder('src/'),
  ];

  const missing = expected.filter((path) => !listed.includes(path));
  const gone = listed.filter((path) => !expected.includes(path));
  assert.deepEqual(missing, [], 'add these to SHELL in sw.js, or the app will not open offline');
  assert.deepEqual(gone, [], 'remove these from SHELL in sw.js, or the worker will fail to install');
  assert.equal(new Set(listed).size, listed.length, 'SHELL lists a file twice');
});

test('everything index.html loads is in the cached shell', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const refs = [...html.matchAll(/\b(?:href|src)="([^"#:]+)"/g)].map((m) => /** @type {string} */ (m[1]));
  assert.ok(refs.length >= 4, 'expected index.html to reference its stylesheet, script, manifest and icons');
  const listed = listedInWorker();
  assert.deepEqual(
    refs.filter((ref) => !listed.includes(ref)),
    [],
    'index.html loads these, but the worker does not cache them',
  );
});
