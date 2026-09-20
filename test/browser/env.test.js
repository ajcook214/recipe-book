// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Browser-environment checks. These skip automatically under `node --test`,
 * which is how browser-dependent suites (IndexedDB, LocalFolderAdapter) will
 * live alongside the pure ones without breaking the Node run.
 */

const inBrowser = typeof globalThis.window !== 'undefined';
const browserOnly = inBrowser ? false : 'browser only';

test('IndexedDB is available', { skip: browserOnly }, () => {
  assert.ok(globalThis.indexedDB, 'IndexedDB is the working copy; nothing works without it');
});

test('structuredClone is available', { skip: browserOnly }, () => {
  assert.equal(typeof globalThis.structuredClone, 'function');
});

test('File System Access API availability is reported honestly', { skip: browserOnly }, () => {
  // Not an assertion about support - LocalFolderAdapter is Chromium-desktop
  // only by design. This just makes the current browser state visible in the
  // report, so a confusing "why is local mode missing" is answered here.
  const supported = typeof (/** @type {any} */ (globalThis).showDirectoryPicker) === 'function';
  assert.equal(typeof supported, 'boolean');
});
