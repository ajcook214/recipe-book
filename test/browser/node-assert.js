// @ts-check

/**
 * Browser stand-in for `node:assert/strict`.
 *
 * Covers the subset this project uses. Deliberately not a full
 * reimplementation: Date, Map, Set, TypedArray and circular references are not
 * handled, because the records being compared are plain JSON. If a test ever
 * needs one of those, extend this rather than working around it.
 */

export class AssertionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {string|Error|undefined} message
 * @param {string} fallback
 * @returns {never}
 */
function fail_(message, fallback) {
  if (message instanceof Error) throw message;
  throw new AssertionError(message ?? fallback);
}

/**
 * Structural comparison matching assert.deepStrictEqual closely enough for
 * plain JSON: same prototype, same own enumerable keys, values strictly equal.
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;

  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq(a[k], b[k])) return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string|Error} [message]
 * @returns {void}
 */
export function ok(value, message) {
  if (!value) fail_(message, `Expected a truthy value, got ${show(value)}`);
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string|Error} [message]
 * @returns {void}
 */
export function equal(actual, expected, message) {
  if (!Object.is(actual, expected) && actual !== expected) {
    fail_(message, `Expected ${show(expected)}, got ${show(actual)}`);
  }
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string|Error} [message]
 * @returns {void}
 */
export function notEqual(actual, expected, message) {
  if (Object.is(actual, expected) || actual === expected) {
    fail_(message, `Expected a value other than ${show(expected)}`);
  }
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string|Error} [message]
 * @returns {void}
 */
export function deepEqual(actual, expected, message) {
  if (!deepEq(actual, expected)) {
    fail_(message, `Expected ${show(expected)}, got ${show(actual)}`);
  }
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string|Error} [message]
 * @returns {void}
 */
export function notDeepEqual(actual, expected, message) {
  if (deepEq(actual, expected)) {
    fail_(message, `Expected something other than ${show(expected)}`);
  }
}

/**
 * @param {() => unknown} fn
 * @param {unknown} [_expected]
 * @param {string|Error} [message]
 * @returns {void}
 */
export function throws(fn, _expected, message) {
  try {
    fn();
  } catch {
    return;
  }
  fail_(message, 'Expected the function to throw, but it did not');
}

/**
 * @param {string} actual
 * @param {RegExp} expected
 * @param {string|Error} [message]
 * @returns {void}
 */
export function match(actual, expected, message) {
  if (!expected.test(actual)) {
    fail_(message, `Expected ${show(actual)} to match ${expected}`);
  }
}

/**
 * @param {string|Error} [message]
 * @returns {never}
 */
export function fail(message) {
  return fail_(message, 'Failed');
}

const assert = Object.assign(ok, {
  AssertionError,
  ok,
  equal,
  notEqual,
  strictEqual: equal,
  notStrictEqual: notEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual: deepEqual,
  notDeepStrictEqual: notDeepEqual,
  throws,
  match,
  fail,
});

export default assert;
