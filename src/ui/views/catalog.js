// @ts-check
import { getRecord, saveLocal } from '../../core/db.js';
import { editCatalogEntry, findCatalogEntry, rankCatalog } from '../../core/list.js';
import { COMMON_UNITS, normalizeUnit } from '../../core/quantity.js';
import { slugify } from '../../core/recipe.js';
import { editDialog, field, h, nowIso } from '../dom.js';

/**
 * The common items: what a list offers as quick-add buttons. The catalog
 * fills itself from what gets added to lists; this is where it is tidied.
 * Shown in the order the buttons are, so what you see here is what a list
 * offers first.
 *
 * @typedef {import('../../core/types.js').Catalog} Catalog
 * @typedef {import('../../core/types.js').CatalogItem} CatalogItem
 * @param {{ db: IDBDatabase, flash: (msg: string) => void }} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx) {
  /** @type {Catalog|undefined} */
  let catalog = await getRecord(ctx.db, 'catalog');

  /**
   * @param {CatalogItem} entry
   * @param {Parameters<typeof editCatalogEntry>[2]} changes
   */
  async function change(entry, changes) {
    catalog = editCatalogEntry(catalog, entry.key, changes, nowIso());
    await saveLocal(ctx.db, 'catalog', catalog);
    draw();
  }

  /** @param {CatalogItem} entry */
  async function togglePin(entry) {
    await change(entry, { pinned: !entry.pinned });
    ctx.flash(entry.pinned ? `Unpinned ${entry.label}` : `Pinned ${entry.label}`);
  }

  /** @param {CatalogItem} entry */
  async function remove(entry) {
    const sure = confirm(
      `Are you sure you want to remove "${entry.label}" from common items?\n\n` +
        'It stops being offered on lists. Adding it to a list again brings it back, unpinned.',
    );
    if (!sure) return;
    await change(entry, { deleted: true });
    ctx.flash(`Removed ${entry.label}`);
  }

  /**
   * A rename keeps the key, so the lines already on lists still match it,
   * and the old name still finds it. A name another entry answers to is
   * refused rather than merged: deleting the spare one is the fix.
   *
   * @param {CatalogItem} entry
   */
  async function edit(entry) {
    const label = /** @type {HTMLInputElement} */ (
      h('input', { value: entry.label, autocomplete: 'off', enterkeyhint: 'done', autofocus: true })
    );
    const unit = /** @type {HTMLInputElement} */ (
      h('input', { value: entry.defaultUnit ?? '', list: 'unit-options', autocomplete: 'off', autocapitalize: 'none', enterkeyhint: 'done' })
    );
    await editDialog({
      title: `Change ${entry.label}`,
      fields: [
        field('Name', label),
        field('Unit', unit, 'Adding it to a list puts down 1 of these, such as 1 gallon. Blank for no amount.'),
        h('datalist', { id: 'unit-options' }, COMMON_UNITS.map((u) => h('option', { value: u }))),
      ],
      save: async () => {
        const name = label.value.trim();
        if (!slugify(name)) return 'Give it a name with a letter or a number in it.';
        const clash = findCatalogEntry(catalog, name, entry.key);
        if (clash) return `"${clash.label}" is already a common item.`;
        const defaultUnit = unit.value.trim() === (entry.defaultUnit ?? '') ? entry.defaultUnit : normalizeUnit(unit.value);
        if (name === entry.label && defaultUnit === entry.defaultUnit) return;
        await change(entry, { label: name, defaultUnit });
      },
    });
  }

  // --- drawing -------------------------------------------------------------

  const filter = /** @type {HTMLInputElement} */ (
    h('input', { type: 'search', placeholder: 'Find', 'aria-label': 'Find a common item', autocomplete: 'off', oninput: () => draw() })
  );
  const rows = h('ul', { class: 'shop-list catalog-list' });

  /** @param {CatalogItem} entry */
  function entryView(entry) {
    const meta = [
      entry.defaultUnit ? `by the ${entry.defaultUnit}` : null,
      entry.useCount ? `added ${entry.useCount} time${entry.useCount === 1 ? '' : 's'}` : 'never added',
    ].filter(Boolean);
    return h(
      'li',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: 'pin',
          'aria-pressed': String(entry.pinned),
          'aria-label': `Pin ${entry.label}`,
          title: entry.pinned ? 'Pinned: offered first' : 'Pin, to offer it first',
          onclick: () => togglePin(entry),
        },
        entry.pinned ? '★' : '☆',
      ),
      h(
        'button',
        { type: 'button', class: 'row-edit', onclick: () => edit(entry) },
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-name' }, entry.label),
          h('span', { class: 'row-sources' }, meta.join(' · ')),
        ),
      ),
      h(
        'button',
        { type: 'button', class: 'row-remove', 'aria-label': `Remove ${entry.label}`, onclick: () => remove(entry) },
        '×',
      ),
    );
  }

  function draw() {
    const all = rankCatalog(catalog);
    const wanted = slugify(filter.value);
    const shown = wanted ? all.filter((c) => slugify(c.label).includes(wanted) || c.key.includes(wanted)) : all;
    filter.hidden = all.length < 10 && !filter.value;
    rows.replaceChildren(
      ...(shown.length
        ? shown.map(entryView)
        : [
            h(
              'li',
              { class: 'muted empty-row' },
              all.length ? 'Nothing matches.' : 'Nothing yet. Whatever you add to a list by hand is remembered here.',
            ),
          ]),
    );
  }

  draw();

  return h(
    'section',
    { class: 'catalog' },
    h('a', { class: 'back', href: '#/lists' }, '← Lists'),
    h('h1', null, 'Common items'),
    h(
      'p',
      { class: 'muted' },
      'A list offers these as quick-add buttons: pinned ones first, then the ones you add most. Tap one to rename it or give it a unit.',
    ),
    filter,
    rows,
  );
}
