// @ts-check

/**
 * The manual sync step: reconcile the IndexedDB working copy with a
 * StorageAdapter.
 *
 * Nothing here runs on a timer or in the background. The user taps Sync, this
 * runs once, and then they are back to working offline against local data.
 *
 * Order matters. Pull first, so that local dirty records are merged against
 * the newest remote content before we try to push them. Pushing first would
 * mean either clobbering a remote edit or failing the version check and having
 * to pull anyway.
 *
 * @typedef {import('./db.js').RecordType} RecordType
 * @typedef {import('./db.js').Envelope} Envelope
 */

import {
  countDirty,
  getEnvelope,
  getMeta,
  idOf,
  listDirty,
  markSynced,
  pathFor,
  saveFromSync,
  setMeta,
  typeForPath,
} from './db.js';
import { isSame, mergeCatalog, mergeList, mergeRecipe } from './merge.js';
import { isAuthError, isNotFound, isVersionConflict, messageOf } from './errors.js';

export const LAST_SYNC_KEY = 'lastSync';

/** @type {Record<RecordType, (local: any, remote: any) => any>} */
const MERGERS = {
  recipe: mergeRecipe,
  list: mergeList,
  catalog: mergeCatalog,
};

/**
 * @typedef {object} SyncError
 * @property {'list'|'pull'|'push'} phase
 * @property {string} path
 * @property {string} message
 */

/**
 * @typedef {object} SyncResult
 * @property {number} pulled     Remote files merged into the working copy.
 * @property {number} pushed     Local records written to storage.
 * @property {number} skipped    Remote files the working copy does not mirror.
 * @property {string[]} conflicts        Paths where a push lost the version
 *                                       check and had to be re-merged.
 * @property {SyncError[]} errors
 * @property {string|null} lastSync      New watermark, or the old one.
 * @property {number} dirtyRemaining     Still pending after this run.
 */

/**
 * Later of two timestamps, either of which may be missing.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {string|null}
 */
function maxIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Guard against a record whose id disagrees with the path it arrived at. These
 * files are meant to be hand-editable, so a copied file with a stale id inside
 * is a realistic mistake - and writing it back would silently land it at a
 * different path than the one it came from.
 *
 * @param {RecordType} type
 * @param {any} record
 * @param {string} path
 * @returns {void}
 */
function assertPathMatchesRecord(type, record, path) {
  const expected = pathFor(type, idOf(type, record));
  if (expected !== path) {
    throw new Error(`Record id points at ${expected}, but the file is at ${path}`);
  }
}

/**
 * Re-merge and retry a push that lost the version check.
 *
 * @param {IDBDatabase} db
 * @param {any} adapter
 * @param {Envelope} env
 * @param {string} syncedAt
 * @returns {Promise<string|null>} the new remote modifiedTime
 */
async function resolveConflict(db, adapter, env, syncedAt) {
  let remoteRecord = null;
  /** @type {string|null} */
  let currentVersion = null;

  try {
    remoteRecord = await adapter.read(env.path);
    const [entry] = await adapter.list(env.path, {});
    currentVersion = entry?.version ?? null;
  } catch (err) {
    // Deleted remotely while we held a version. Our copy is all there is, so
    // write it back as a creation.
    if (!isNotFound(err)) throw err;
  }

  const merged = MERGERS[env.type](env.record, remoteRecord);
  const written = await adapter.write(env.path, merged, { expectedVersion: currentVersion });

  await saveFromSync(db, env.type, merged, {
    version: written?.version ?? null,
    modifiedTime: written?.modifiedTime ?? null,
    syncedAt,
    dirty: 0,
  });

  return written?.modifiedTime ?? null;
}

/**
 * Run one sync pass.
 *
 * Rejects with an AuthError when storage refuses the sign-in part way
 * through, instead of recording it against every remaining file. What was
 * already pulled or pushed stays done; the watermark is not advanced, so the
 * next pass re-reads from where this one started, which merging makes
 * harmless.
 *
 * @param {IDBDatabase} db
 * @param {any} adapter
 * @param {{ now?: () => string }} [options]
 * @returns {Promise<SyncResult>}
 */
