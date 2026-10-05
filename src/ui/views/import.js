// @ts-check
import { backupContents, backupFileName, isBackup, makeBackup } from '../../core/backup.js';
import { getRecord, listRecords, saveLocal } from '../../core/db.js';
import { messageOf } from '../../core/errors.js';
import { normalizeCatalog, normalizeList, withRecipeItems } from '../../core/list.js';
import { isSame, mergeCatalog, mergeList } from '../../core/merge.js';
import { keepBoth, normalizeRecipe, placeRecipe } from '../../core/recipe.js';
import { ask, h, nowIso, sourceParts } from '../dom.js';

/** @typedef {import('../../core/types.js').Recipe} Recipe */

/**
 * Import recipe JSON, from files or pasted text. This is how Claude-ingested
 * recipes get into the app: through the working copy, so that sync creates the
 * Drive files itself. (Under the drive.file scope, files dropped straight into
 * Drive are invisible to the app.)
 *
 * Backups go out from here too, and come back in the same way.
 *
 * @param {{ db: IDBDatabase, flash: (msg: string) => void }} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx) {
  const results = h('ul', { class: 'import-results' });

  /**
   * @param {string} label   filename or "pasted text"
   * @param {string} text
   */
  async function importText(label, text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      report('error', label, `Not valid JSON: ${err instanceof Error ? err.message : err}`);
      return;
    }

    if (isBackup(parsed)) {
      await restore(label, parsed);
      return;
    }

    // One record per file is the norm, but accept an array for bulk pastes.
    for (const raw of Array.isArray(parsed) ? parsed : [parsed]) await importRecord(label, raw);
  }

  /**
   * A backup goes in record by record, through the same checks as any other
   * import, after one question.
   *
   * @param {string} label
   * @param {any} raw
   */
  async function restore(label, raw) {
    let contents;
    try {
      contents = backupContents(raw);
    } catch (err) {
      report('error', label, messageOf(err));
      return;
    }
    const { recipes, lists, catalog } = contents;
    const made = Date.parse(raw.exportedAt);
    const when = Number.isNaN(made)
      ? 'an unknown date'
      : new Date(made).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const staples = Array.isArray(catalog?.items) ? catalog.items.length : 0;

    const choice = await ask({
      title: `Restore the backup from ${when}?`,
      body: [
        `It has ${plural(recipes.length, 'recipe')}, ${plural(lists.length, 'shopping list')} and ${plural(staples, 'common item')}.`,
        'Recipes come back as the backup has them. One here with the same name from another source asks first, as any import does.',
        'Lists and common items are merged with the ones here, so nothing added since is lost.',
      ],
      choices: [
        { value: 'restore', label: 'Restore' },
        { value: 'cancel', label: 'Cancel' },
      ],
      dismiss: 'cancel',
    });
    if (choice !== 'restore') {
      report('skip', label, 'Backup not restored');
      return;
    }

    // The backup's common items are the ones to have, so its recipes add none.
    for (const record of [...recipes, ...lists, ...(catalog ? [catalog] : [])]) {
      await importRecord(label, record, { restoring: true });
    }
    report('ok', label, `Restored the backup from ${when}`);
  }

  /**
   * @param {string} label
   * @param {any} raw  one record
   * @param {{ restoring?: boolean }} [options]
   */
  async function importRecord(label, raw, { restoring = false } = {}) {
    const kind = kindOf(raw);

    if (kind === 'list') {
      try {
        const { list, warnings } = normalizeList(raw);
        const existing = await getRecord(ctx.db, 'list', list.id);
        const href = `#/list/${encodeURIComponent(list.id)}`;
        // Merged rather than replaced, like the catalog: anything added to the
        // list here since the file was made, and not yet synced, would
        // otherwise be lost.
        const merged = mergeList(existing, list) ?? list;
        if (existing && sameContent(merged, existing)) {
          report('skip', label, `List "${list.name}" is unchanged`, warnings, undefined, href);
          return;
        }
        await saveLocal(ctx.db, 'list', merged);
        const verb = existing && !existing.deleted ? 'Updated' : 'Imported';
        report('ok', label, `${verb} list "${merged.name}" (${list.items.length} items)`, warnings, undefined, href);
      } catch (err) {
        report('error', label, messageOf(err));
      }
      return;
    }

    if (kind === 'catalog') {
      try {
        const { catalog, warnings } = normalizeCatalog(raw);
        // Merge rather than replace: importing staples must not throw away
        // entries this device has learned from use.
        const existing = await getRecord(ctx.db, 'catalog');
        const merged = mergeCatalog(existing, catalog);
        if (existing && sameContent(merged, existing)) {
          report('skip', label, 'Common items are unchanged', warnings);
          return;
        }
        await saveLocal(ctx.db, 'catalog', merged);
        report('ok', label, `Merged ${catalog.items.length} catalog items`, warnings);
      } catch (err) {
        report('error', label, messageOf(err));
      }
      return;
    }

    try {
      const { recipe, warnings } = normalizeRecipe(raw);
      const here = await listRecords(ctx.db, 'recipe');
      const place = placeRecipe(recipe, here);

      let incoming = recipe;
      let verb = 'Imported';
      if (place.kind === 'update') {
        verb = 'Updated';
        // Rating is the owner's judgement, not something ingestion knows.
        // Re-importing a re-summarized recipe must not wipe it.
        incoming = { ...recipe, rating: recipe.rating ?? place.existing.rating ?? null };
        if (sameContent(incoming, place.existing)) {
          const added = restoring ? [] : await addCommonItems(incoming);
          report(added.length ? 'ok' : 'skip', label, `"${incoming.title}" is unchanged${andAdded(added)}`, warnings, incoming.id);
          return;
        }
      } else if (place.kind === 'clash') {
        const both = keepBoth(recipe, here);
        const choice = await askAboutClash(recipe, place.existing, both);
        if (choice === 'cancel') {
          report('skip', label, `Skipped "${recipe.title}"; the one already here is unchanged`);
          return;
        }
        if (choice === 'replace') {
          verb = 'Replaced';
          // Takes over the old one's id, so list lines that point at it,
          // and its file, carry on.
          incoming = { ...recipe, id: place.existing.id, rating: recipe.rating ?? place.existing.rating ?? null };
        } else {
          incoming = both;
        }
      }

      // The import itself is the edit. Stamping it now means a re-import
      // wins over the older copy on the next sync, instead of losing a
      // last-writer-wins comparison against the file's original timestamp.
      incoming = { ...incoming, updatedAt: nowIso() };
      await saveLocal(ctx.db, 'recipe', incoming);
      const added = restoring ? [] : await addCommonItems(incoming);
      report('ok', label, `${verb} "${incoming.title}"${andAdded(added)}`, warnings, incoming.id);
    } catch (err) {
      report('error', label, messageOf(err));
    }
  }

  /**
   * Every recipe ingredient is a common item: what a list suggests as you
   * type. Adds the ones missing, and changes none that exist.
   *
   * @param {Recipe} recipe
   * @returns {Promise<string[]>}  the labels added
   */
  async function addCommonItems(recipe) {
    const { catalog, added } = withRecipeItems(await getRecord(ctx.db, 'catalog'), recipe, nowIso());
    if (added.length > 0) await saveLocal(ctx.db, 'catalog', catalog);
    return added.map((c) => c.label);
  }

  /** Everything on this device, as one file in the downloads folder. */
  async function download() {
    const [recipes, lists, catalog] = await Promise.all([
      listRecords(ctx.db, 'recipe'),
      listRecords(ctx.db, 'list'),
      getRecord(ctx.db, 'catalog'),
    ]);
    const backup = makeBackup({ recipes, lists, catalog }, nowIso());
    // Indented, with a final newline, the same as the files in Drive.
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: backupFileName(new Date()), hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    // Revoked later, not now: the download may not have started reading it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    ctx.flash(`Backed up ${plural(backup.recipes.length, 'recipe')} and ${plural(backup.lists.length, 'list')}`);
  }

  /**
   * @param {'ok'|'error'|'skip'} kind
   * @param {string} label
   * @param {string} message
   * @param {string[]} [warnings]
   * @param {string} [id]     recipe id, to link the result to it
   * @param {string} [href]   explicit link, for lists
   */
  function report(kind, label, message, warnings = [], id, href) {
    const link = href ?? (id ? `#/recipe/${encodeURIComponent(id)}` : null);
    results.prepend(
      h(
        'li',
        { class: kind },
        h('span', { class: 'result-mark' }, { ok: '✓', error: '✗', skip: '–' }[kind]),
        h(
          'div',
          null,
          link ? h('a', { href: link }, message) : message,
          h('span', { class: 'muted' }, ` — ${label}`),
          warnings.length ? h('ul', { class: 'warnings' }, warnings.map((w) => h('li', null, w))) : null,
        ),
      ),
    );
  }

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    multiple: true,
    onchange: async (/** @type {Event} */ e) => {
      const input = /** @type {HTMLInputElement} */ (e.target);
      for (const file of input.files ?? []) {
        await importText(file.name, await file.text());
      }
      input.value = '';
    },
  });

  const paste = /** @type {HTMLTextAreaElement} */ (
    h('textarea', { rows: 8, placeholder: 'Paste recipe JSON here', spellcheck: false })
  );

  return h(
    'section',
    { class: 'import' },
    h('h1', null, 'Import recipes'),
    h(
      'p',
      { class: 'muted' },
      'Recipe, shopping list or catalog JSON files, or a backup made below. A recipe imported again from the same source updates the one you have; another recipe with a name already here asks what to do. Recipe ingredients join the common items, if they are not there already. Lists and the catalog merge into the ones you have.',
    ),
    h('label', { class: 'button file-button' }, 'Choose files…', fileInput),
    h('h2', null, 'Or paste'),
    paste,
    h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          if (!paste.value.trim()) return;
          await importText('pasted text', paste.value);
          paste.value = '';
        },
      },
      'Import pasted JSON',
    ),
    results,
    h('h2', null, 'Back up'),
    h(
      'p',
      { class: 'muted' },
      'Everything on this device in one file: recipes, lists and common items, as plain JSON you can read without the app. Sync first to include what your other devices have. Import the file here to restore it.',
    ),
    h('button', { type: 'button', onclick: download }, 'Download a backup'),
  );
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * ", and 2 new common items: Lean ground beef, Elbow macaroni", or nothing.
 *
 * @param {string[]} labels
 * @returns {string}
 */
