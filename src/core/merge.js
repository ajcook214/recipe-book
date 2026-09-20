// @ts-check

/**
 * Merge logic for the sync algorithm.
 *
 * Every function here is pure: no I/O, no clock, no randomness. That is
 * deliberate. This is the part of the app where a bug silently eats data, so
 * it has to be testable without a browser, a network, or a Drive account.
 *
 * Two granularities, as settled in CLAUDE.md:
 *   - Recipes merge whole-record. A recipe is edited in one place at a time.
 *   - Lists and the catalog merge per item, because checking things off in the
 *     store while the same list sits open on the desktop is the most likely
 *     conflict in this app, and whole-record LWW would discard one side of it.
 *
 * @typedef {import('./types.js').Recipe} Recipe
 * @typedef {import('./types.js').ShoppingList} ShoppingList
 * @typedef {import('./types.js').ListItem} ListItem
 * @typedef {import('./types.js').Catalog} Catalog
 * @typedef {import('./types.js').CatalogItem} CatalogItem
 */

const EPOCH = 0;

/**
 * Parse an ISO timestamp into a comparable number. Anything missing or
 * unparseable sorts oldest, so a record with a corrupt timestamp can never
 * beat a well-formed one.
 *
 * @param {unknown} iso
 * @returns {number}
 */
function timeOf(iso) {
  if (typeof iso !== 'string') return EPOCH;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? EPOCH : t;
}

/**
 * Recursively sort object keys. Two structurally equal values always produce
 * the same output regardless of the order their keys were inserted.
 *
 * @param {any} value
 * @returns {any}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/**
 * Canonical JSON: stable regardless of key order. Used for equality checks and
 * as the tiebreaker when two versions share a timestamp.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * Structural equality. Sync uses this to decide whether a merge result differs
 * from what is already stored, and therefore whether anything needs writing or
 * pushing.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function isSame(a, b) {
  return canonical(a) === canonical(b);
}

/**
 * Pick the winning version of two values that share an identity.
 *
 * Newer `updatedAt` wins. Ties break on canonical serialization rather than on
 * argument order, which makes the function commutative: pickNewer(a, b) and
 * pickNewer(b, a) return the same thing. Without that, two devices whose
 * clocks agreed to the millisecond could each decide the other was the winner
 * and push edits back and forth forever.
 *
 * @template T
 * @param {T|null|undefined} a
 * @param {T|null|undefined} b
 * @returns {T|null}
 */
export function pickNewer(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;

  const ta = timeOf(/** @type {any} */ (a).updatedAt);
  const tb = timeOf(/** @type {any} */ (b).updatedAt);
  if (ta > tb) return a;
  if (tb > ta) return b;

  const ca = canonical(a);
  const cb = canonical(b);
  if (ca === cb) return a;
  return ca > cb ? a : b;
}

/**
 * Merge one side of items into an accumulator keyed by identity. Also
 * collapses duplicates within a single side, which should not happen but would
 * otherwise make the result depend on array order.
 *
 * @template T
 * @param {Map<string, T>} into
 * @param {readonly T[]|undefined|null} items
 * @param {string} idField
 * @returns {void}
 */
function absorb(into, items, idField) {
  for (const item of items ?? []) {
    if (item === null || item === undefined) continue;
    const rawId = /** @type {any} */ (item)[idField];
    if (typeof rawId !== 'string' || rawId === '') continue;
    const existing = into.get(rawId);
    const winner = existing === undefined ? item : pickNewer(existing, item);
    if (winner !== null) into.set(rawId, winner);
  }
}

/**
 * Union two item arrays, resolving same-identity collisions with per-item LWW.
 * Tombstones carry through untouched: a delete on one device has to survive a
 * merge with a device that still remembers the item, or it comes back from the
 * dead on the next sync.
 *
 * @template T
 * @param {readonly T[]|undefined|null} localItems
 * @param {readonly T[]|undefined|null} remoteItems
 * @param {string} idField
 * @param {(a: T, b: T) => number} compare
 * @returns {T[]}
 */
function mergeItems(localItems, remoteItems, idField, compare) {
  /** @type {Map<string, T>} */
  const byId = new Map();
  absorb(byId, localItems, idField);
  absorb(byId, remoteItems, idField);
  return [...byId.values()].sort(compare);
}

/**
 * Strip the item array so the scalar fields can be compared on their own.
 *
 * @template {object} T
 * @param {T} record
 * @returns {T}
 */
function withoutItems(record) {
  const { items: _items, ...rest } = /** @type {any} */ (record);
  return /** @type {T} */ (rest);
}

/**
 * List items order by their sparse `sort` value, falling back to id so the
 * result stays deterministic when two items claim the same slot.
 *
 * @param {ListItem} a
 * @param {ListItem} b
 * @returns {number}
 */
function compareListItems(a, b) {
  const sa = typeof a.sort === 'number' ? a.sort : Number.MAX_SAFE_INTEGER;
  const sb = typeof b.sort === 'number' ? b.sort : Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Catalog entries have no explicit ordering field; `key` is both identity and
 * sort order. Presentation order (pinned first, then useCount) is a UI concern,
 * not a storage one.
 *
 * @param {CatalogItem} a
 * @param {CatalogItem} b
 * @returns {number}
 */
function compareCatalogItems(a, b) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Merge two versions of a recipe. Whole-record last-writer-wins.
 *
 * @param {Recipe|null|undefined} local
 * @param {Recipe|null|undefined} remote
 * @returns {Recipe|null}
 */
export function mergeRecipe(local, remote) {
  return pickNewer(local, remote);
}

/**
 * Merge two versions of a shopping list.
 *
 * Scalar fields (name, archived, deleted) resolve by whole-record LWW; items
 * resolve individually. The merged record keeps the winning side of
 * `updatedAt`, which means it can trail the newest item timestamp. Sync
 * decides what to write by comparing content with isSame(), not by comparing
 * timestamps, so that is safe.
 *
 * @param {ShoppingList|null|undefined} local
 * @param {ShoppingList|null|undefined} remote
 * @returns {ShoppingList|null}
 */
export function mergeList(local, remote) {
  if (local === null || local === undefined) return remote ?? null;
  if (remote === null || remote === undefined) return local;

  const head = pickNewer(withoutItems(local), withoutItems(remote));
  if (head === null) return null;

  const items = mergeItems(local.items, remote.items, 'id', compareListItems);
  return { ...head, items };
}

/**
 * Merge two versions of the common-items catalog. Same shape as list merging,
 * keyed on `key` instead of `id`.
 *
 * @param {Catalog|null|undefined} local
 * @param {Catalog|null|undefined} remote
 * @returns {Catalog|null}
 */
export function mergeCatalog(local, remote) {
  if (local === null || local === undefined) return remote ?? null;
  if (remote === null || remote === undefined) return local;

  const head = pickNewer(withoutItems(local), withoutItems(remote));
  if (head === null) return null;

  const items = mergeItems(local.items, remote.items, 'key', compareCatalogItems);
  return { ...head, items };
}
