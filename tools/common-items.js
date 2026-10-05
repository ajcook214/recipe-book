// @ts-check
/**
 * Helpers for the common-items skill (.claude/skills/common-items): a review
 * of the common items against the shopping lists, at the desktop, with
 * Claude. The app never loads this file; it runs under Node.
 *
 *   node tools/common-items.js review [backup.json]   a report, and a copy to edit
 *   node tools/common-items.js write                  the edited copy, as a file to import
 *
 * `review` reads the newest backup in local-data/, or the one named, and
 * writes two files to local-data/review/: base.json, the common items as the
 * backup has them, and catalog.json, a copy to edit. Change labels, units,
 * pins and counts there, take entries out, and add new ones as
 * { "key", "label" }. Recipe ingredients that are not common items yet are
 * already in the copy.
 *
 * `write` compares the two and writes the whole list to the inbox, each
 * entry stamped for the per-entry merge that Import does:
 * - unchanged: its own time, so a change made in the app since the backup wins
 * - changed: now, so the change wins
 * - taken out: deleted, stamped now, which is how a delete reaches every device
 * - added: now, except a recipe ingredient, stamped NEVER, which only fills a gap
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isBackup } from '../src/core/backup.js';
import { messageOf } from '../src/core/errors.js';
import { NEVER, recipeAdditions } from '../src/core/list.js';
import { normalizeUnit } from '../src/core/quantity.js';
import { slugify } from '../src/core/recipe.js';
import { DATA, INBOX, REVIEW, ROOT, checkCatalog, jsonFiles, labelClashes, stampFor } from './ingest.js';

/** @typedef {import('../src/core/types.js').CatalogItem} CatalogItem */

/** The fields of a common item a review can change. Its key never changes. */
const FIELDS = /** @type {const} */ (['label', 'defaultUnit', 'useCount', 'lastUsedAt', 'pinned', 'onHand', 'deleted']);

/** A list needs this many lists behind it before "on most lists" means anything. */
const PIN_MIN_LISTS = 4;

// --- the report ----------------------------------------------------------------

/**
 * Edits between two short strings, giving up past `max`.
 *
 * @param {string} a
 * @param {string} b
 * @param {number} max
 * @returns {number}
 */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? max + 1;
}

/**
 * Whether two keys look like one thing spelled two ways: a plural, or a typo
 * or two. Only ever a question for the review; "salt" and "malt" pass.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function looksAlike(a, b) {
  if (a === b) return false;
  const one = (/** @type {string} */ k) => k.replace(/(es|s)$/, '');
  if (one(a) === one(b)) return true;
  // Word by word, so "coconut-milk" and "coconut-oil" are two things, and
  // "paper-towls" is a typo of "paper-towels".
  const wa = a.split('-');
  const wb = b.split('-');
  if (wa.length !== wb.length) return false;
  const differ = wa.map((w, i) => [w, wb[i] ?? '']).filter(([x, y]) => x !== y);
  const [x = '', y = ''] = differ.length === 1 ? differ[0] ?? [] : [];
  if (!x || !y) return false;
  const max = Math.min(x.length, y.length) > 6 ? 2 : 1;
  return distance(x, y, max) <= max;
}

/**
 * The day a list was made: its id says, for lists made since ids became
 * readable, and its newest line otherwise.
 *
 * @param {any} list
 * @returns {string}
 */
function listDay(list) {
  const fromId = String(list.id).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (fromId) return fromId;
  const times = (list.items ?? []).map((/** @type {any} */ i) => String(i.updatedAt ?? '')).sort();
  return (times[times.length - 1] ?? '').slice(0, 10);
}

/**
 * What a review needs to see, from a backup: what was bought that is not a
 * common item, common items that look like typos or one-offs, and what is
 * on most lists without being pinned. Also the copy to edit: the common
 * items, plus recipe ingredients that are not common items yet.
 *
 * @param {any} backup
 * @returns {{ report: string[], working: CatalogItem[] }}
 */
