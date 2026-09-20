// @ts-check

/**
 * The IndexedDB working copy.
 *
 * Everything the UI reads or writes goes through here; nothing in the UI talks
 * to Drive or to a local folder directly. Sync is a separate, manual step that
 * reconciles this store with a StorageAdapter.
 *
 * Records are keyed by the same path they occupy in storage
 * ("recipes/<uuid>.json"), so the working copy and the file layout stay
 * trivially comparable and sync never has to translate between two naming
 * schemes.
 *
 * Each record is wrapped in an envelope carrying the sync bookkeeping -
 * dirty flag, last-known remote version - alongside the record itself. The
 * record stays exactly the JSON that lands in the file, so a document read out
 * of here can be written to storage verbatim.
 *
 * @typedef {import('./types.js').Recipe} Recipe
 * @typedef {import('./types.js').ShoppingList} ShoppingList
 * @typedef {import('./types.js').Catalog} Catalog
 */

/** @typedef {'recipe'|'list'|'catalog'} RecordType */

/**
 * @typedef {object} Envelope
 * @property {string} path        Storage path; the primary key.
 * @property {RecordType} type
 * @property {string} id
 * @property {any} record         The JSON document itself.
 * @property {0|1} dirty          1 when the local copy has unpushed changes.
 * @property {string|null} version            Remote version at last sync.
 * @property {string|null} remoteModifiedTime Remote mtime at last sync.
 * @property {string|null} syncedAt           When we last reconciled this path.
 */

export const DB_NAME = 'recipe-book';
export const DB_VERSION = 1;

export const RECORDS = 'records';
export const META = 'meta';

const BY_TYPE = 'by_type';
const BY_DIRTY = 'by_dirty';

/** The catalog is a single document, so its id is a constant rather than a UUID. */
export const CATALOG_ID = 'catalog';

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Resolve when a transaction commits. Prefer this over awaiting individual
 * requests: an await between two requests in the same transaction can let the
 * transaction go inactive, so reads and writes that must be atomic are chained
 * through onsuccess callbacks and awaited here instead.
 *
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * @param {IDBDatabase} db
 * @returns {void}
 */
function migrate(db) {
  if (!db.objectStoreNames.contains(RECORDS)) {
    const records = db.createObjectStore(RECORDS, { keyPath: 'path' });
    records.createIndex(BY_TYPE, 'type', { unique: false });
    // IndexedDB cannot index booleans, which is why `dirty` is 0 or 1.
    records.createIndex(BY_DIRTY, 'dirty', { unique: false });
  }
  if (!db.objectStoreNames.contains(META)) {
    db.createObjectStore(META);
  }
}

/**
 * @param {string} [name]
 * @param {number} [version]
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase(name = DB_NAME, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => migrate(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    request.onblocked = () =>
      reject(new Error(`IndexedDB upgrade for "${name}" is blocked by another open tab`));
  });
}

/**
 * @param {string} [name]
 * @returns {Promise<void>}
 */
export function deleteDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete IndexedDB'));
    request.onblocked = () => resolve();
  });
}

/**
 * Storage path for a record. Mirrors the layout in docs/schema.md exactly.
 *
 * @param {RecordType} type
 * @param {string} id
 * @returns {string}
 */
export function pathFor(type, id) {
  switch (type) {
    case 'recipe':
      return `recipes/${id}.json`;
    case 'list':
      return `lists/${id}.json`;
    case 'catalog':
      return 'catalog.json';
    default:
      throw new TypeError(`Unknown record type: ${String(type)}`);
  }
}

/**
 * The inverse of pathFor. Returns null for paths the working copy does not
 * mirror - manifest.json, images/ - so sync can skip them without a special
 * case at every call site.
 *
 * @param {string} path
 * @returns {RecordType|null}
 */
