// @ts-check
import { listEnvelopes, listRecords, saveLocal } from '../../core/db.js';
import { groupItems, newList } from '../../core/list.js';
import { h } from '../dom.js';

/**
 * All shopping lists, newest first.
 *
 * @typedef {import('../../core/types.js').ShoppingList} ShoppingList
 * @param {{ db: IDBDatabase, navigate: (hash: string) => void }} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx) {
  /** @type {ShoppingList[]} */
  const lists = (await listRecords(ctx.db, 'list'))
    .filter((l) => !l.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const create = h(
    'button',
    {
      type: 'button',
      class: 'button',
      onclick: async () => {
        const taken = new Set((await listEnvelopes(ctx.db, 'list')).map((e) => e.id));
        const list = newList(defaultListName(), taken);
        await saveLocal(ctx.db, 'list', list);
        ctx.navigate(`#/list/${encodeURIComponent(list.id)}`);
      },
    },
    'New list',
  );

  if (lists.length === 0) {
    return h(
      'section',
      { class: 'empty' },
      h('h1', null, 'No shopping lists yet'),
      h('p', null, 'Start one here, or add a recipe to a list from its page.'),
      create,
    );
  }

  return h(
    'section',
    null,
    h('div', { class: 'page-head' }, h('h1', null, 'Shopping lists'), create),
    h(
      'ul',
      { class: 'recipe-list' },
      lists.map((list) => {
        const rows = groupItems(list.items);
        const left = rows.filter((r) => !r.checked).length;
        const summary = rows.length === 0 ? 'Empty' : left === 0 ? 'All done' : `${left} to get · ${rows.length - left} in the cart`;
        return h(
          'li',
          null,
          h(
            'a',
            { class: 'card', href: `#/list/${encodeURIComponent(list.id)}` },
            h('span', { class: 'card-title' }, list.name),
            h('span', { class: 'card-meta' }, summary),
          ),
        );
      }),
    ),
  );
}

/** @returns {string} */
export function defaultListName() {
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Shopping ${date}`;
}
