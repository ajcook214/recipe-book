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
  forget,
  getEnvelope,
  getMeta,
  idOf,
  listDirty,
  listEnvelopes,
  markSynced,
  pathFor,
  saveFromSync,
  setMeta,
  typeForPath,
} from './db.js';
import { isPrunable, isSame, mergeCatalog, mergeList, mergeRecipe, pruneItems } from './merge.js';
import { isAuthError, isNotFound, isVersionConflict, messageOf } from './errors.js';

export const LAST_SYNC_KEY = 'lastSync';

/** Meta key for the SyncRun of the last pass that reached storage. */
export const LAST_RUN_KEY = 'lastRun';

/**
 * How long a delete is kept before it is dropped. Every device has to pull a
 * tombstone before it goes, or one still holding the record brings it back,
 * so this is how long a device can go without syncing and still hear about
 * a delete. It matches Drive's trash, where a dropped file then waits as long
 * again.
 */
export const KEEP_DELETES_DAYS = 30;

/** @type {Record<RecordType, (local: any, remote: any) => any>} */
const MERGERS = {
  recipe: mergeRecipe,
  list: mergeList,
  catalog: mergeCatalog,
};

/**
 * @typedef {object} SyncError
 * @property {'list'|'pull'|'push'|'prune'} phase
 * @property {string} path
 * @property {string} message
 */

/**
 * @typedef {object} SyncResult
 * @property {number} pulled     Remote files merged into the working copy.
 * @property {number} pushed     Local records written to storage.
 * @property {number} skipped    Remote files the working copy does not mirror.
 * @property {number} pruned     Old tombstones dropped: whole records, and
 *                               items on lists and in the catalog.
 * @property {string[]} conflicts        Paths where a push lost the version
 *                                       check and had to be re-merged.
 * @property {SyncError[]} errors
 * @property {string|null} lastSync      New watermark, or the old one.
 * @property {number} dirtyRemaining     Still pending after this run.
 */

/**
 * A SyncResult with the time it finished, by this device's clock. Stored
 * under LAST_RUN_KEY for the Sync screen; never used as a watermark.
 *
 * @typedef {SyncResult & { at: string }} SyncRun
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
 * Drop tombstones every device has had time to hear about, so deletes do not
 * pile up for ever. Only records with nothing waiting to be pushed are
 * touched: everything in them has reached storage.
 *
 * - A deleted recipe or list goes once it was deleted before the cutoff and
 *   its file has held the tombstone since before it too. That second time is
 *   storage's, so a delete pushed late still gets its full margin. The file
 *   is trashed only if storage still has the version this copy last saw; a
 *   file changed since, and somehow not pulled, is left alone.
 * - Deleted items on a list or in the catalog go once deleted before the
 *   cutoff. The record is saved without them, marked to push, and goes out
 *   with this pass. If storage moved on meanwhile, the push conflicts and
 *   re-merges as any other would.
 *
 * @param {IDBDatabase} db
 * @param {any} adapter
 * @param {number} cutoff  ms since the epoch
 * @param {SyncResult} result
 * @returns {Promise<void>}
 */
