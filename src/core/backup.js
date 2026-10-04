// @ts-check

/**
 * A backup: everything worth keeping, in one JSON file that needs neither
 * the app nor Drive to read. The records go in exactly as they are stored in
 * Drive, less the deletes, which only ever mattered to sync. The Import
 * screen takes it back.
 *
 * @typedef {import('./types.js').Recipe} Recipe
 * @typedef {import('./types.js').ShoppingList} ShoppingList
 * @typedef {import('./types.js').Catalog} Catalog
 */

/** Marks a file as a backup, so the Import screen can tell it from a record. */
export const BACKUP_FORMAT = 'recipe-book-backup';

/**
 * @typedef {object} Backup
 * @property {typeof BACKUP_FORMAT} format
 * @property {number} schemaVersion   of the backup's own shape
 * @property {string} exportedAt
 * @property {Recipe[]} recipes
 * @property {ShoppingList[]} lists   archived ones included
 * @property {Catalog|null} catalog
 */

/** @param {{ id: string }} a @param {{ id: string }} b */
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** @param {{ deleted?: boolean }} r */
const live = (r) => r.deleted !== true;

/**
 * @param {{ recipes: readonly Recipe[], lists: readonly ShoppingList[], catalog?: Catalog|null }} records
 *   the working copy; deletes are dropped here
 * @param {string} now
 * @returns {Backup}
 */
export function makeBackup({ recipes, lists, catalog }, now) {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: 1,
    exportedAt: now,
    recipes: recipes.filter(live).sort(byId),
    lists: lists
      .filter(live)
      .map((list) => ({ ...list, items: list.items.filter(live) }))
      .sort(byId),
    catalog: catalog ? { ...catalog, items: catalog.items.filter(live) } : null,
  };
}

/**
 * @param {any} raw  parsed JSON
 * @returns {boolean}
 */
export function isBackup(raw) {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.format === BACKUP_FORMAT;
}

/**
 * The records in a backup, to import one by one: recipes first, so the
 * lists that point at them land after them.
 *
 * @param {any} raw  a file isBackup() accepted
 * @returns {{ recipes: any[], lists: any[], catalog: any|null }}
 * @throws {Error} when it says it is a backup but is not shaped like one
 */
export function backupContents(raw) {
  if (!Array.isArray(raw.recipes) || !Array.isArray(raw.lists)) {
    throw new Error('This backup is missing its recipes or its lists, so it may be damaged');
  }
  const catalog = raw.catalog && typeof raw.catalog === 'object' ? raw.catalog : null;
  return { recipes: raw.recipes, lists: raw.lists, catalog };
}

/**
 * "recipe-book-2026-10-04.json", by the local date, so a folder of them
 * sorts by age.
 *
 * @param {Date} date
 * @returns {string}
 */
export function backupFileName(date) {
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `recipe-book-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.json`;
}
