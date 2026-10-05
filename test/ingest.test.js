// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCatalog } from '../src/core/list.js';
import { mergeCatalog } from '../src/core/merge.js';
import { NEVER, checkCatalog, checkRecipe, cleanUrl, findRecipes, recipeAdditions, trimRecipe } from '../tools/ingest.js';

/*
 * The ingest-recipe skill's helpers. Node only (tools/ingest.js reads the
 * file system), so it is not in the browser SUITES.
 */

/** @param {any} data */
const page = (data) => `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head></html>`;

/** @type {import('../tools/ingest.js').Known} */
const nothingKnown = { recipes: new Map(), catalog: new Map(), sources: [] };

/** @param {Partial<any>} [over] */
function file(over = {}) {
  return {
    id: 'corn-chowder',
    schemaVersion: 1,
    updatedAt: '2026-10-04T00:00:00.000Z',
    deleted: false,
    title: 'Corn Chowder',
    rating: null,
    tags: ['soup'],
    servings: 8,
    prepMinutes: 15,
    cookMinutes: 30,
    source: "Natasha's Kitchen - https://natashaskitchen.com/corn-chowder-recipe/",
    notes: null,
    ingredients: [{ qty: 4, unit: 'cup', item: 'chicken broth', key: 'chicken-broth', note: null, scalable: true }],
    steps: ['Simmer the broth with the cobs, 20 min.'],
    ...over,
  };
}

// --- fetch -------------------------------------------------------------------

test('finds a Recipe at the top, in an @graph, or under mainEntity', () => {
  const recipe = { '@type': 'Recipe', name: 'Soup' };
  assert.equal(findRecipes(page(recipe)).length, 1);
  assert.equal(findRecipes(page({ '@graph': [{ '@type': 'WebSite' }, recipe] })).length, 1);
  assert.equal(findRecipes(page({ '@type': 'WebPage', mainEntity: recipe })).length, 1);
  assert.equal(findRecipes(page([{ '@type': ['Recipe', 'NewsArticle'], name: 'Soup' }])).length, 1);
});

test('a broken JSON-LD block is skipped, and the next one still read', () => {
  const html = '<script type="application/ld+json">{ not json</script>' + page({ '@type': 'Recipe', name: 'Soup' });
  assert.equal(findRecipes(html)[0].name, 'Soup');
});

test('a raw line break inside a string does not lose the recipe', () => {
  const html = '<script type="application/ld+json">{"@type": "Recipe", "name": "Corn\nChowder"}</script>';
  assert.equal(findRecipes(html).length, 1);
});

test('trimming flattens sections, decodes entities and reads durations', () => {
  const trimmed = /** @type {any} */ (
    trimRecipe({
      name: 'Mac &amp;amp; Cheese',
      recipeYield: 4,
      prepTime: 'PT1H30M',
      cookTime: 'PT0M',
      keywords: 'pasta, cheese',
      recipeIngredient: ['1 &frac12; cups <b>milk</b>'],
      recipeInstructions: [
        { '@type': 'HowToSection', name: 'Sauce', itemListElement: [{ '@type': 'HowToStep', text: 'Melt&nbsp;butter.' }] },
        'Stir.',
      ],
    })
  );
  assert.equal(trimmed.name, 'Mac & Cheese');
  assert.deepEqual(trimmed.yield, ['4']);
  assert.equal(trimmed.prepMinutes, 90);
  assert.equal(trimmed.cookMinutes, null, 'a zero duration means unknown');
  assert.deepEqual(trimmed.keywords, ['pasta', 'cheese']);
  assert.deepEqual(trimmed.ingredients, ['1 ½ cups milk']);
  assert.deepEqual(trimmed.instructions, ['## Sauce', 'Melt butter.', 'Stir.']);
});

test('a source URL loses tracking and its fragment, so the same page matches itself', () => {
  assert.equal(cleanUrl('https://x.com/soup/?utm_source=pin&fbclid=1#recipe'), 'https://x.com/soup/');
  assert.equal(cleanUrl('https://x.com/soup/?page=2&utm_medium=x'), 'https://x.com/soup/?page=2');
});

// --- check -------------------------------------------------------------------

test('a well-formed file passes', () => {
  assert.deepEqual(checkRecipe(file(), nothingKnown).errors, []);
});

test('an amount in a step must move to the ingredients', () => {
  for (const step of ['Add 2 tbsp butter.', 'Stir in 1/2 cup milk.', 'Add ½ tsp salt.', 'Add 3 cloves garlic.']) {
    assert.equal(checkRecipe(file({ steps: [step] }), nothingKnown).errors.length, 1, step);
  }
});

test('times, temperatures, pan sizes and per-serving water are not amounts', () => {
  const steps = [
    'Bake at 425°F for 20 min.',
    'Use a 5-qt Dutch oven and a 9x13-inch dish.',
    'Cut into 1/2-inch dice.',
    'Reserve about 1/4 cup pasta water per serving.',
  ];
  assert.deepEqual(checkRecipe(file({ steps }), nothingKnown).errors, []);
});

