// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keepBoth, normalizeRecipe, placeRecipe, recipeIdFor, slugify } from '../src/core/recipe.js';
import { displayUnit, formatAmount, formatQty, normalizeUnit, parseQty } from '../src/core/quantity.js';

const fixed = { now: () => '2026-09-21T00:00:00.000Z', newId: () => 'new-id' };

/** @param {Partial<any>} [over] */
function raw(over = {}) {
  return {
    id: 'r1',
    updatedAt: '2026-09-20T10:00:00.000Z',
    title: 'Corn Chowder',
    rating: null,
    tags: ['Soup'],
    servings: 8,
    ingredients: [{ qty: 1.5, unit: 'Cup', item: 'milk', note: null, scalable: true }],
    steps: ['Stir.'],
    ...over,
  };
}

// --- import validation -----------------------------------------------------

test('a well-formed recipe imports without warnings', () => {
  const { recipe, warnings } = normalizeRecipe(raw(), fixed);
  assert.deepEqual(warnings, []);
  assert.equal(recipe.id, 'r1');
  assert.equal(recipe.updatedAt, '2026-09-20T10:00:00.000Z', 'an existing timestamp is kept');
  assert.equal(recipe.schemaVersion, 1);
  assert.equal(recipe.deleted, false);
});

test('things that are not recipes are rejected outright', () => {
  assert.throws(() => normalizeRecipe(null), /recipe object/);
  assert.throws(() => normalizeRecipe([raw()]), /recipe object/);
  assert.throws(() => normalizeRecipe(raw({ title: '  ' })), /no title/);
  assert.throws(() => normalizeRecipe(raw({ ingredients: undefined })), /no ingredients/);
});

test('a missing id comes from the title, so the file name is readable', () => {
  const { recipe, warnings } = normalizeRecipe(raw({ id: undefined, title: 'Tomato Soup' }), fixed);
  assert.equal(recipe.id, 'tomato-soup');
  assert.deepEqual(warnings, []);
});

test('a title a file name cannot use gets a random id, with a warning', () => {
  const { recipe, warnings } = normalizeRecipe(raw({ id: undefined, title: '番茄汤' }), fixed);
  assert.equal(recipe.id, 'new-id');
  assert.equal(warnings.length, 1);
});

test('an id that cannot be a file name is replaced, with a warning', () => {
  for (const id of ['../escape', 'recipes/other', '-leading-dash']) {
    const { recipe, warnings } = normalizeRecipe(raw({ id, title: 'Tomato Soup' }), fixed);
    assert.equal(recipe.id, 'tomato-soup', id);
    assert.match(warnings[0] ?? '', /file name/, id);
  }
  // Ids from before readable names still import as they are.
  assert.equal(normalizeRecipe(raw({ id: '31385af4-24eb-4e7f-8760-b371a02d54e5' }), fixed).recipe.id, '31385af4-24eb-4e7f-8760-b371a02d54e5');
});

test('recipe ids read like their titles, and long ones are cut at a word', () => {
  assert.equal(recipeIdFor('Tomato Soup'), 'tomato-soup');
  assert.equal(recipeIdFor("Grandma's Crème Brûlée & Berries!"), 'grandma-s-creme-brulee-berries');
  const long = recipeIdFor('Firecracker Meatballs with Green Beans and Sesame Rice and a Spicy Mayo Drizzle');
  assert.equal(long, 'firecracker-meatballs-with-green-beans-and-sesame-rice-and-a');
  assert.ok(long.length <= 60);
});

// --- name clashes on import --------------------------------------------------

/** @param {string} id @param {string} title @param {Partial<any>} [over] */
function have(id, title, over = {}) {
  return normalizeRecipe(raw({ id, title, source: 'Site A - https://a.example/soup', ...over }), fixed).recipe;
}

test('an import with a new name lands as new', () => {
  const incoming = have('tomato-soup', 'Tomato Soup');
  assert.deepEqual(placeRecipe(incoming, [have('corn-chowder', 'Corn Chowder')]), { kind: 'new' });
});