export function reviewOf(backup) {
  /** @type {CatalogItem[]} */
  const catalog = (backup.catalog?.items ?? []).filter((/** @type {any} */ c) => c.deleted !== true);
  const lists = (backup.lists ?? []).filter((/** @type {any} */ l) => l.deleted !== true);
  const recipes = (backup.recipes ?? []).filter((/** @type {any} */ r) => r.deleted !== true);
  const common = new Map(catalog.map((c) => [c.key, c]));

  /** @type {Map<string, { lists: Set<string>, byHand: Set<string>, names: Set<string>, last: string }>} */
  const seen = new Map();
  for (const list of lists) {
    const day = listDay(list);
    for (const item of list.items ?? []) {
      if (item.deleted === true || !item.key) continue;
      const s = seen.get(item.key) ?? { lists: new Set(), byHand: new Set(), names: new Set(), last: '' };
      s.lists.add(list.id);
      if (!item.from) s.byHand.add(list.id);
      s.names.add(item.text);
      if (day > s.last) s.last = day;
      seen.set(item.key, s);
    }
  }

  const ingredients = recipeAdditions(recipes).items;
  const additions = ingredients.filter((c) => !common.has(c.key));
  const fromRecipes = new Set(ingredients.map((c) => c.key));
  const alike = (/** @type {string} */ key) => catalog.filter((c) => looksAlike(key, c.key)).map((c) => c.key);
  const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const days = lists.map(listDay).filter(Boolean).sort();
  /** @type {string[]} */
  const report = [
    `Common items: ${catalog.length}, ${catalog.filter((c) => c.pinned).length} pinned, ${catalog.filter((c) => c.onHand).length} on hand`,
    `Lists: ${lists.length}${days.length ? `, from ${days[0]} to ${days[days.length - 1]}` : ''}`,
    `Recipes: ${recipes.length}`,
  ];

  const bought = [...seen]
    .filter(([key, s]) => !common.has(key) && s.byHand.size > 0)
    .sort((a, b) => b[1].byHand.size - a[1].byHand.size || a[0].localeCompare(b[0]));
  report.push('', `Added by hand, not common items (${bought.length}):`);
  for (const [key, s] of bought) {
    const like = alike(key);
    report.push(
      `  ${key}: ${[...s.names].map((n) => `"${n}"`).join(', ')}, on ${plural(s.byHand.size, 'list')}, last ${s.last}` +
        (like.length ? `; looks like ${like.join(', ')}` : ''),
    );
  }

  report.push('', `Recipe ingredients, already added to the copy (${additions.length}):`);
  if (additions.length) report.push(`  ${additions.map((c) => c.key).join(', ')}`);

  report.push('', 'Common items to look at:');
  for (const c of catalog) {
    const like = alike(c.key);
    const once = c.useCount <= 1 && !c.pinned && !fromRecipes.has(c.key);
    if (!like.length && !once) continue;
    const why = [
      once ? `${c.useCount === 0 ? 'never added' : 'added once'}${c.lastUsedAt ? `, ${c.lastUsedAt.slice(0, 10)}` : ''}` : '',
      like.length ? `looks like ${like.join(', ')}` : '',
    ].filter(Boolean);
    report.push(`  ${c.key} "${c.label}": ${why.join('; ')}`);
  }

  if (lists.length >= PIN_MIN_LISTS) {
    const most = [...seen]
      .filter(([key, s]) => common.has(key) && !common.get(key)?.pinned && s.lists.size * 2 >= lists.length)
      .sort((a, b) => b[1].lists.size - a[1].lists.size);
    report.push('', 'On half the lists or more, not pinned:');
    for (const [key, s] of most) report.push(`  ${key}: on ${s.lists.size} of ${lists.length}`);
  }

  const working = [...catalog, ...additions].sort((a, b) => a.label.localeCompare(b.label));
  return { report, working };
}

// --- writing the reviewed list ---------------------------------------------------

/**
 * The reviewed list as a file to import, every entry stamped for the
 * per-entry merge (see the top of this file), with what changed in words.
 *
 * @param {readonly CatalogItem[]} base  the common items as the backup had them
 * @param {readonly any[]} edited  the working copy after the review
 * @param {string} now
 * @returns {{ items: CatalogItem[], summary: string[], errors: string[] }}
 */
export function stampReview(base, edited, now) {
  const before = new Map(base.map((c) => [c.key, c]));
  /** @type {CatalogItem[]} */
  const items = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const filled = [];
  /** @type {string[]} */
  const changed = [];
  /** @type {string[]} */
  const removed = [];
  let unchanged = 0;
  /** @type {Set<string>} */
  const keys = new Set();

  edited.forEach((raw, i) => {
    const label = typeof raw?.label === 'string' ? raw.label.trim() : '';
    const key = typeof raw?.key === 'string' ? raw.key : slugify(label);
    const where = `entry ${i + 1} (${label || key || 'no label'})`;
    if (!label) errors.push(`${where}: no label`);
    if (!key || slugify(key) !== key) errors.push(`${where}: key ${JSON.stringify(raw?.key)} is not a slug`);
    if (keys.has(key)) errors.push(`${where}: key "${key}" is in the list twice`);
    keys.add(key);
    if (raw?.defaultUnit != null && normalizeUnit(String(raw.defaultUnit)) !== raw.defaultUnit) {
      errors.push(`${where}: unit "${raw.defaultUnit}" should be "${normalizeUnit(String(raw.defaultUnit))}"`);
    }
    if (raw?.useCount !== undefined && !(Number.isInteger(raw.useCount) && raw.useCount >= 0)) {
      errors.push(`${where}: useCount ${JSON.stringify(raw.useCount)} is not a whole number`);
    }

    const old = before.get(key);
    if (!old) {
      items.push({
        key,
        label,
        defaultUnit: raw?.defaultUnit ?? null,
        useCount: raw?.useCount ?? 0,
        lastUsedAt: raw?.lastUsedAt ?? null,
        pinned: raw?.pinned === true,
        onHand: raw?.onHand === true,
        deleted: raw?.deleted === true,
        updatedAt: raw?.updatedAt === NEVER ? NEVER : now,
      });
      if (raw?.deleted === true) return;
      if (raw?.updatedAt === NEVER) filled.push(key);
      else added.push(label);
      return;
    }

    // A field left out of the copy is a field left alone.
    const next = { ...old };
    for (const f of FIELDS) if (raw?.[f] !== undefined) /** @type {any} */ (next)[f] = f === 'label' ? label : raw[f];
    // Entries from before onHand existed lack it, and missing means false.
    const diffs = FIELDS.filter((f) => (f === 'onHand' ? Boolean(next[f]) !== Boolean(old[f]) : next[f] !== old[f]));
    if (diffs.length === 0) {
      items.push(old);
      unchanged += 1;
    } else {
      items.push({ ...next, updatedAt: now });
      if (next.deleted && !old.deleted) removed.push(`${old.label} (${key})`);
      else changed.push(`${key}: ${diffs.map((f) => `${f} ${JSON.stringify(old[f])} -> ${JSON.stringify(next[f])}`).join(', ')}`);
    }
  });

  for (const old of base) {
    if (keys.has(old.key)) continue;
    items.push({ ...old, deleted: true, updatedAt: now });
    removed.push(`${old.label} (${old.key})`);
  }
  errors.push(...labelClashes(items));

  const summary = [
    `added (${added.length}): ${added.join(', ')}`,
    `recipe ingredients, only filling gaps (${filled.length}): ${filled.join(', ')}`,
    `changed (${changed.length}):`,
    ...changed.map((c) => `  ${c}`),
    `deleted (${removed.length}): ${removed.join(', ')}`,
    `unchanged: ${unchanged}`,
  ];
  return { items: items.sort((a, b) => a.key.localeCompare(b.key)), summary, errors };
}

