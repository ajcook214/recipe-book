// @ts-check
/**
 * Helpers for the ingest-recipe skill (.claude/skills/ingest-recipe). The app
 * never loads this file; it runs under Node, on the desktop.
 *
 *   node tools/ingest.js fetch <url|file.html>  the page's schema.org Recipe, trimmed
 *   node tools/ingest.js vocab                  tags, keys and units already in use
 *   node tools/ingest.js check [file...]        lint recipe files, by default the inbox
 *   node tools/ingest.js archive [file...]      move imported files out of the inbox
 *
 * New recipe files wait in local-data/inbox/ until they are imported, then
 * move to local-data/imported/. Both are gitignored with the rest of
 * local-data/: the repo is public, and recipe data never goes in it.
 *
 * `check` runs each file through the app's own normalizeRecipe, so a file it
 * passes imports with no warnings.
 */
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { backupContents, isBackup } from '../src/core/backup.js';
import { messageOf } from '../src/core/errors.js';
import { normalizeUnit } from '../src/core/quantity.js';
import { normalizeRecipe, placeRecipe, recipeIdFor, slugify } from '../src/core/recipe.js';

/** @typedef {import('../src/core/types.js').Recipe} Recipe */

/**
 * @typedef {object} Known
 * @property {Map<string, Recipe>} recipes   by id, live ones only
 * @property {Map<string, string>} catalog   key -> label
 * @property {string[]} sources              the files they came from
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'local-data');
const INBOX = path.join(DATA, 'inbox');
const IMPORTED = path.join(DATA, 'imported');

// Plenty of recipe sites turn away a request that does not look like a browser.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// --- fetch -------------------------------------------------------------------

/**
 * Every schema.org Recipe in a page's JSON-LD. Sites put it at the top, in an
 * array, in an @graph, or under a WebPage's mainEntity, so this walks it all.
 *
 * @param {string} html
 * @returns {any[]}
 */
export function findRecipes(html) {
  /** @type {any[]} */
  const found = [];
  /** @param {any} node */
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      if ([node['@type']].flat().some((t) => /(^|[/:])Recipe$/.test(String(t)))) found.push(node);
      else Object.values(node).forEach(walk);
    }
  };
  for (const [, body = ''] of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(body));
    } catch {
      // Raw line breaks inside strings are the usual fault. A block that
      // still fails is skipped; another may hold the recipe.
      try {
        walk(JSON.parse(body.replace(/[\u0000-\u001f]+/g, ' ')));
      } catch {}
    }
  }
  return found;
}

/** @type {Record<string, string>} */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°',
  frac12: '½', frac14: '¼', frac34: '¾', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

/** @param {string} s */
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, (whole, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Plain text from a JSON-LD value: tags stripped, entities decoded (twice,
 * for the sites that encode them twice), whitespace collapsed. An object
 * gives its `text` or `name`.
 *
 * @param {unknown} v
 * @returns {string}
 */
function text(v) {
  if (v === null || v === undefined) return '';
  const raw = typeof v === 'object' ? (/** @type {any} */ (v).text ?? /** @type {any} */ (v).name ?? '') : v;
  return decode(decode(String(raw).replace(/<[^>]*>/g, ' ')))
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {unknown} v @returns {unknown[]} */
function list(v) {
  return v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * Minutes in an ISO 8601 duration, "PT1H30M" -> 90. Null for none, or for
 * the zero some sites give when they do not know.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function minutes(v) {
  const m = String(v ?? '').match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?)?/i);
  if (!m) return null;
  const total = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return total > 0 ? Math.round(total) : null;
}

/**
 * Instructions as lines, whether they come as one string, strings, HowToSteps
 * or HowToSections. A section's name becomes a "## " line before its steps.
 *
 * @param {unknown} v
 * @returns {string[]}
 */
function instructions(v) {
  if (typeof v === 'string') return v.split(/\n+/).map(text).filter(Boolean);
  /** @type {string[]} */
  const lines = [];
  for (const step of list(v)) {
    const section = /** @type {any} */ (step);
    if (section && typeof section === 'object' && section.itemListElement) {
      if (section.name) lines.push(`## ${text(section.name)}`);
      lines.push(...instructions(section.itemListElement));
    } else if (text(step)) {
      lines.push(text(step));
    }
  }
  return lines;
}

/**
 * What ingestion uses from a Recipe, as plain text. Reviews, ratings, images
 * and video are left behind.
 *
 * @param {any} r
 * @returns {object}
 */
export function trimRecipe(r) {
  return {
    name: text(r.name),
    author: list(r.author).map(text).filter(Boolean).join(', ') || null,
    description: text(r.description) || null,
    yield: list(r.recipeYield).map(text).filter(Boolean),
    prepMinutes: minutes(r.prepTime),
    cookMinutes: minutes(r.cookTime),
    totalMinutes: minutes(r.totalTime),
    category: list(r.recipeCategory).map(text).filter(Boolean),
    cuisine: list(r.recipeCuisine).map(text).filter(Boolean),
    keywords: (typeof r.keywords === 'string' ? r.keywords.split(',') : list(r.keywords)).map(text).filter(Boolean),
    ingredients: list(r.recipeIngredient ?? r.ingredients).map(text).filter(Boolean),
    instructions: instructions(r.recipeInstructions),
  };
}

/**
 * A URL without tracking parameters or a fragment. The app recognises a
 * recipe imported again by its source URL, so the same page must always give
 * the same one.
 *
 * @param {string} url
 * @returns {string}
 */
export function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|mc_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * @param {string} html
 * @param {RegExp} tag  matches the whole tag
 * @param {string} name
 * @returns {string|null}
 */
function attr(html, tag, name) {
  const found = html.match(tag)?.[0];
  const value = found?.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1];
  return value ? decode(value) : null;
}