test('the same recipe imported again updates it', () => {
  const here = have('tomato-soup', 'Tomato Soup', { source: 'Site A: https://a.example/soup' });
  const place = placeRecipe(have('tomato-soup', 'Tomato Soup'), [here]);
  assert.equal(place.kind, 'update', 'same URL, whatever the label around it');
});

test('a different recipe with the same id or name clashes, and is never overwritten silently', () => {
  const here = have('tomato-soup', 'Tomato Soup');
  const otherSite = have('tomato-soup', 'Tomato Soup', { source: 'https://b.example/soup' });
  assert.equal(placeRecipe(otherSite, [here]).kind, 'clash', 'same id, another source');

  const noSource = have('tomato-soup', 'Tomato Soup', { source: null });
  assert.equal(placeRecipe(noSource, [{ ...here, source: null }]).kind, 'clash', 'no source is not proof of anything');

  const sameName = have('31385af4', 'tomato soup!');
  const place = placeRecipe(sameName, [here]);
  assert.equal(place.kind, 'clash', 'a name that slugs the same, under another id');
  assert.equal(place.kind === 'clash' && place.existing.id, 'tomato-soup');
});

test('a deleted recipe holds neither its id nor its name', () => {
  const gone = { ...have('tomato-soup', 'Tomato Soup', { source: 'https://b.example/old' }), deleted: true };
  assert.deepEqual(placeRecipe(have('tomato-soup', 'Tomato Soup'), [gone]), { kind: 'new' });
});

test('keeping both numbers the new one, title and id together', () => {
  const incoming = have('tomato-soup', 'Tomato Soup');
  const here = [have('tomato-soup', 'Tomato Soup')];
  const second = keepBoth(incoming, here);
  assert.equal(second.title, 'Tomato Soup 2');
  assert.equal(second.id, 'tomato-soup-2');

  const third = keepBoth(incoming, [...here, second]);
  assert.equal(third.title, 'Tomato Soup 3');
  assert.equal(third.id, 'tomato-soup-3');
});

test('keeping both skips a number whose id or name is taken, and survives a long title', () => {
  const incoming = have('tomato-soup', 'Tomato Soup');
  const here = [have('tomato-soup', 'Tomato Soup'), have('tomato-soup-2', 'Something Else'), have('x', 'Tomato Soup 3')];
  assert.equal(keepBoth(incoming, here).id, 'tomato-soup-4');

  const title = 'Firecracker Meatballs with Green Beans and Sesame Rice and a Spicy Mayo Drizzle';
  const base = recipeIdFor(title);
  const long = have(base, title);
  const copy = keepBoth(long, [long]);
  assert.equal(copy.id, `${base}-2`, 'the number is not lost to the cut');
  assert.notEqual(copy.id, long.id);
});

test('an out-of-range rating is cleared, not clamped', () => {
  const { recipe, warnings } = normalizeRecipe(raw({ rating: 11 }), fixed);
  assert.equal(recipe.rating, null);
  assert.match(warnings[0] ?? '', /rating/);
});

test('tags and units are normalized; keys are derived when missing', () => {
  const { recipe } = normalizeRecipe(raw({ tags: ['Soup', 'soup', ' Dinner '] }), fixed);
  assert.deepEqual(recipe.tags, ['soup', 'dinner']);
  assert.equal(recipe.ingredients[0]?.unit, 'cup');
  assert.equal(recipe.ingredients[0]?.key, 'milk');
});

test('bad ingredients are repaired or dropped, never imported broken', () => {
  const { recipe, warnings } = normalizeRecipe(
    raw({
      ingredients: [
        { qty: 2, unit: 'tsp', item: 'salt' },
        { qty: 'two', unit: 'cup', item: 'flour' },
        { qty: 1, unit: 'cup' },
        'not an object',
      ],
    }),
    fixed,
  );
  assert.equal(recipe.ingredients.length, 2);
  assert.equal(recipe.ingredients[1]?.qty, null, 'an unparseable qty is cleared');
  assert.equal(recipe.ingredients[1]?.scalable, false, 'and nothing unquantified scales');
  assert.equal(warnings.length, 3);
});

