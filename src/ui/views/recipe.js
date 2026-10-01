// @ts-check
import { getRecord, listEnvelopes, listRecords, saveLocal } from '../../core/db.js';
import { itemsFromRecipe, newList, nextSort } from '../../core/list.js';
import { formatAmount } from '../../core/quantity.js';
import { formatMinutes, h, nowIso, sourceParts } from '../dom.js';
import { defaultListName } from './lists.js';

/**
 * One recipe: ingredients scaled to a chosen serving count, steps, rating.
 *
 * @typedef {import('../../core/types.js').Recipe} Recipe
 * @param {{ db: IDBDatabase, navigate: (hash: string) => void, flash: (msg: string) => void }} ctx
 * @param {string[]} params  [recipe id]
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx, [id]) {
  /** @type {Recipe|undefined} */
  let recipe = await getRecord(ctx.db, 'recipe', decodeURIComponent(id ?? ''));

  if (!recipe || recipe.deleted) {
    return h(
      'section',
      { class: 'empty' },
      h('h1', null, 'Recipe not found'),
      h('a', { class: 'button', href: '#/' }, 'Back to recipes'),
    );
  }

  /** @param {Partial<Recipe>} changes */
  async function save(changes) {
    recipe = { .../** @type {Recipe} */ (recipe), ...changes, updatedAt: nowIso() };
    await saveLocal(ctx.db, 'recipe', recipe);
  }

  // --- scaling -------------------------------------------------------------

  const base = recipe.servings;
  let servings = base;

  const ingredientList = h('ul', { class: 'ingredients' });
  const servingsValue = h('output', { class: 'servings-value' });
  const scaleNote = h('span', { class: 'muted scale-note' });

  function renderIngredients() {
    const r = /** @type {Recipe} */ (recipe);
    const factor = servings / base;
    servingsValue.textContent = String(servings);
    scaleNote.textContent = servings === base ? '' : `scaled from ${base}`;
    ingredientList.replaceChildren(
      ...r.ingredients.map((ing) =>
        h(
          'li',
          null,
          h('span', { class: 'amount' }, formatAmount(ing, factor)),
          h('span', { class: 'item' }, ing.item),
          ing.note ? h('span', { class: 'note' }, ing.note) : null,
        ),
      ),
    );
  }

  /** @param {number} next */
  function setServings(next) {
    servings = Math.max(1, Math.min(99, next));
    renderIngredients();
    if (!addPanel.hidden) void renderAddPanel();
  }

  // --- add to shopping list ------------------------------------------------

  const addPanel = h('div', { class: 'add-panel', hidden: true });
  const addToggle = h(
    'button',
    {
      type: 'button',
      class: 'button add-toggle',
      onclick: async () => {
        if (addPanel.hidden) await renderAddPanel();
        addPanel.hidden = !addPanel.hidden;
      },
    },
    'Add to shopping list',
  );

  /**
   * Ingredients at the current serving count, all ticked. Untick what is
   * already in the pantry so the list only holds what actually needs buying.
   */
  async function renderAddPanel() {
    const r = /** @type {Recipe} */ (recipe);
    const factor = servings / base;
    /** @type {import('../../core/types.js').ShoppingList[]} */
    const lists = (await listRecords(ctx.db, 'list'))
      .filter((l) => !l.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const target = /** @type {HTMLSelectElement} */ (
      h(
        'select',
        { 'aria-label': 'Shopping list' },
        lists.map((l) => h('option', { value: l.id }, l.name)),
        h('option', { value: '' }, `New list: ${defaultListName()}`),
      )
    );

    const boxes = r.ingredients.map((ing) => {
      const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: true }));
      return {
        ing,
        box,
        row: h(
          'li',
          null,
          h('label', null, box, h('span', null, [formatAmount(ing, factor), ing.item].filter(Boolean).join(' '))),
        ),
      };
    });

    const submit = h('button', { type: 'button', class: 'button' });
    function label() {
      const n = boxes.filter((b) => b.box.checked).length;
      submit.textContent = n ? `Add ${n} item${n === 1 ? '' : 's'}` : 'Nothing selected';
      /** @type {HTMLButtonElement} */ (submit).disabled = n === 0;
    }
    for (const b of boxes) b.box.addEventListener('change', label);
    label();

    submit.addEventListener('click', async () => {
      const chosen = boxes.filter((b) => b.box.checked).map((b) => b.ing);
      if (!chosen.length) return;
      const existing = lists.find((l) => l.id === target.value);
      const taken = new Set((await listEnvelopes(ctx.db, 'list')).map((e) => e.id));
      const list = existing ?? newList(defaultListName(), taken);
      const items = itemsFromRecipe({ ...r, ingredients: chosen }, servings, { sort: nextSort(list.items) });
      await saveLocal(ctx.db, 'list', { ...list, items: [...list.items, ...items], updatedAt: nowIso() });
      addPanel.hidden = true;
      ctx.flash(`Added ${items.length} item${items.length === 1 ? '' : 's'} to "${list.name}"`);
    });

    const allOrNone = (/** @type {boolean} */ on) => () => {
      for (const b of boxes) b.box.checked = on;
      label();
    };

    addPanel.replaceChildren(
      h('p', { class: 'muted' }, `For ${servings} serving${servings === 1 ? '' : 's'}. Untick anything you already have.`),
      h('div', { class: 'panel-row' }, target),
      h(
        'div',
        { class: 'panel-row' },
        h('button', { type: 'button', class: 'small', onclick: allOrNone(true) }, 'All'),
        h('button', { type: 'button', class: 'small', onclick: allOrNone(false) }, 'None'),
      ),
      h('ul', { class: 'pick-list' }, boxes.map((b) => b.row)),
      h(
        'div',
        { class: 'panel-row' },
        submit,
        h('button', { type: 'button', onclick: () => (addPanel.hidden = true) }, 'Cancel'),
      ),
    );
  }

  const stepper = h(
    'div',
    { class: 'stepper', role: 'group', 'aria-label': 'Servings' },
    h('button', { type: 'button', 'aria-label': 'Fewer servings', onclick: () => setServings(servings - 1) }, '−'),
    servingsValue,
    h('button', { type: 'button', 'aria-label': 'More servings', onclick: () => setServings(servings + 1) }, '+'),
    h('span', { class: 'stepper-label' }, 'servings'),
    scaleNote,
  );

  renderIngredients();

  // --- rating --------------------------------------------------------------

  const rating = h(
    'select',
    {
      'aria-label': 'Rating',
      onchange: async (/** @type {Event} */ e) => {
        const value = /** @type {HTMLSelectElement} */ (e.target).value;
        await save({ rating: value ? Number(value) : null });
        ctx.flash(value ? `Rated ${value}/10` : 'Rating cleared');
      },
    },
    h('option', { value: '' }, 'Not rated'),
    Array.from({ length: 10 }, (_, i) => {
      const n = 10 - i;
      return h('option', { value: String(n), selected: recipe?.rating === n }, `★ ${n}/10`);
    }),
  );

  // --- delete --------------------------------------------------------------

  const remove = h(
    'button',
    {
      type: 'button',
      class: 'danger',
      onclick: async () => {
        const sure = confirm(
          `Are you sure you want to delete "${recipe?.title}"?\n\n` +
            'It will also be removed from your other devices the next time you sync.',
        );
        if (!sure) return;
        await save({ deleted: true });
        ctx.flash('Recipe deleted');
        ctx.navigate('#/');
      },
    },
    'Delete recipe',
  );

  // --- layout --------------------------------------------------------------

  const time = [
    recipe.prepMinutes ? `prep ${formatMinutes(recipe.prepMinutes)}` : null,
    recipe.cookMinutes ? `cook ${formatMinutes(recipe.cookMinutes)}` : null,
  ].filter(Boolean);
  const source = sourceParts(recipe.source);

  return h(
    'article',
    { class: 'recipe' },
    h('a', { class: 'back', href: '#/' }, '← Recipes'),
    h('h1', null, recipe.title),
    h(
      'p',
      { class: 'meta' },
      time.join(' · '),
      source.url
        ? [time.length ? ' · ' : '', h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.label)]
        : source.label,
    ),
    h('div', { class: 'controls' }, rating),
    recipe.tags.length ? h('p', { class: 'card-tags' }, recipe.tags.join(', ')) : null,

    h('h2', null, 'Ingredients'),
    stepper,
    ingredientList,
    addToggle,
    addPanel,

    recipe.steps.length ? [h('h2', null, 'Steps'), h('ol', { class: 'steps' }, recipe.steps.map((s) => h('li', null, s)))] : null,
    recipe.notes ? [h('h2', null, 'Notes'), h('p', null, recipe.notes)] : null,

    h('div', { class: 'footer-actions' }, remove),
  );
}
