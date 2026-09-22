// @ts-check
import { getRecord, saveLocal } from '../../core/db.js';
import { groupItems, newItem, nextSort, rankCatalog, touchCatalog } from '../../core/list.js';
import { slugify } from '../../core/recipe.js';
import { h, nowIso } from '../dom.js';

/**
 * One shopping list, built for use in the aisle: big tap targets, rows to get
 * on top, the cart below. Rows combine same-key lines; checking a row checks
 * every line behind it.
 *
 * @typedef {import('../../core/types.js').ShoppingList} ShoppingList
 * @typedef {import('../../core/types.js').ListItem} ListItem
 * @typedef {import('../../core/types.js').Catalog} Catalog
 * @typedef {import('../../core/list.js').Row} Row
 * @param {{ db: IDBDatabase, navigate: (hash: string) => void, flash: (msg: string) => void }} ctx
 * @param {string[]} params  [list id]
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx, [id]) {
  /** @type {ShoppingList|undefined} */
  let list = await getRecord(ctx.db, 'list', decodeURIComponent(id ?? ''));
  if (!list || list.deleted) {
    return h(
      'section',
      { class: 'empty' },
      h('h1', null, 'List not found'),
      h('a', { class: 'button', href: '#/lists' }, 'Back to lists'),
    );
  }

  /** @type {Catalog|undefined} */
  let catalog = await getRecord(ctx.db, 'catalog');

  /**
   * Apply a change to the lines with the given ids, then save and redraw.
   * @param {Set<string>} ids
   * @param {(item: ListItem, at: string) => ListItem} change
   */
  async function updateLines(ids, change) {
    const at = nowIso();
    const current = /** @type {ShoppingList} */ (list);
    await save(current.items.map((item) => (ids.has(item.id) ? { ...change(item, at), updatedAt: at } : item)));
  }

  /** @param {ListItem[]} items @param {Partial<ShoppingList>} [extra] */
  async function save(items, extra = {}) {
    list = { .../** @type {ShoppingList} */ (list), ...extra, items, updatedAt: nowIso() };
    await saveLocal(ctx.db, 'list', list);
    draw();
  }

  /** @param {Row} row */
  const idsOf = (row) => new Set(row.lines.map((l) => l.id));

  /** @param {Row} row */
  async function toggle(row) {
    const on = !row.checked;
    await updateLines(idsOf(row), (item, at) => ({ ...item, checked: on, checkedAt: on ? at : null }));
  }

  /** @param {Row} row */
  async function removeRow(row) {
    if (!confirm(`Are you sure you want to remove "${row.text}" from this list?`)) return;
    await updateLines(idsOf(row), (item) => ({ ...item, deleted: true }));
  }

  /** Add from the catalog or free-form text; either way the catalog learns it. */
  /** @param {string} text */
  async function add(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const key = slugify(trimmed);
    const entry = catalog?.items.find((c) => c.key === key && !c.deleted);
    const label = entry?.label ?? trimmed;
    const current = /** @type {ShoppingList} */ (list);

    const item = newItem(label, {
      key: key || undefined,
      qty: entry?.defaultUnit ? 1 : null,
      unit: entry?.defaultUnit ?? null,
      sort: nextSort(current.items),
    });

    if (key) {
      catalog = touchCatalog(catalog, { key, label, defaultUnit: entry?.defaultUnit ?? null }, nowIso());
      await saveLocal(ctx.db, 'catalog', catalog);
    }
    await save([...current.items, item]);
  }

  // --- static parts --------------------------------------------------------

  const name = h('input', {
    class: 'list-name',
    value: list.name,
    'aria-label': 'List name',
    onchange: async (/** @type {Event} */ e) => {
      const value = /** @type {HTMLInputElement} */ (e.target).value.trim();
      if (!value) return;
      await save(/** @type {ShoppingList} */ (list).items, { name: value });
      ctx.flash('Renamed');
    },
  });

  const suggestions = h('datalist', { id: 'catalog-suggestions' });
  const input = /** @type {HTMLInputElement} */ (
    h('input', {
      type: 'text',
      placeholder: 'Add an item',
      'aria-label': 'Add an item',
      list: 'catalog-suggestions',
      autocomplete: 'off',
      enterkeyhint: 'done',
    })
  );
  const addForm = h(
    'form',
    {
      class: 'add-form',
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        await add(input.value);
        input.value = '';
        input.focus();
      },
    },
    input,
    h('button', { type: 'submit' }, 'Add'),
    suggestions,
  );

  const quick = h('div', { class: 'chips quick-add' });
  const toGet = h('ul', { class: 'shop-list' });
  const cart = h('section', { class: 'cart' });
  const recipes = h('section', { class: 'from-recipes' });
  const footer = h('div', { class: 'footer-actions' });

  // --- drawing -------------------------------------------------------------

  /** @param {Row} row */
  function rowView(row) {
    const box = h('input', {
      type: 'checkbox',
      checked: row.checked,
      onchange: () => toggle(row),
      'aria-label': `${row.checked ? 'Uncheck' : 'Check'} ${row.text}`,
    });
    return h(
      'li',
      { class: row.checked ? 'row done' : 'row' },
      h(
        'label',
        null,
        box,
        h(
          'span',
          { class: 'row-text' },
          h('span', { class: 'row-name' }, row.text),
          row.amount ? h('span', { class: 'row-amount' }, row.amount) : null,
          row.sources.length ? h('span', { class: 'row-sources' }, row.sources.join(', ')) : null,
        ),
      ),
      h('button', { type: 'button', class: 'row-remove', 'aria-label': `Remove ${row.text}`, onclick: () => removeRow(row) }, '×'),
    );
  }

  function draw() {
    const current = /** @type {ShoppingList} */ (list);
    const rows = groupItems(current.items);
    const open = rows.filter((r) => !r.checked);
    const done = rows.filter((r) => r.checked);
    // Anything already on the list, in the cart or not, is not worth offering.
    const onList = new Set(rows.map((r) => r.key));

    // Catalog chips: what you usually buy, minus what is already on the list.
    const ranked = rankCatalog(catalog);
    quick.replaceChildren(
      ...ranked
        .filter((c) => !onList.has(c.key))
        .slice(0, 10)
        .map((c) => h('button', { type: 'button', class: 'chip', onclick: () => add(c.label) }, `+ ${c.label}`)),
    );
    suggestions.replaceChildren(...ranked.map((c) => h('option', { value: c.label })));

    toGet.replaceChildren(
      ...(open.length ? open.map(rowView) : [h('li', { class: 'muted empty-row' }, rows.length ? 'Everything is in the cart.' : 'Nothing on this list yet.')]),
    );

    cart.replaceChildren(
      ...(done.length
        ? [h('h2', null, `In the cart (${done.length})`), h('ul', { class: 'shop-list' }, done.map(rowView))]
        : []),
    );

    // Recipes on this list, each removable as a unit.
    /** @type {Map<string, string>} */
    const recipeTitles = new Map();
    for (const item of current.items) {
      if (!item.deleted && item.from) recipeTitles.set(item.from.recipeId, item.from.recipeTitle);
    }
    recipes.replaceChildren(
      ...(recipeTitles.size
        ? [
            h('h2', null, 'Recipes on this list'),
            h(
              'ul',
              { class: 'recipe-sources' },
              [...recipeTitles].map(([recipeId, title]) =>
                h(
                  'li',
                  null,
                  h('a', { href: `#/recipe/${encodeURIComponent(recipeId)}` }, title),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'danger small',
                      onclick: async () => {
                        if (!confirm(`Are you sure you want to remove every "${title}" ingredient from this list?`)) return;
                        const ids = new Set(current.items.filter((i) => i.from?.recipeId === recipeId).map((i) => i.id));
                        await updateLines(ids, (item) => ({ ...item, deleted: true }));
                        ctx.flash(`Removed ${title}`);
                      },
                    },
                    'Remove',
                  ),
                ),
              ),
            ),
          ]
        : []),
    );

    footer.replaceChildren(
      ...[
      done.length
        ? h(
            'button',
            {
              type: 'button',
              onclick: async () => {
                if (!confirm(`Are you sure you want to clear ${done.length} checked item${done.length === 1 ? '' : 's'}?`)) return;
                const ids = new Set(done.flatMap((r) => r.lines.map((l) => l.id)));
                await updateLines(ids, (item) => ({ ...item, deleted: true }));
                ctx.flash('Cleared the cart');
              },
            },
            'Clear checked items',
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: async () => {
            const current2 = /** @type {ShoppingList} */ (list);
            if (!confirm(`Are you sure you want to delete "${current2.name}"?\n\nIt will also be removed from your other devices the next time you sync.`)) return;
            await save(current2.items, { deleted: true });
            ctx.flash('List deleted');
            ctx.navigate('#/lists');
          },
        },
        'Delete list',
      ),
      ].filter((el) => el !== null),
    );
  }

  draw();

  return h(
    'section',
    { class: 'shopping' },
    h('a', { class: 'back', href: '#/lists' }, '← Lists'),
    name,
    addForm,
    quick,
    toGet,
    cart,
    recipes,
    footer,
  );
}
