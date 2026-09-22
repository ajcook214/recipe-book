// @ts-check
import { getRecord, saveLocal } from '../../core/db.js';
import { normalizeCatalog, normalizeList } from '../../core/list.js';
import { mergeCatalog } from '../../core/merge.js';
import { normalizeRecipe } from '../../core/recipe.js';
import { h, nowIso } from '../dom.js';

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
        const existing = await getRecord(ctx.db, 'recipe', recipe.id);

        // Rating is the owner's judgement, not something ingestion knows.
        // Re-importing a re-summarized recipe must not wipe it.
        if (existing && !existing.deleted && recipe.rating === null) {
          recipe.rating = existing.rating ?? null;
        }

        // The import itself is the edit. Stamping it now means a re-import
        // wins over the older copy on the next sync, instead of losing a
        // last-writer-wins comparison against the file's original timestamp.
        recipe.updatedAt = nowIso();
        await saveLocal(ctx.db, 'recipe', recipe);

        const verb = existing && !existing.deleted ? 'Updated' : 'Imported';
        report('ok', label, `${verb} "${recipe.title}"`, warnings, recipe.id);
      } catch (err) {
        report('error', label, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * @param {'ok'|'error'} kind
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
        h('span', { class: 'result-mark' }, kind === 'ok' ? '✓' : '✗'),
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
    h('p', { class: 'muted' }, 'Recipe, shopping list or catalog JSON files. Re-importing something with the same id updates it; a catalog merges into the one you have.'),
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