// --- commands ----------------------------------------------------------------------

/**
 * The backup to review: the one named, or the newest in local-data/.
 *
 * @param {string|undefined} named
 * @returns {Promise<{ file: string, backup: any }>}
 */
async function findBackup(named) {
  if (named) {
    const backup = JSON.parse(await readFile(named, 'utf8'));
    if (!isBackup(backup)) throw new Error(`${named} is not a backup from the app`);
    return { file: named, backup };
  }
  /** @type {{ file: string, backup: any } | null} */
  let newest = null;
  for (const file of await jsonFiles(DATA, [INBOX, REVIEW])) {
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (isBackup(raw) && (!newest || String(raw.exportedAt) > String(newest.backup.exportedAt))) newest = { file, backup: raw };
  }
  if (!newest) throw new Error('No backup in local-data/. On Pages: Sync, then Import -> Download a backup, into local-data/backups/.');
  return newest;
}

/** @param {string|undefined} named */
async function reviewCommand(named) {
  const { file, backup } = await findBackup(named);
  const { report, working } = reviewOf(backup);
  const days = Math.floor((Date.now() - Date.parse(backup.exportedAt)) / 86_400_000);

  await mkdir(REVIEW, { recursive: true });
  const base = { reviewOf: path.relative(ROOT, file), exportedAt: backup.exportedAt, items: backup.catalog?.items ?? [] };
  await writeFile(path.join(REVIEW, 'base.json'), `${JSON.stringify(base, null, 2)}\n`);
  await writeFile(path.join(REVIEW, 'catalog.json'), `${JSON.stringify({ items: working }, null, 2)}\n`);

  console.log(`Backup: ${path.relative(ROOT, file)}, made ${String(backup.exportedAt).slice(0, 10)}` +
    (days >= 1 ? ` - ${days} day${days === 1 ? '' : 's'} ago; a fresh one is better if the app has changed since` : ''));
  console.log(report.join('\n'));
  console.log(`\nCopy to edit: ${path.relative(ROOT, path.join(REVIEW, 'catalog.json'))}. Then: node tools/common-items.js write`);
}

async function writeCommand() {
  const base = JSON.parse(await readFile(path.join(REVIEW, 'base.json'), 'utf8'));
  const edited = JSON.parse(await readFile(path.join(REVIEW, 'catalog.json'), 'utf8'));
  if (!Array.isArray(edited?.items)) throw new Error('local-data/review/catalog.json should be { "items": [...] }');

  const { items, summary, errors } = stampReview(base.items, edited.items, new Date().toISOString());
  const catalog = { schemaVersion: 1, updatedAt: new Date().toISOString(), items };
  errors.push(...checkCatalog(catalog).errors.filter((e) => !errors.includes(e)));
  if (errors.length > 0) {
    for (const e of errors) console.log(`fix:  ${e}`);
    process.exitCode = 1;
    return;
  }
  const out = path.join(INBOX, `common-items-review-${stampFor(new Date())}.json`);
  await mkdir(INBOX, { recursive: true });
  await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, out)}, from ${base.reviewOf}`);
  console.log(summary.join('\n'));
}

/** @param {string[]} args */
async function main([command, ...rest]) {
  if (command === 'review') await reviewCommand(rest[0]);
  else if (command === 'write') await writeCommand();
  else throw new Error('Usage: node tools/common-items.js review [backup.json] | write');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(messageOf(err));
    process.exitCode = 1;
  });
}