test('the id, units and keys must be right as written, not fixed on import', () => {
  const { errors } = checkRecipe(
    file({
      id: 'chowder',
      ingredients: [
        { qty: 2, unit: 'Tablespoons', item: 'butter', key: 'butter', note: null, scalable: true },
        { qty: 1, unit: 'cup', item: 'Ground Beef', key: 'Ground Beef', note: null, scalable: true },
        { qty: 1, unit: null, item: 'onion', note: null, scalable: true },
      ],
    }),
    nothingKnown,
  );
  assert.deepEqual(errors, [
    'id should be "corn-chowder", the title as a slug',
    'ingredient 1 (butter): unit "Tablespoons" should be "tbsp", or it will not combine on a list',
    'ingredient 2 (Ground Beef): key "Ground Beef" should be "ground-beef"',
    'ingredient 3 (onion): no key',
  ]);
});

test('anything the app would warn about on import is an error here', () => {
  const { errors } = checkRecipe(file({ servings: null }), nothingKnown);
  assert.equal(errors.length, 1);
  assert.match(/** @type {string} */ (errors[0]), /servings/);
});

test('says when a file updates a known recipe, or clashes with one', () => {
  const known = { ...nothingKnown, recipes: new Map([['corn-chowder', /** @type {any} */ (file({ rating: 9 }))]]) };
  assert.match(checkRecipe(file(), known).notes.join('\n'), /updates "Corn Chowder"/);
  const other = file({ source: 'https://elsewhere.com/chowder' });
  assert.match(checkRecipe(other, known).notes.join('\n'), /already has this name/);
});

test('a page already in the app under another title must reuse that title and id', () => {
  const known = { ...nothingKnown, recipes: new Map([['corn-chowder', /** @type {any} */ (file())]]) };
  const again = file({ id: 'fresh-corn-chowder', title: 'Fresh Corn Chowder' });
  assert.match(checkRecipe(again, known).errors.join('\n'), /already in the app as "Corn Chowder"/);
});

test('notes a new key that looks like a known one', () => {
  const known = { ...nothingKnown, catalog: new Map([['eggs', 'Eggs']]) };
  const egg = file({ ingredients: [{ qty: 2, unit: null, item: 'egg', key: 'egg', note: null, scalable: true }] });
  assert.match(checkRecipe(egg, known).notes.join('\n'), /"egg" is new, but "eggs" is known/);
});

// --- common items from recipes ---------------------------------------------------

test('every recipe ingredient becomes a common item that only fills a gap', () => {
  const additions = recipeAdditions(
    [
      file({ ingredients: [{ key: 'yellow-onion' }, { key: 'salt' }] }),
      file({ ingredients: [{ key: 'salt' }, { key: 'yukon-gold-potatoes' }] }),
    ],
    new Map([['yukon-gold-potatoes', 'Yukon Gold potatoes']]),
  );
  assert.deepEqual(
    additions.items.map((c) => [c.key, c.label, c.useCount, c.updatedAt]),
    [
      ['salt', 'Salt', 0, NEVER],
      ['yellow-onion', 'Yellow onion', 0, NEVER],
      ['yukon-gold-potatoes', 'Yukon Gold potatoes', 0, NEVER],
    ],
  );
});

test('importing them never changes a common item the app already has', () => {
  const at = '2026-09-30T12:00:00.000Z';
  /** @param {string} key @param {Partial<any>} over */
  const entry = (key, over) => ({
    key, label: key, defaultUnit: null, useCount: 5, lastUsedAt: at, pinned: false, deleted: false, updatedAt: at, ...over,
  });
  const app = {
    schemaVersion: 1,
    updatedAt: at,
    items: [entry('paper-towels', { label: 'Kitchen roll', pinned: true }), entry('salt', { deleted: true })],
  };
  const additions = recipeAdditions([file({ ingredients: [{ key: 'paper-towels' }, { key: 'salt' }, { key: 'onion' }] })]);
  // Through normalizeCatalog, as the Import screen reads a file.
  const merged = mergeCatalog(app, normalizeCatalog(JSON.parse(JSON.stringify(additions))).catalog);
  const find = (/** @type {string} */ key) => merged?.items.find((c) => c.key === key);

  assert.deepEqual(find('paper-towels'), app.items[0], 'renamed and pinned, as it was');
  assert.deepEqual(find('salt'), app.items[1], 'deleted, as it was');
  assert.equal(find('onion')?.updatedAt, NEVER, 'the missing one is added');
});

test('a common-items file that would win every merge by accident is refused', () => {
  const { errors } = checkCatalog({ items: [{ key: 'milk', label: 'Milk' }] });
  assert.match(errors.join('\n'), /no updatedAt/);
});
