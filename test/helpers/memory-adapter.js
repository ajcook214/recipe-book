// @ts-check
import { NotFoundError, VersionConflictError } from '../../src/core/errors.js';

/**
 * An in-memory StorageAdapter, used to exercise sync without a filesystem or a
 * network. It is also the reference implementation of the adapter contract:
 * DriveAdapter and LocalFolderAdapter have to behave the same way, and where
 * they cannot, the difference belongs in a comment here. The contract itself
 * is written out, and tested, in adapter-contract.js.
 *
 * Timestamps come from a counter rather than the clock, so tests are
 * deterministic and ordering is never flaky.
 */

/**
 * @typedef {object} StoredFile
 * @property {any} data
 * @property {string} version
 * @property {string} modifiedTime
 */

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * @param {{ seed?: Record<string, any> }} [options]
 */
export function createMemoryAdapter(options = {}) {
  /** @type {Map<string, StoredFile>} */
  const files = new Map();

  let tick = 0;
  let versionCounter = 0;

  /** Each mutation advances the clock by a second, so mtimes strictly increase. */
  function stamp() {
    tick += 1;
    return new Date(EPOCH + tick * 1000).toISOString();
  }

  function nextVersion() {
    versionCounter += 1;
    return `v${versionCounter}`;
  }

  /** @param {any} value */
  function clone(value) {
    return structuredClone(value);
  }

  const calls = { list: 0, read: 0, write: 0, remove: 0 };

  /** @type {{ writes: Map<string, number> }} */
  const failures = { writes: new Map() };

  const adapter = {
    /**
     * @param {string} [prefix]
     * @param {{ modifiedSince?: string|null }} [opts]
     * @returns {Promise<Array<{ path: string, modifiedTime: string, version: string }>>}
     */
    async list(prefix = '', opts = {}) {
      calls.list += 1;
      const since = opts.modifiedSince ? Date.parse(opts.modifiedSince) : null;

      const entries = [];
      for (const [path, file] of files) {
        if (prefix && !path.startsWith(prefix)) continue;
        if (since !== null && Date.parse(file.modifiedTime) <= since) continue;
        entries.push({ path, modifiedTime: file.modifiedTime, version: file.version });
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return entries;
    },

    /**
     * @param {string} path
     * @returns {Promise<any>}
     */
    async read(path) {
      calls.read += 1;
      const file = files.get(path);
      if (!file) throw new NotFoundError(path);
      return clone(file.data);
    },

    /**
     * @param {string} path
     * @param {any} data
     * @param {{ expectedVersion?: string|null }} [opts]
     * @returns {Promise<{ version: string, modifiedTime: string }>}
     */
    async write(path, data, opts = {}) {
      calls.write += 1;

      const forced = failures.writes.get(path);
      if (forced !== undefined) {
        if (forced <= 1) failures.writes.delete(path);
        else failures.writes.set(path, forced - 1);
        throw new Error(`Injected write failure for ${path}`);
      }

      const existing = files.get(path);
      // Tested against `undefined` rather than with `in`: passing an explicit
      // `expectedVersion: undefined` has to mean "unconditional", the same as
      // omitting it. Using `in` would quietly turn it into `null`, which means
      // the opposite - "expect no file here".
      if (opts.expectedVersion !== undefined) {
        const expected = opts.expectedVersion;
        const actual = existing?.version ?? null;
        if (expected !== actual) throw new VersionConflictError(path, expected, actual);
      }

      const stored = { data: clone(data), version: nextVersion(), modifiedTime: stamp() };
      files.set(path, stored);
      return { version: stored.version, modifiedTime: stored.modifiedTime };
    },

    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    async remove(path) {
      calls.remove += 1;
      files.delete(path);
    },

    // --- test-only surface, prefixed to keep it clearly out of the contract

    /**
     * Put a file in place as though it had always been there.
     * @param {string} path
     * @param {any} data
     * @returns {{ version: string, modifiedTime: string }}
     */
    _seed(path, data) {
      const stored = { data: clone(data), version: nextVersion(), modifiedTime: stamp() };
      files.set(path, stored);
      return { version: stored.version, modifiedTime: stored.modifiedTime };
    },

    /**
     * Change a file the way another device would, bumping version and mtime.
     * @param {string} path
     * @param {any} data
     * @returns {{ version: string, modifiedTime: string }}
     */
    _touch(path, data) {
      return adapter._seed(path, data);
    },

    /** @param {string} path @returns {any} */
    _read(path) {
      const file = files.get(path);
      return file ? clone(file.data) : undefined;
    },

    /** @param {string} path @returns {StoredFile|undefined} */
    _meta(path) {
      const file = files.get(path);
      return file ? { ...file, data: clone(file.data) } : undefined;
    },

    /** @returns {string[]} */
    _paths() {
      return [...files.keys()].sort();
    },

    /** @param {string} path @param {number} [times] */
    _failWrites(path, times = 1) {
      failures.writes.set(path, times);
    },

    _calls() {
      return { ...calls };
    },
  };

  for (const [path, data] of Object.entries(options.seed ?? {})) {
    adapter._seed(path, data);
  }

  return adapter;
}

/** @typedef {ReturnType<typeof createMemoryAdapter>} MemoryAdapter */
