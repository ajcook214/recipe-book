// @ts-check
import { getRecord, saveLocal } from '../../core/db.js';
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

    // One recipe per file is the norm, but accept an array for bulk pastes.
    for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
      try {
        const { recipe, warnings } = normalizeRecipe(raw);
        const existing = await getRecord(ctx.db, 'recipe', recipe.id);

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
   * @param {string} [id]
   */
  function report(kind, label, message, warnings = [], id) {
    results.prepend(
      h(
        'li',
        { class: kind },
        h('span', { class: 'result-mark' }, kind === 'ok' ? '✓' : '✗'),
        h(
          'div',
          null,
          id ? h('a', { href: `#/recipe/${encodeURIComponent(id)}` }, message) : message,
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
    h('p', { class: 'muted' }, 'Recipe JSON files, one recipe each. Re-importing a recipe with the same id updates it.'),
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