async function prune(db, adapter, cutoff, result) {
  /** @type {Envelope[]} */
  const gone = [];

  for (const type of /** @type {RecordType[]} */ (['recipe', 'list', 'catalog'])) {
    for (const env of await listEnvelopes(db, type)) {
      if (env.dirty) continue;

      if (env.record?.deleted === true) {
        const stored = env.remoteModifiedTime ? Date.parse(env.remoteModifiedTime) : NaN;
        if (isPrunable(env.record, cutoff) && stored < cutoff) gone.push(env);
        continue;
      }

      if (type === 'recipe' || !Array.isArray(env.record?.items)) continue;
      const pruned = pruneItems(env.record, cutoff);
      if (pruned === env.record) continue;
      result.pruned += env.record.items.length - pruned.items.length;
      await saveFromSync(db, type, pruned, {
        version: env.version,
        modifiedTime: env.remoteModifiedTime,
        syncedAt: env.syncedAt,
        dirty: 1,
      });
    }
  }

  if (!gone.length) return;

  // The pull listed only what changed since the watermark. Before trashing
  // anything, look at everything storage has.
  /** @type {Map<string, string>} */
  let versions;
  try {
    /** @type {Array<{ path: string, version: string }>} */
    const everything = await adapter.list('', {});
    versions = new Map(everything.map((e) => [e.path, e.version]));
  } catch (err) {
    if (isAuthError(err)) throw err;
    result.errors.push({ phase: 'prune', path: '', message: messageOf(err) });
    return;
  }

  for (const env of gone) {
    const version = versions.get(env.path);
    if (version !== undefined && version !== env.version) continue;
    try {
      await adapter.remove(env.path);
      await forget(db, env.path);
      result.pruned += 1;
    } catch (err) {
      if (isAuthError(err)) throw err;
      result.errors.push({ phase: 'prune', path: env.path, message: messageOf(err) });
    }
  }
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
 * A pass that reaches storage is recorded under LAST_RUN_KEY, whatever it
 * found. One that cannot list, or is refused, is not.
 *
 * Between pulling and pushing, deletes older than KEEP_DELETES_DAYS are
 * dropped (see prune), here and in storage.
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
    pruned: 0,
    conflicts: [],
    errors: [],
    lastSync: null,
    dirtyRemaining: 0,
  };

  const cutoff = Date.parse(syncedAt) - KEEP_DELETES_DAYS * 24 * 60 * 60 * 1000;

  /** @type {string|null} */
  const previous = (await getMeta(db, LAST_SYNC_KEY)) ?? null;

  // The watermark advances only to timestamps storage actually reported, never
  // to this device's clock. Two devices with skewed clocks would otherwise
  // skip each other's changes on the next pull.
  let watermark = previous;
  let pullFailed = false;

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
      // images/, or anything else the working copy does not mirror.
      result.skipped += 1;
      continue;
    }

    try {
      const remoteRecord = await adapter.read(entry.path);
      assertPathMatchesRecord(type, remoteRecord, entry.path);

      const local = await getEnvelope(db, entry.path);
      let merged = MERGERS[type](local?.record ?? null, remoteRecord);
      if (merged === null) {
        result.skipped += 1;
        continue;
      }

      // Another device may have pruned old tombstones from this file. Merging
      // would hand ours back to it, and its next prune would take them out
      // again, for ever. So they go here too, when this copy has nothing
      // waiting to be pushed: then every tombstone in either copy has
      // already reached storage.
      if (type !== 'recipe' && !local?.dirty && merged.deleted !== true && Array.isArray(merged.items)) {
        const pruned = pruneItems(merged, cutoff);
        result.pruned += merged.items.length - pruned.items.length;
        merged = pruned;
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
      pullFailed = true;
      result.errors.push({ phase: 'pull', path: entry.path, message: messageOf(err) });
    }
  }

  // --- 2. Prune ------------------------------------------------------------

  // Not after a failed pull: this copy may then be behind storage, and a
  // file is only trashed when it is known to hold the tombstone we have.
  if (!pullFailed) await prune(db, adapter, cutoff, result);

  // --- 3. Push -------------------------------------------------------------

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

  // --- 4. Record the watermark, and the pass -------------------------------

  // A file that failed to pull has to be listed again next time, and a newer
  // file pulled or pushed in this pass may have carried the watermark past
  // it. So it stays put. The next pass re-reads what this one merged, which
  // merging makes harmless, and a file that keeps failing keeps being reported.
  if (pullFailed) watermark = previous;

  if (watermark && watermark !== previous) {
    await setMeta(db, LAST_SYNC_KEY, watermark);
  }
  result.lastSync = watermark;
  result.dirtyRemaining = await countDirty(db);

  /** @type {SyncRun} */
  const run = { at: syncedAt, ...result };
  await setMeta(db, LAST_RUN_KEY, run);

  return result;
}