/** @param {string} target  a URL, or the path of a saved page */
async function fetchCommand(target) {
  if (!target) throw new Error('Usage: node tools/ingest.js fetch <url|file.html>');
  const online = /^https?:\/\//i.test(target);
  let html;
  let finalUrl = null;
  if (online) {
    const res = await fetch(target, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${target}. Try the browser, or a saved copy of the page.`);
    html = await res.text();
    finalUrl = res.url;
  } else {
    html = await readFile(target, 'utf8');
  }

  const canonical =
    attr(html, /<link[^>]+rel=["']canonical["'][^>]*>/i, 'href') ??
    attr(html, /<meta[^>]+property=["']og:url["'][^>]*>/i, 'content') ??
    finalUrl ??
    (online ? target : null);
  const recipes = findRecipes(html).map(trimRecipe);
  console.log(
    JSON.stringify(
      {
        url: canonical && /^https?:\/\//i.test(canonical) ? cleanUrl(canonical) : null,
        site: attr(html, /<meta[^>]+property=["']og:site_name["'][^>]*>/i, 'content'),
        recipes,
      },
      null,
      2,
    ),
  );
  if (recipes.length === 0) {
    console.error('No schema.org Recipe in the JSON-LD. Read the page text instead.');
    process.exitCode = 2;
  }
}

// --- what is already known ---------------------------------------------------

/**
 * @param {string} dir
 * @param {string[]} skip  directories to leave out
 * @returns {Promise<string[]>}
 */
async function jsonFiles(dir, skip = []) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !skip.includes(full)) files.push(...(await jsonFiles(full, skip)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
  }
  return files.sort();
}

/**
 * The recipes and catalog entries in local-data/: backups, the imported
 * archive, the samples, a catalog file. Where a record turns up more than
 * once, the newest copy counts, so an old backup lying around does no harm.
 *
 * @param {string[]} [skip]  directories to leave out
 * @returns {Promise<Known>}
 */
export async function loadKnown(skip = [INBOX]) {
  /** @type {Map<string, any>} */
  const recipes = new Map();
  /** @type {Map<string, any>} */
  const catalog = new Map();
  /** @type {string[]} */
  const sources = [];
  /** @param {Map<string, any>} into @param {string} key @param {any} record */
  const keepNewest = (into, key, record) => {
    const had = into.get(key);
    if (!had || String(record.updatedAt ?? '') > String(had.updatedAt ?? '')) into.set(key, record);
  };

  for (const file of await jsonFiles(DATA, skip)) {
    let raw;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const records = isBackup(raw) ? backupContents(raw) : null;
    const candidates = records ? [...records.recipes, records.catalog] : [raw].flat();
    let used = false;
    for (const r of candidates) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.title === 'string' && Array.isArray(r.ingredients) && typeof r.id === 'string') {
        keepNewest(recipes, r.id, r);
        used = true;
      } else if (Array.isArray(r.items) && r.items.some((/** @type {any} */ i) => typeof i?.label === 'string')) {
        for (const item of r.items) if (typeof item?.key === 'string') keepNewest(catalog, item.key, item);
        used = true;
      }
    }
    if (used) sources.push(path.relative(ROOT, file));
  }

  return {
    recipes: new Map([...recipes].filter(([, r]) => r.deleted !== true)),
    catalog: new Map([...catalog].filter(([, i]) => i.deleted !== true).map(([k, i]) => [k, String(i.label)])),
    sources,
  };
}

/**
 * @param {Iterable<string>} values
 * @returns {string}  "a (3), b (1)", most used first
 */
function counted(values) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => `${v} (${n})`)
    .join(', ');
}

async function vocabCommand() {
  const known = await loadKnown();
  const recipes = [...known.recipes.values()];
  const ingredients = recipes.flatMap((r) => r.ingredients ?? []);
  console.log(`From: ${known.sources.join(', ') || 'nothing yet - no backup or recipes in local-data/'}`);
  console.log(`\nRecipes (${recipes.length}): ${recipes.map((r) => r.id).sort().join(', ')}`);
  console.log(`\nTags: ${counted(recipes.flatMap((r) => r.tags ?? []))}`);
  console.log(`\nCatalog keys: ${[...known.catalog.keys()].sort().join(', ')}`);
  console.log(`\nIngredient keys: ${counted(ingredients.map((i) => i.key).filter(Boolean))}`);
  console.log(`\nUnits: ${counted(ingredients.map((i) => i.unit).filter(Boolean))}`);
}

// --- check -------------------------------------------------------------------

/**
 * An amount in a step: a number, then a unit that measures an ingredient.
 * Times, temperatures and pan sizes ("20 min", "425°F", "5-qt pot",
 * "1/2-inch dice") are left alone.
 */
const AMOUNT =
  /(?:\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞])\s*-?\s*(?:cups?|tbsps?|tablespoons?|tsps?|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|liters?|litres?|cloves?|cans?|sticks?|pinch(?:es)?|slices?)\b/i;

/** Longer than this reads as a paragraph, not a step. */
const LONG_STEP = 280;

/**
 * The URL in a source like "Serious Eats - https://...", as the app reads it.
 *
 * @param {string|null|undefined} source
 * @returns {string|null}
 */
function urlIn(source) {
  return source?.match(/https?:\/\/\S+/)?.[0] ?? null;
}

/**
 * Problems to fix before import, and notes worth a look.
 *
 * @param {any} raw  a parsed recipe file
 * @param {Known} known
 * @returns {{ errors: string[], notes: string[] }}
 */
export function checkRecipe(raw, known) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const notes = [];

  let recipe;
  try {
    const result = normalizeRecipe(raw, { now: () => new Date(0).toISOString() });
    recipe = result.recipe;
    errors.push(...result.warnings);
  } catch (err) {
    return { errors: [messageOf(err)], notes };
  }

  // normalizeRecipe quietly fills or fixes these. The file should be right
  // as written, so it is right when read by hand too.
  const id = recipeIdFor(recipe.title);
  if (raw.id !== id) errors.push(`id should be "${id}", the title as a slug`);

  const ingredients = Array.isArray(raw.ingredients) ? raw.ingredients : [];
  ingredients.forEach((/** @type {any} */ ing, /** @type {number} */ i) => {
    const where = `ingredient ${i + 1} (${ing?.item})`;
    if (typeof ing?.unit === 'string' && normalizeUnit(ing.unit) !== ing.unit) {
      errors.push(`${where}: unit "${ing.unit}" should be "${normalizeUnit(ing.unit)}", or it will not combine on a list`);
    }
    if (typeof ing?.key !== 'string' || ing.key === '') errors.push(`${where}: no key`);
    else if (slugify(ing.key) !== ing.key) errors.push(`${where}: key "${ing.key}" should be "${slugify(ing.key)}"`);
  });

  recipe.steps.forEach((step, i) => {
    const amount = step.match(AMOUNT)?.[0];
    if (amount && !/per serving/i.test(step)) {
      errors.push(`step ${i + 1} has an amount, "${amount}". Amounts live in the ingredients, so scaling stays right.`);
    }
    if (step.length > LONG_STEP) notes.push(`step ${i + 1} is ${step.length} characters; split or trim it`);
  });

  if (!recipe.source || !/https?:\/\//.test(recipe.source)) {
    notes.push('source has no URL, so importing this again will ask instead of updating it');
  }
  if (recipe.rating !== null) notes.push(`rating is ${recipe.rating}; ingestion normally leaves it null`);

  // The app knows a recipe imported again by its id and its source URL
  // together. A re-ingestion titled a little differently gets another id,
  // so it would sit beside the first copy instead of updating it.
  const url = urlIn(recipe.source);
  const sameSource = url ? [...known.recipes.values()].find((r) => urlIn(r.source) === url && r.id !== recipe.id) : null;
  if (sameSource) {
    errors.push(`this page is already in the app as "${sameSource.title}"; use that title and the id "${sameSource.id}", or it imports as a second copy`);
  }

  const place = placeRecipe(recipe, [...known.recipes.values()]);
  if (place.kind === 'update') {
    notes.push(`updates "${place.existing.title}", known from local-data/; Import keeps its rating`);
  } else if (place.kind === 'clash') {
    notes.push(`"${place.existing.title}" (${place.existing.source ?? 'no source'}) already has this name; Import will ask`);
  }

  const knownTags = new Set([...known.recipes.values()].flatMap((r) => r.tags ?? []));
  const newTags = recipe.tags.filter((t) => !knownTags.has(t));
  if (knownTags.size > 0 && newTags.length > 0) notes.push(`new tags: ${newTags.join(', ')}`);

  const knownKeys = new Set([
    ...known.catalog.keys(),
    ...[...known.recipes.values()].flatMap((r) => (r.ingredients ?? []).map((i) => i.key)),
  ]);
  for (const { key } of recipe.ingredients) {
    if (knownKeys.has(key)) continue;
    const near = [`${key}s`, `${key}es`, key.replace(/e?s$/, '')].find((k) => k !== key && knownKeys.has(k));
    if (near) notes.push(`key "${key}" is new, but "${near}" is known; the same thing?`);
  }
  const inCatalog = recipe.ingredients.map((i) => i.key).filter((k) => known.catalog.has(k));
  if (inCatalog.length > 0) notes.push(`in the catalog: ${[...new Set(inCatalog)].join(', ')}`);

  return { errors, notes };
}

/** @param {string[]} files */
async function checkCommand(files) {
  const targets = files.length > 0 ? files : (await jsonFiles(INBOX)).map((f) => path.relative(ROOT, f));
  if (targets.length === 0) {
    console.log('Nothing in local-data/inbox/ to check.');
    return;
  }
  const known = await loadKnown();
  /** @type {Map<string, string>} */
  const ids = new Map();
  let failed = 0;

  for (const file of targets) {
    /** @type {string[]} */
    let errors = [];
    /** @type {string[]} */
    let notes = [];
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      ({ errors, notes } = checkRecipe(raw, known));
      if (typeof raw.id === 'string') {
        if (path.basename(file) !== `${raw.id}.json`) errors.push(`file should be named ${raw.id}.json`);
        if (ids.has(raw.id)) errors.push(`${ids.get(raw.id)} has the same id`);
        ids.set(raw.id, path.basename(file));
      }
    } catch (err) {
      errors = [`not valid JSON: ${messageOf(err)}`];
    }
    if (errors.length > 0) failed += 1;
    console.log(`${file}: ${errors.length === 0 ? 'ok' : `${errors.length} to fix`}`);
    for (const e of errors) console.log(`  fix:  ${e}`);
    for (const n of notes) console.log(`  note: ${n}`);
  }
  if (failed > 0) process.exitCode = 1;
}

// --- archive -----------------------------------------------------------------

/** @param {string[]} files */
async function archiveCommand(files) {
  const targets = files.length > 0 ? files : await jsonFiles(INBOX);
  if (targets.length === 0) {
    console.log('Nothing in local-data/inbox/ to archive.');
    return;
  }
  await mkdir(IMPORTED, { recursive: true });
  for (const file of targets) {
    // Replaces an older copy of the same recipe, from an earlier ingestion.
    await rename(file, path.join(IMPORTED, path.basename(file)));
    console.log(`archived ${path.basename(file)}`);
  }
}

// -----------------------------------------------------------------------------

/** @param {string[]} args */
async function main([command, ...rest]) {
  if (command === 'fetch') await fetchCommand(rest[0] ?? '');
  else if (command === 'vocab') await vocabCommand();
  else if (command === 'check') await checkCommand(rest);
  else if (command === 'archive') await archiveCommand(rest);
  else throw new Error('Usage: node tools/ingest.js fetch <url|file> | vocab | check [file...] | archive [file...]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(messageOf(err));
    process.exitCode = 1;
  });
}