export function typeForPath(path) {
  if (path === 'catalog.json') return 'catalog';
  if (!path.endsWith('.json')) return null;
  if (path.startsWith('recipes/') && !path.slice(8).includes('/')) return 'recipe';
  if (path.startsWith('lists/') && !path.slice(6).includes('/')) return 'list';
  return null;
}

/**
 * @param {RecordType} type
 * @param {any} record
 * @returns {string}
 */
export function idOf(type, record) {
  if (type === 'catalog') return CATALOG_ID;
  const id = record?.id;
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`A ${type} record needs a non-empty string id`);
  }
  return id;
}

/**
 * @param {Envelope|undefined} existing
 * @param {RecordType} type
 * @param {string} id
 * @param {any} record
 * @param {0|1} dirty
 * @returns {Envelope}
 */
function envelope(existing, type, id, record, dirty) {
  return {
    path: pathFor(type, id),
    type,
    id,
    record,
    dirty,
    version: existing?.version ?? null,
    remoteModifiedTime: existing?.remoteModifiedTime ?? null,
    syncedAt: existing?.syncedAt ?? null,
  };
}

/**
 * Write a record as a local edit, preserving whatever sync bookkeeping the
 * path already carried. The result is dirty and will be pushed on next sync.
 *
 * Deletes go through here too, as a record with `deleted: true` - tombstones
 * have to be pushed like any other change.
 *
 * @param {IDBDatabase} db
 * @param {RecordType} type
 * @param {any} record
 * @returns {Promise<Envelope>}
 */
export async function saveLocal(db, type, record) {
  const id = idOf(type, record);
  const path = pathFor(type, id);

  const tx = db.transaction(RECORDS, 'readwrite');
  const store = tx.objectStore(RECORDS);

  /** @type {Envelope|undefined} */
  let written;
  const get = store.get(path);
  get.onsuccess = () => {
    written = envelope(get.result, type, id, record, 1);
    store.put(written);
  };

  await txDone(tx);
  if (!written) throw new Error(`saveLocal(${path}) committed without writing`);
  return written;
}

/**
 * Write a record together with the remote version it was reconciled against.
 * Used by sync after a pull, a push, or a merge.
 *
 * `dirty` defaults to 0, the ordinary case where the local copy now matches
 * storage. Sync passes 1 when a merge produced something that still has to be
 * pushed, which must not lose the remote version that the next write will be
 * checked against.
 *
 * @param {IDBDatabase} db
 * @param {RecordType} type
 * @param {any} record
 * @param {{ version?: string|null, modifiedTime?: string|null, syncedAt?: string|null, dirty?: 0|1 }} [remote]
 * @returns {Promise<Envelope>}
 */
export async function saveFromSync(db, type, record, remote = {}) {
  const id = idOf(type, record);
  const path = pathFor(type, id);

  /** @type {Envelope} */
  const written = {
    path,
    type,
    id,
    record,
    dirty: remote.dirty ?? 0,
    version: remote.version ?? null,
    remoteModifiedTime: remote.modifiedTime ?? null,
    syncedAt: remote.syncedAt ?? null,
  };

  const tx = db.transaction(RECORDS, 'readwrite');
  tx.objectStore(RECORDS).put(written);
  await txDone(tx);
  return written;
}

/**
 * Clear the dirty flag and record the remote version, after a push succeeded.
 * Leaves the record untouched.
 *
 * @param {IDBDatabase} db
 * @param {string} path
 * @param {{ version?: string|null, modifiedTime?: string|null, syncedAt?: string|null }} [remote]
 * @returns {Promise<Envelope|undefined>}
 */
export async function markSynced(db, path, remote = {}) {
  const tx = db.transaction(RECORDS, 'readwrite');
  const store = tx.objectStore(RECORDS);

  /** @type {Envelope|undefined} */
  let written;
  const get = store.get(path);
  get.onsuccess = () => {
    /** @type {Envelope|undefined} */
    const existing = get.result;
    if (!existing) return;
    written = {
      ...existing,
      dirty: 0,
      version: remote.version ?? existing.version,
      remoteModifiedTime: remote.modifiedTime ?? existing.remoteModifiedTime,
      syncedAt: remote.syncedAt ?? existing.syncedAt,
    };
    store.put(written);
  };

  await txDone(tx);
  return written;
}