function andAdded(labels) {
  return labels.length ? `, and ${plural(labels.length, 'new common item')}: ${labels.join(', ')}` : '';
}

/**
 * The same apart from when it was last saved: an import that would change
 * nothing is not worth writing, or pushing.
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function sameContent(a, b) {
  return isSame({ ...a, updatedAt: null }, { ...b, updatedAt: null });
}

/**
 * Asks what to do when an imported recipe has the id or the name of one
 * already here.
 *
 * @param {Recipe} incoming
 * @param {Recipe} existing
 * @param {Recipe} both  the incoming recipe as "Keep both" would save it
 * @returns {Promise<'both'|'replace'|'cancel'>}
 */
function askAboutClash(incoming, existing, both) {
  const from = (/** @type {Recipe} */ r) => sourceParts(r.source).label || 'no source given';
  return ask({
    title: `"${existing.title}" is already here`,
    body: [
      `The one here is from ${from(existing)}, ${existing.rating ? `rated ${existing.rating}` : 'not rated'}.`,
      `The one you are importing, "${incoming.title}", is from ${from(incoming)}.`,
    ],
    choices: [
      { value: 'both', label: `Keep both, as "${both.title}"` },
      {
        value: 'replace',
        label: existing.rating ? `Replace it, keeping your rating of ${existing.rating}` : 'Replace it',
        danger: true,
      },
      { value: 'cancel', label: 'Cancel' },
    ],
    dismiss: 'cancel',
  });
}

/**
 * Tell recipes, lists and catalogs apart by shape. Anything unrecognised is
 * treated as a recipe, so the recipe validator produces the error message.
 *
 * @param {any} raw
 * @returns {'recipe'|'list'|'catalog'}
 */
function kindOf(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'recipe';
  if ('title' in raw || Array.isArray(raw.ingredients)) return 'recipe';
  if (Array.isArray(raw.items)) return 'name' in raw ? 'list' : 'catalog';
  return 'recipe';
}