export async function sync(db, adapter, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const syncedAt = now();

  /** @type {SyncResult} */
  const result = {
    pulled: 0,
    pushed: 0,
    skipped: 0,
    conflicts: [],
    errors: [],
    lastSync: null,
    dirtyRemaining: 0,
  };

  /** @type {string|null} */
  const previous = (await getMeta(db, LAST_SYNC_KEY)) ?? null;

  // The watermark advances only to timestamps storage actually reported, never
  // to this device's clock. Two devices with skewed clocks would otherwise
  // skip each other's changes on the next pull.
  let watermark = previous;

  // --- 1. Pull -------------------------------------------------------------

  /** @type {Array<{ path: string, modifiedTime: string, version: string }>} */
  let entries = [];
  try {
    entries = await adapter.list('', { modifiedSince: previous });
  } catch (err) {
    if (isAuthError(err)) throw err;
    result.errors.push({ phase: 'list', path: '', message: messageOf(err) });
    result.lastSync = previous;
    result.dirtyRemaining = await countDirty(db);
    return result;
  }

  for (const entry of entries) {
    const type = typeForPath(entry.path);
    if (!type) {
      // manifest.json, images/, anything else the working copy does not mirror.
      result.skipped += 1;
      continue;
    }

    try {
      const remoteRecord = await adapter.read(entry.path);
      assertPathMatchesRecord(type, remoteRecord, entry.path);

      const local = await getEnvelope(db, entry.path);
      const merged = MERGERS[type](local?.record ?? null, remoteRecord);
      if (merged === null) {
        result.skipped += 1;
        continue;
      }

      // If the merge produced exactly what storage holds, we are in sync.
      // Anything else - a local edit that survived, a per-item union - still
      // has to be pushed, but it keeps the version we just merged against so
      // the push does not immediately fail its version check.
      const needsPush = !isSame(merged, remoteRecord);

      await saveFromSync(db, type, merged, {
        version: entry.version,
        modifiedTime: entry.modifiedTime,
        syncedAt,
        dirty: needsPush ? 1 : 0,
      });

      result.pulled += 1;
      watermark = maxIso(watermark, entry.modifiedTime);
    } catch (err) {
      if (isAuthError(err)) throw err;
      result.errors.push({ phase: 'pull', path: entry.path, message: messageOf(err) });
    }
  }

  // --- 2. Push -------------------------------------------------------------

  for (const env of await listDirty(db)) {
    try {
      const written = await adapter.write(env.path, env.record, {
        expectedVersion: env.version,
      });
      await markSynced(db, env.path, {
        version: written?.version ?? null,
        modifiedTime: written?.modifiedTime ?? null,
        syncedAt,
      });
      result.pushed += 1;
      watermark = maxIso(watermark, written?.modifiedTime);
    } catch (err) {
      if (isAuthError(err)) throw err;
      if (!isVersionConflict(err)) {
        result.errors.push({ phase: 'push', path: env.path, message: messageOf(err) });
        continue;
      }

      // Someone changed this file between our pull and our push.
      result.conflicts.push(env.path);
      try {
        const modifiedTime = await resolveConflict(db, adapter, env, syncedAt);
        result.pushed += 1;
        watermark = maxIso(watermark, modifiedTime);
      } catch (retryErr) {
        if (isAuthError(retryErr)) throw retryErr;
        // Leave it dirty. It will be retried on the next sync.
        result.errors.push({ phase: 'push', path: env.path, message: messageOf(retryErr) });
      }
    }
  }

  // --- 3. Record the watermark --------------------------------------------

  if (watermark && watermark !== previous) {
    await setMeta(db, LAST_SYNC_KEY, watermark);
  }
  result.lastSync = watermark;
  result.dirtyRemaining = await countDirty(db);

  return result;
}
