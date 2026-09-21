// @ts-check
import { listRecords } from '../../core/db.js';
import { formatMinutes, h } from '../dom.js';

/**
 * The recipe book: search and tag filtering over every recipe in the working
 * copy. Filtering re-renders only the results, so the search box keeps focus.
 *
 * @typedef {import('../../core/types.js').Recipe} Recipe
 * @param {{ db: IDBDatabase }} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx) {
  /** @type {Recipe[]} */
  const recipes = (await listRecords(ctx.db, 'recipe')).sort((a, b) =>
    a.title.localeCompare(b.title),
  );

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
  /** @type {Set<string>} */
  const activeTags = new Set();
  let query = '';

  const results = h('ul', { class: 'recipe-list' });

  /** @param {Recipe} r */
  function matches(r) {
    for (const tag of activeTags) if (!r.tags.includes(tag)) return false;
    if (!query) return true;
    const haystack = [r.title, ...r.tags, ...r.ingredients.map((i) => i.item)]
      .join(' ')
      .toLowerCase();
    return query.split(/\s+/).every((word) => haystack.includes(word));
  }

  function update() {
    const shown = recipes.filter(matches);
    results.replaceChildren(
      ...(shown.length
        ? shown.map((r) => h('li', null, card(r)))
        : [h('li', { class: 'muted' }, 'Nothing matches.')]),
    );
  }

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: `Search ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}`,
    'aria-label': 'Search recipes',
    oninput: (/** @type {Event} */ e) => {
      query = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase();
      update();
    },
  });

  const chips = allTags.map((tag) =>
    h(
      'button',
      {
        type: 'button',
        class: 'chip',
        'aria-pressed': 'false',
        onclick: (/** @type {Event} */ e) => {
          const btn = /** @type {HTMLElement} */ (e.currentTarget);
          if (activeTags.has(tag)) activeTags.delete(tag);
          else activeTags.add(tag);
          btn.setAttribute('aria-pressed', String(activeTags.has(tag)));
          update();
        },
      },
      tag,
    ),
  );

  update();
  return h(
    'section',
    null,
    search,
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
    r.rating ? `★ ${r.rating}/10` : null,
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
