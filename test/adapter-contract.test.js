// @ts-check
import { adapterContract } from './helpers/adapter-contract.js';
import { createMemoryAdapter } from './helpers/memory-adapter.js';

/**
 * The StorageAdapter contract (test/helpers/adapter-contract.js), exercised
 * against the in-memory reference implementation. DriveAdapter runs the same
 * tests in drive-adapter.test.js.
 *
 * No IndexedDB here, so this suite runs under Node as well as in the browser.
 */

adapterContract('memory', {
  create: () => createMemoryAdapter(),
  // Nothing is cached, so another device is the same object.
});
