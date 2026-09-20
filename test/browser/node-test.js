// @ts-check

/**
 * Browser stand-in for `node:test`.
 *
 * test/browser/index.html maps the specifier `node:test` to this module via an
 * import map, so the exact same test files run under `node --test` and in a
 * browser with nothing installed. Only the flat `test(name[, options], fn)`
 * form is supported — no subtests, no hooks. Keep test files flat and they
 * stay runnable in both places.
 */

/**
 * @typedef {object} RegisteredTest
 * @property {string} name
 * @property {() => unknown} fn
 * @property {string|false} skip  A reason string, or false to run.
 */

/** @type {RegisteredTest[]} */
const registry = [];

/**
 * @param {string} name
 * @param {any} optionsOrFn
 * @param {any} [maybeFn]
 * @returns {void}
 */
export function test(name, optionsOrFn, maybeFn) {
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  const options = typeof optionsOrFn === 'function' ? {} : (optionsOrFn ?? {});

  if (typeof fn !== 'function') {
    throw new TypeError(`test("${name}") was given no function to run`);
  }

  /** @type {string|false} */
  let skip = false;
  if (options.skip === true) skip = 'skipped';
  else if (typeof options.skip === 'string') skip = options.skip;
  if (options.todo) skip = typeof options.todo === 'string' ? options.todo : 'todo';

  registry.push({ name, fn, skip });
}

export default test;
export const it = test;

/** @returns {readonly RegisteredTest[]} */
export function registered() {
  return registry;
}
