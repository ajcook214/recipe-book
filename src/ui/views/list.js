// @ts-check
import { getRecord, saveLocal } from '../../core/db.js';
import {
  countUse,
  findCatalogEntry,
  groupItems,
  newItem,
  nextSort,
  quickAdd,
  rankCatalog,
  sortsForMove,
} from '../../core/list.js';
import { COMMON_UNITS, formatQty, normalizeUnit, parseQty } from '../../core/quantity.js';
import { slugify } from '../../core/recipe.js';
import { dragRow, editDialog, field, h, nowIso } from '../dom.js';

/**
 * One shopping list, built for use in the aisle: big tap targets, rows to get
 * on top, the cart below. Rows combine same-key lines; checking a row checks
 * every line behind it.
 *
 * Edit turns the rows into something to rearrange instead: a handle to drag
 * each one by, and a tap opens its name and amounts. It is a separate mode so
 * that a thumb scrolling down the list in a shop never drags anything.
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

  /**
   * Move a row within its section, the open rows or the cart, and save the
   * sort values that keep it there.
   *
   * @param {Row[]} section  in the order on screen before the move
   * @param {number} from
   * @param {number} to
   */
  async function moveRow(section, from, to) {
    const order = [...section];
    const [row] = order.splice(from, 1);
    if (!row || from === to || to < 0 || to > order.length) return draw();
    order.splice(to, 0, row);
    const sorts = sortsForMove(order, to);
    if (!sorts.size) return draw();
    await updateLines(new Set(sorts.keys()), (item) => ({ ...item, sort: sorts.get(item.id) ?? item.sort }));
  }

  /**
   * Change a row's name, and the amount of each line behind it. A row from
   * two recipes keeps two lines, so each recipe can still be taken off the
   * list exactly. Only what was changed is written: an untouched amount keeps
   * its exact value, rather than the rounded one the field shows.
   *
   * @param {Row} row
   */
  async function editRow(row) {
    const name = /** @type {HTMLInputElement} */ (h('input', { value: row.text, autocomplete: 'off', enterkeyhint: 'done' }));
    const lines = row.lines.map((line, i) => {
      const shown = line.qty === null ? '' : formatQty(line.qty);
      const qty = /** @type {HTMLInputElement} */ (
        h('input', { value: shown, inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', autofocus: i === 0 })
      );
      const unit = /** @type {HTMLInputElement} */ (
        h('input', { value: line.unit ?? '', list: 'unit-options', autocomplete: 'off', autocapitalize: 'none', enterkeyhint: 'done' })
      );
      return { line, shown, qty, unit };
    });

    await editDialog({
      title: 'Change item',
      fields: [
        field('Name', name),
        lines.map(({ line, qty, unit }) =>
          h(
            'fieldset',
            null,
            row.lines.length > 1 ? h('legend', null, line.from ? line.from.recipeTitle : 'Added by hand') : null,
            h('div', { class: 'amount-fields' }, field('Amount', qty), field('Unit', unit)),
          ),
        ),
        h('datalist', { id: 'unit-options' }, COMMON_UNITS.map((u) => h('option', { value: u }))),
      ],
      save: async () => {
        const text = name.value.trim();
        if (!text) return 'Give it a name.';
        const renamed = text !== row.text;

        /** @type {Map<string, Partial<ListItem>>} */
        const changes = new Map();
        for (const { line, shown, qty, unit } of lines) {
          /** @type {Partial<ListItem>} */
          const change = {};
          if (qty.value.trim() !== shown) {
            const value = parseQty(qty.value);
            if (value === undefined) return `"${qty.value.trim()}" is not an amount. Try 2, 1.5 or 1 1/2, or leave it blank.`;
            if (value !== line.qty) change.qty = value;
          }
          if (unit.value.trim() !== (line.unit ?? '')) {
            const value = normalizeUnit(unit.value);
            if (value !== line.unit) change.unit = value;
          }
          // The key follows the name, so a fixed typo combines with the real thing.
          if (renamed) Object.assign(change, { text, key: slugify(text) || null });
          if (Object.keys(change).length) changes.set(line.id, change);
        }
        if (changes.size) await updateLines(new Set(changes.keys()), (item) => ({ ...item, ...changes.get(item.id) }));
      },
    });
  }

  /**
   * Add from the catalog or free-form text. A common item counts the use;
   * anything else is added to the list only, never to the common items.
   *
   * Everything is read and changed in memory before the first await. Two
   * adds can overlap, from two quick taps on the buttons, and one that read
   * the list before the other had saved it would save over it.
   *
   * @param {string} text
   */
  async function add(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const entry = findCatalogEntry(catalog, trimmed);
    const key = entry?.key ?? slugify(trimmed);
    const label = entry?.label ?? trimmed;
    const current = /** @type {ShoppingList} */ (list);

    const item = newItem(label, {
      key: key || undefined,
      qty: entry?.defaultUnit ? 1 : null,
      unit: entry?.defaultUnit ?? null,
      sort: nextSort(current.items),
    });

    if (entry && catalog) catalog = countUse(catalog, entry.key, nowIso());
    const saving = save([...current.items, item]);
    if (entry && catalog) await saveLocal(ctx.db, 'catalog', catalog);
    await saving;
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
        // Cleared now, not after saving, so typing on is not run into this one.
        const text = input.value;
        input.value = '';
        input.focus();
        await add(text);
      },
    },
    input,
    h('button', { type: 'submit' }, 'Add'),
    suggestions,
  );

  let editing = false;
  const editToggle = h(
    'button',
    {
      type: 'button',
      class: 'edit-toggle',
      onclick: () => {
        editing = !editing;
        draw();
      },
    },
    'Edit',
  );
  const editHint = h(
    'p',
    { class: 'muted edit-hint', hidden: true },
    'Drag ☰ to move an item, or tap it to change its name or amount. ',
    h('a', { href: '#/catalog' }, 'Common items'),
  );

  const archivedNote = h(
    'div',
    { class: 'archived-note', hidden: true },
    h('span', null, 'Archived. Recipes are not added to it any more.'),
    h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          await save(/** @type {ShoppingList} */ (list).items, { archived: false });
          ctx.flash('Back with your lists');
        },
      },
      'Unarchive',
    ),
  );

  const quick = h('div', { class: 'chips quick-add' });
  const toGet = h('ul', { class: 'shop-list' });
  const cart = h('section', { class: 'cart' });
  const recipes = h('section', { class: 'from-recipes' });
  const footer = h('div', { class: 'footer-actions' });

  // --- drawing -------------------------------------------------------------

  /** @param {Row} row */
  function rowText(row) {
    return h(
      'span',
      { class: 'row-text' },
      h('span', { class: 'row-name' }, row.text),
      row.amount ? h('span', { class: 'row-amount' }, row.amount) : null,
      row.sources.length ? h('span', { class: 'row-sources' }, row.sources.join(', ')) : null,
    );
  }

  /**
   * @param {Row} row
   * @param {number} index
   * @param {Row[]} section  the rows drawn alongside it, open or in the cart
   */
  function rowView(row, index, section) {
    const remove = h(
      'button',
      { type: 'button', class: 'row-remove', 'aria-label': `Remove ${row.text}`, onclick: () => removeRow(row) },
      '×',
    );

    if (editing) {
      const handle = h(
        'button',
        {
          type: 'button',
          class: 'row-handle',
          'data-key': row.key,
          'aria-label': `Move ${row.text}`,
          title: 'Drag, or use the arrow keys, to move',
          onpointerdown: (/** @type {PointerEvent} */ e) => dragRow(e, (from, to) => moveRow(section, from, to)),
          onkeydown: async (/** @type {KeyboardEvent} */ e) => {
            const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
            if (!step) return;
            e.preventDefault();
            await moveRow(section, index, index + step);
            /** @type {HTMLElement|null} */ (view.querySelector(`.row-handle[data-key="${CSS.escape(row.key)}"]`))?.focus();
          },
        },
        '☰',
      );
      return h(
        'li',
        { class: row.checked ? 'row done editing' : 'row editing' },
        handle,
        h('button', { type: 'button', class: 'row-edit', onclick: () => editRow(row) }, rowText(row)),
        remove,
      );
    }

    const box = h('input', {
      type: 'checkbox',
      checked: row.checked,
      onchange: () => toggle(row),
      'aria-label': `${row.checked ? 'Uncheck' : 'Check'} ${row.text}`,
    });
    return h('li', { class: row.checked ? 'row done' : 'row' }, h('label', null, box, rowText(row)), remove);
  }

  function draw() {
    const current = /** @type {ShoppingList} */ (list);
    const rows = groupItems(current.items);
    const open = rows.filter((r) => !r.checked);
    const done = rows.filter((r) => r.checked);

    editToggle.textContent = editing ? 'Done' : 'Edit';
    editHint.hidden = !editing;
    archivedNote.hidden = !current.archived;
    // Anything already on the list, in the cart or not, is not worth offering.
    const onList = new Set(rows.map((r) => r.key));

    quick.replaceChildren(
      ...quickAdd(catalog, onList).map((c) =>
        h('button', { type: 'button', class: 'chip', onclick: () => add(c.label) }, `+ ${c.label}`),
      ),
    );
    // Suggestions offer every common item, used or not.
    suggestions.replaceChildren(...rankCatalog(catalog).map((c) => h('option', { value: c.label })));

    toGet.replaceChildren(
      ...(open.length
        ? open.map((row, i) => rowView(row, i, open))
        : [h('li', { class: 'muted empty-row' }, rows.length ? 'Everything is in the cart.' : 'Nothing on this list yet.')]),
    );

    cart.replaceChildren(
      ...(done.length
        ? [
            h('h2', null, `In the cart (${done.length})`),
            h('ul', { class: 'shop-list' }, done.map((row, i) => rowView(row, i, done))),
          ]
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
      // Last week's list is put away rather than deleted. It is kept, and
      // can come back; nothing to confirm.
      current.archived
        ? null
        : h(
            'button',
            {
              type: 'button',
              onclick: async () => {
                await save(/** @type {ShoppingList} */ (list).items, { archived: true });
                ctx.flash(`Archived "${current.name}"`);
                ctx.navigate('#/lists');
              },
            },
            'Archive list',
          ),
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

  const view = h(
    'section',
    { class: 'shopping' },
    h('a', { class: 'back', href: '#/lists' }, '← Lists'),
    h('div', { class: 'page-head' }, name, editToggle),
    archivedNote,
    addForm,
    quick,
    editHint,
    toGet,
    cart,
    recipes,
    footer,
  );
  draw();
  return view;
}
