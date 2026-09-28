// @ts-check
import { registered } from './node-test.js';

/**
 * Runs test suites in the page and renders the results. Shared by the main
 * browser suite (index.html) and the real-Drive run (../drive/index.html).
 *
 * A suite is anything that registers tests when loaded: usually a test file's
 * import, or a call that registers the adapter contract for one adapter.
 *
 * @typedef {object} Suite
 * @property {string} name
 * @property {() => Promise<unknown>} load
 */

/** @param {unknown} err */
function describeError(err) {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * @param {Suite[]} suites
 * @param {{ summary: HTMLElement, results: HTMLElement }} into
 * @returns {Promise<{ passed: number, failed: number, skipped: number }>}
 */
export async function runSuites(suites, into) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const suite of suites) {
    const before = registered().length;

    let loadError = null;
    try {
      await suite.load();
    } catch (err) {
      loadError = err;
    }

    const heading = document.createElement('p');
    heading.className = 'suite';
    heading.textContent = suite.name;
    into.results.append(heading);

    const olEl = document.createElement('ol');
    into.results.append(olEl);

    if (loadError) {
      failed += 1;
      const li = document.createElement('li');
      li.className = 'fail';
      li.textContent = 'failed to load suite';
      const pre = document.createElement('pre');
      pre.textContent = describeError(loadError);
      li.append(pre);
      olEl.append(li);
      continue;
    }

    for (const t of registered().slice(before)) {
      const li = document.createElement('li');
      li.textContent = t.name;
      olEl.append(li);

      if (t.skip) {
        skipped += 1;
        li.className = 'skip';
        li.textContent = `${t.name} (${t.skip})`;
        continue;
      }
      li.className = 'running';
      try {
        await t.fn();
        passed += 1;
        li.className = 'pass';
      } catch (err) {
        failed += 1;
        li.className = 'fail';
        const pre = document.createElement('pre');
        pre.textContent = describeError(err);
        li.append(pre);
      }
    }
  }

  const total = passed + failed + skipped;
  into.summary.className = failed ? 'fail' : 'pass';
  into.summary.textContent = `${passed} passed, ${failed} failed, ${skipped} skipped  (${total} total)`;
  document.title = `${failed ? '✗' : '✓'} ${document.title.replace(/^[✓✗] /, '')}`;
  return { passed, failed, skipped };
}
