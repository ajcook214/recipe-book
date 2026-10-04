// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BACKUP_FORMAT, backupContents, backupFileName, isBackup, makeBackup } from '../src/core/backup.js';

const NOW = '2026-10-04T12:00:00.000Z';

/** @param {string} id @param {Partial<any>} [over] */
const recipe = (id, over = {}) => /** @type {any} */ ({ id, title: id, deleted: false, ...over });

/** @param {string} id @param {any[]} items @param {Partial<any>} [over] */
const list = (id, items, over = {}) => /** @type {any} */ ({ id, name: id, deleted: false, archived: false, items, ...over });

/** @param {string} id @param {boolean} [deleted] */
const item = (id, deleted = false) => ({ id, text: id, deleted });

test('a backup holds every live record, sorted, and no deletes', () => {
  const backup = makeBackup(
    {
      recipes: [recipe('soup'), recipe('gone', { deleted: true }), recipe('chili')],
      lists: [
        list('2026-10-01-090000', [item('milk'), item('eggs', true)], { archived: true }),
        list('2026-09-01-090000', [], { deleted: true }),
      ],
      catalog: { schemaVersion: 1, updatedAt: NOW, items: [{ key: 'milk', deleted: false }, { key: 'old', deleted: true }] },
    },
    NOW,
  );

  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.exportedAt, NOW);
  assert.deepEqual(backup.recipes.map((r) => r.id), ['chili', 'soup']);
  assert.deepEqual(backup.lists.map((l) => l.id), ['2026-10-01-090000'], 'archived lists are kept');
  assert.deepEqual(backup.lists[0]?.items.map((i) => i.id), ['milk']);
  assert.deepEqual(backup.catalog?.items.map((c) => c.key), ['milk']);
});

test('a backup leaves the working copy as it was', () => {
  const lists = [list('l', [item('a'), item('b', true)])];
  makeBackup({ recipes: [], lists }, NOW);
  assert.equal(lists[0]?.items.length, 2);
});

test('a device with no catalog yet backs up without one', () => {
  assert.equal(makeBackup({ recipes: [], lists: [] }, NOW).catalog, null);
});

test('a backup survives the round trip through a file', () => {
  const backup = makeBackup({ recipes: [recipe('soup')], lists: [list('l', [item('a')])], catalog: null }, NOW);
  const read = JSON.parse(JSON.stringify(backup, null, 2));
  assert.equal(isBackup(read), true);
  assert.deepEqual(backupContents(read), { recipes: backup.recipes, lists: backup.lists, catalog: null });
});

test('only a file marked as a backup is read as one', () => {
  assert.equal(isBackup({ title: 'Soup', ingredients: [] }), false);
  assert.equal(isBackup([{ format: BACKUP_FORMAT }]), false);
  assert.equal(isBackup(null), false);
  assert.throws(() => backupContents({ format: BACKUP_FORMAT, recipes: [] }), /damaged/);
});

test('backups are named by the day, so they sort by age', () => {
  assert.equal(backupFileName(new Date(2026, 9, 4, 23, 59)), 'recipe-book-2026-10-04.json');
  assert.equal(backupFileName(new Date(2027, 0, 2)), 'recipe-book-2027-01-02.json');
});