test('slugify makes stable shared keys', () => {
  assert.equal(slugify('Yukon Gold Potatoes'), 'yukon-gold-potatoes');
  assert.equal(slugify('  Jalapeño (fresh) '), 'jalapeno-fresh');
});

// --- quantities ------------------------------------------------------------

test('decimals render as kitchen fractions', () => {
  assert.equal(formatQty(1.5), '1½');
  assert.equal(formatQty(0.25), '¼');
  assert.equal(formatQty(1 / 3), '⅓');
  assert.equal(formatQty(2), '2');
  assert.equal(formatQty(2.9999999), '3');
});

test('scaled thirds come back whole', () => {
  assert.equal(formatQty((1 / 3) * 3), '1');
  assert.equal(formatQty((2 / 3) * 1.5), '1');
});

test('amounts that are not near a fraction show as short decimals', () => {
  assert.equal(formatQty(0.07), '0.07');
  assert.equal(formatQty(1.42), '1.42');
});

test('units pluralize only where English does', () => {
  assert.equal(displayUnit('cup', 2), 'cups');
  assert.equal(displayUnit('cup', 1), 'cup');
  assert.equal(displayUnit('tsp', 3), 'tsp');
});

test('formatAmount scales scalable ingredients only', () => {
  const beef = { qty: 1.5, unit: 'lb', item: 'beef', key: 'beef', note: null, scalable: true };
  const leaf = { qty: 1, unit: null, item: 'bay leaf', key: 'bay-leaf', note: null, scalable: false };
  assert.equal(formatAmount(beef, 2), '3 lb');
  assert.equal(formatAmount(leaf, 2), '1');
  assert.equal(formatAmount({ ...beef, qty: null }, 2), '');
});

test('typed amounts parse the ways a person writes them', () => {
  assert.equal(parseQty('2'), 2);
  assert.equal(parseQty(' 1.5 '), 1.5);
  assert.equal(parseQty('1,5'), 1.5);
  assert.equal(parseQty('.5'), 0.5);
  assert.equal(parseQty('3/4'), 0.75);
  assert.equal(parseQty('1 1/2'), 1.5);
  assert.equal(parseQty('1½'), 1.5);
  assert.equal(parseQty('1 ½'), 1.5);
  assert.equal(parseQty('⅓'), 1 / 3);
});

test('a blank amount is no amount, and nonsense is refused rather than guessed', () => {
  assert.equal(parseQty(''), null);
  assert.equal(parseQty('   '), null);
  for (const bad of ['0', 'lots', '1/0', '2 lb', '-1', '1.2.3', '1,000']) {
    assert.equal(parseQty(bad), undefined, bad);
  }
});

test('every amount formatQty shows parses back to what it shows', () => {
  for (const qty of [0.125, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2.25, 1.42, 0.07, 20, 36]) {
    const shown = formatQty(qty);
    assert.equal(formatQty(/** @type {number} */ (parseQty(shown))), shown, shown);
  }
});

test('typed units are stored singular and short, so they combine', () => {
  assert.equal(normalizeUnit(' Cups '), 'cup');
  assert.equal(normalizeUnit('lbs.'), 'lb');
  assert.equal(normalizeUnit('Tablespoons'), 'tbsp');
  assert.equal(normalizeUnit('loaves'), 'loaf');
  assert.equal(normalizeUnit('oz'), 'oz');
  assert.equal(normalizeUnit('dozen'), 'dozen');
  assert.equal(normalizeUnit('punnet'), 'punnet', 'anything else is kept as typed');
  assert.equal(normalizeUnit(''), null);
});
