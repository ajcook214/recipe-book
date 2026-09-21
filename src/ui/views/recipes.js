// @ts-check
import { listRecords } from '../../core/db.js';
import { formatMinutes, h } from '../dom.js';

/**
 * The recipe book: search, tag filters, a minimum-rating slider and sort.
 * Filtering re-renders only the results, so the search box keeps focus.
 *
 * @typedef {import('../../core/types.js').Recipe} Recipe
 */

/**
 * Filter state outlives a single render, so opening a recipe and coming back
 * does not throw away what you had narrowed the list to.
 */
const state = {
  query: '',
  /** @type {Set<string>} */
  tags: new Set(),
  /** 0 means any rating, unrated included. */
  minRating: 0,
  /** @type {'name'|'rating'} */
  sort: 'name',
};

/** @param {Recipe} a @param {Recipe} b */
function byName(a, b) {
  return a.title.localeCompare(b.title);
}

/** Highest first; unrated sinks to the bottom rather than counting as zero. */
/** @param {Recipe} a @param {Recipe} b */
function byRating(a, b) {
  const ra = a.rating ?? -1;
  const rb = b.rating ?? -1;
  return rb - ra || byName(a, b);
}

/**
 * @param {{ db: IDBDatabase }} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx) {
  /** @type {Recipe[]} */
  const recipes = await listRecords(ctx.db, 'recipe');

  if (recipes.length === 0) {
    return h(
      'section',
      { class: 'empty' },
      h('h1', null, 'No recipes yet'),
      h('p', null, 'Import a recipe file to get started.'),
      h('a', { class: 'button', href: '#/import' }, 'Import recipes'),
    );
  }

  const allTags = [...new Set(recipes.flatMap((r) => r.tags))].sort();
  // Drop remembered tags that no longer exist, or they would filter invisibly.
  for (const tag of state.tags) if (!allTags.includes(tag)) state.tags.delete(tag);

  const results = h('ul', { class: 'recipe-list' });

  /** @param {Recipe} r */
  function matches(r) {
    if (state.minRating > 0 && (r.rating ?? 0) < state.minRating) return false;
    for (const tag of state.tags) if (!r.tags.includes(tag)) return false;
    if (!state.query) return true;
    const haystack = [r.title, ...r.tags, ...r.ingredients.map((i) => i.item)]
      .join(' ')
      .toLowerCase();
    return state.query.split(/\s+/).every((word) => haystack.includes(word));
  }

  function update() {
    const shown = recipes.filter(matches).sort(state.sort === 'rating' ? byRating : byName);
    results.replaceChildren(
      ...(shown.length
        ? shown.map((r) => h('li', null, card(r)))
        : [h('li', { class: 'muted' }, 'Nothing matches.')]),
    );
  }

  const search = h('input', {
    type: 'search',
    class: 'search',
    value: state.query,
    placeholder: `Search ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}`,
    'aria-label': 'Search recipes',
    oninput: (/** @type {Event} */ e) => {
      state.query = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
      update();
    },
  });

  const chips = allTags.map((tag) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(state.tags.has(tag)),
        onclick: (/** @type {Event} */ e) => {
          if (state.tags.has(tag)) state.tags.delete(tag);
          else state.tags.add(tag);
          /** @type {HTMLElement} */ (e.currentTarget).setAttribute('aria-pressed', String(state.tags.has(tag)));
          update();
        },
      },
      tag,
    ),
  );

  // --- rating filter and sort --------------------------------------------

  const minLabel = h('output', { class: 'min-rating-value' });
  function labelMin() {
    minLabel.textContent = state.minRating === 0 ? 'Any rating' : `★ ${state.minRating}+`;
  }
  labelMin();

  const slider = h('input', {
    type: 'range',
    min: '0',
    max: '10',
    step: '1',
    value: String(state.minRating),
    'aria-label': 'Minimum rating',
    oninput: (/** @type {Event} */ e) => {
      state.minRating = Number(/** @type {HTMLInputElement} */ (e.target).value);
      labelMin();
      update();
    },
  });

  const sort = h(
    'select',
    {
      'aria-label': 'Sort by',
      onchange: (/** @type {Event} */ e) => {
        state.sort = /** @type {'name'|'rating'} */ (/** @type {HTMLSelectElement} */ (e.target).value);
        update();
      },
    },
    h('option', { value: 'name', selected: state.sort === 'name' }, 'Name A–Z'),
    h('option', { value: 'rating', selected: state.sort === 'rating' }, 'Highest rated'),
  );

  update();
  return h(
    'section',
    null,
    search,
    h(
      'div',
      { class: 'list-controls' },
      h('label', { class: 'min-rating' }, slider, minLabel),
      sort,
    ),
    chips.length ? h('div', { class: 'chips' }, chips) : null,
    results,
  );
}

/**
 * @param {Recipe} r
 * @returns {HTMLElement}
 */
function card(r) {
  const time = formatMinutes((r.prepMinutes ?? 0) + (r.cookMinutes ?? 0));
  const meta = [
    r.rating ? `★ ${r.rating}/10` : 'Not rated',
    time || null,
    `serves ${r.servings}`,
  ].filter(Boolean);

  return h(
    'a',
    { class: 'card', href: `#/recipe/${encodeURIComponent(r.id)}` },
    h('span', { class: 'card-title' }, r.title),
    h('span', { class: 'card-meta' }, meta.join(' · ')),
    r.tags.length ? h('span', { class: 'card-tags' }, r.tags.join(', ')) : null,
  );
}
