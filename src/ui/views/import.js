// @ts-check
import { getRecord, listRecords, saveLocal } from '../../core/db.js';
import { normalizeCatalog, normalizeList } from '../../core/list.js';
import { mergeCatalog } from '../../core/merge.js';
import { keepBoth, normalizeRecipe, placeRecipe } from '../../core/recipe.js';
import { ask, h, nowIso, sourceParts } from '../dom.js';

/** @typedef {import('../../core/types.js').Recipe} Recipe */

/**
 * Import recipe JSON, from files or pasted text. This is how Claude-ingested
 * recipes get into the app: through the working copy, so that sync creates the
 * Drive files itself. (Under the drive.file scope, files dropped straight into
 * Drive are invisible to the app.)
 *
 * @param {{ db: IDBDatabase }} ctx
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

    // One record per file is the norm, but accept an array for bulk pastes.
    for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
      const kind = kindOf(raw);

      if (kind === 'list') {
        try {
          const { list, warnings } = normalizeList(raw);
          const existing = await getRecord(ctx.db, 'list', list.id);
          await saveLocal(ctx.db, 'list', list);
          const verb = existing && !existing.deleted ? 'Updated' : 'Imported';
          report('ok', label, `${verb} list "${list.name}" (${list.items.length} items)`, warnings, undefined, `#/list/${encodeURIComponent(list.id)}`);
        } catch (err) {
          report('error', label, err instanceof Error ? err.message : String(err));
        }
        continue;
      }

      if (kind === 'catalog') {
        try {
          const { catalog, warnings } = normalizeCatalog(raw);
          // Merge rather than replace: importing staples must not throw away
          // entries this device has learned from use.
          const merged = mergeCatalog(await getRecord(ctx.db, 'catalog'), catalog);
          await saveLocal(ctx.db, 'catalog', merged);
          report('ok', label, `Merged ${catalog.items.length} catalog items`, warnings);
        } catch (err) {
          report('error', label, err instanceof Error ? err.message : String(err));
        }
        continue;
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
        } else if (place.kind === 'clash') {
          const both = keepBoth(recipe, here);
          const choice = await askAboutClash(recipe, place.existing, both);
          if (choice === 'cancel') {
            report('skip', label, `Skipped "${recipe.title}"; the one already here is unchanged`);
            continue;
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
        report('ok', label, `${verb} "${incoming.title}"`, warnings, incoming.id);
      } catch (err) {
        report('error', label, err instanceof Error ? err.message : String(err));
      }
    }
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
      'Recipe, shopping list or catalog JSON files. A recipe imported again from the same source updates the one you have; another recipe with a name already here asks what to do. A catalog merges into the one you have.',
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
  );
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