/**
 * @param {IDBDatabase} db
 * @param {string} path
 * @returns {Promise<Envelope|undefined>}
 */
export async function getEnvelope(db, path) {
  const tx = db.transaction(RECORDS, 'readonly');
  const result = await promisify(tx.objectStore(RECORDS).get(path));
  return result;
}

/**
 * @param {IDBDatabase} db
 * @param {RecordType} type
 * @param {string} [id]
 * @returns {Promise<any|undefined>}
 */
export async function getRecord(db, type, id = CATALOG_ID) {
  const found = await getEnvelope(db, pathFor(type, id));
  return found?.record;
}

/**
 * All envelopes of a type, tombstones included.
 *
 * @param {IDBDatabase} db
 * @param {RecordType} type
 * @returns {Promise<Envelope[]>}
 */
export async function listEnvelopes(db, type) {
  const tx = db.transaction(RECORDS, 'readonly');
  const index = tx.objectStore(RECORDS).index(BY_TYPE);
  return promisify(index.getAll(IDBKeyRange.only(type)));
}

/**
 * Records of a type, with tombstones filtered out by default. This is what the
 * UI lists; deleted records stay in the store so the delete can still be
 * pushed, but they are not something anyone wants to look at.
 *
 * @param {IDBDatabase} db
 * @param {RecordType} type
 * @param {{ includeDeleted?: boolean }} [options]
 * @returns {Promise<any[]>}
 */
export async function listRecords(db, type, options = {}) {
  const envelopes = await listEnvelopes(db, type);
  const records = envelopes.map((e) => e.record);
  if (options.includeDeleted) return records;
  return records.filter((r) => r?.deleted !== true);
}

/**
 * Everything waiting to be pushed.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<Envelope[]>}
 */
export async function listDirty(db) {
  const tx = db.transaction(RECORDS, 'readonly');
  const index = tx.objectStore(RECORDS).index(BY_DIRTY);
  return promisify(index.getAll(IDBKeyRange.only(1)));
}

/**
 * The pending-change count the UI shows next to the Sync button. Counted
 * through the index rather than by loading the records.
 *
 * @param {IDBDatabase} db
 * @returns {Promise<number>}
 */
export async function countDirty(db) {
  const tx = db.transaction(RECORDS, 'readonly');
  const index = tx.objectStore(RECORDS).index(BY_DIRTY);
  return promisify(index.count(IDBKeyRange.only(1)));
}

/**
 * Remove a path from the working copy outright, with no tombstone. This is for
 * pruning already-propagated deletes, not for deleting a record the user can
 * see - that is saveLocal() with `deleted: true`.
 *
 * @param {IDBDatabase} db
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function forget(db, path) {
  const tx = db.transaction(RECORDS, 'readwrite');
  tx.objectStore(RECORDS).delete(path);
  await txDone(tx);
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 * @returns {Promise<any|undefined>}
 */
export async function getMeta(db, key) {
  const tx = db.transaction(META, 'readonly');
  return promisify(tx.objectStore(META).get(key));
}

/**
 * Sync bookkeeping that is not tied to one record: last sync time, the chosen
 * adapter, the persisted directory handle for local-folder mode.
 *
 * @param {IDBDatabase} db
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
export async function setMeta(db, key, value) {
  const tx = db.transaction(META, 'readwrite');
  tx.objectStore(META).put(value, key);
  await txDone(tx);
}

/**
 * @param {IDBDatabase} db
 * @returns {Promise<void>}
 */
export async function clearAll(db) {
  const tx = db.transaction([RECORDS, META], 'readwrite');
  tx.objectStore(RECORDS).clear();
  tx.objectStore(META).clear();
  await txDone(tx);
}
