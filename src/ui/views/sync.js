// @ts-check
import { createDriveAdapter } from '../../adapters/drive.js';
import { DEV_DRIVE_FOLDER, DRIVE_FOLDER } from '../../config.js';
import { changes, countDirty, getEnvelope, getMeta } from '../../core/db.js';
import { isAuthError, messageOf } from '../../core/errors.js';
import { LAST_RUN_KEY, sync } from '../../core/sync.js';
import { forgetToken, getToken, isReady, loadGoogle, signIn, signedInUntil } from '../auth.js';
import { h } from '../dom.js';

/**
 * The Sync screen: sign in to Google, send and fetch changes, and say plainly
 * what happened.
 *
 * What a sync is doing lives here at module level, not in the rendered view,
 * so a sync carries on when the user wanders off to a list, and the screen
 * picks it up again on the way back.
 *
 * @typedef {import('../../core/sync.js').SyncRun} SyncRun
 * @typedef {{ db: IDBDatabase, flash: (msg: string) => void }} Ctx
 */

const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/** Development syncs with a folder of its own; see config.js. */
const FOLDER = LOCAL ? DEV_DRIVE_FOLDER : DRIVE_FOLDER;

/**
 * Why the last tap did not end in a sync. A sync that ran is shown from its
 * SyncRun instead, which outlives a reload.
 *
 * @typedef {{ kind: 'offline' }
 *   | { kind: 'unreachable', detail: string }
 *   | { kind: 'signin-failed', detail: string }
 *   | { kind: 'expired' }
 *   | { kind: 'failed', detail: string }} Problem
 */

/** @type {null|'signing-in'|'syncing'} */
let busy = null;
/** @type {Problem|null} */
let problem = null;
let loadingGoogle = false;
/** @type {string|null} Why Google's script did not load, until it does. */
let loadError = null;
/** Counts taps, so a sign-in overtaken by a later tap is ignored. */
let taps = 0;

/** @type {{ section: HTMLElement, draw: () => Promise<void> } | null} */
let screen = null;
let queued = false;

const showing = () => Boolean(screen?.section.isConnected);

/**
 * Redraws the screen if it is showing, at most every 100 ms. A timer, like
 * the count in the top bar, so it keeps up while Google's window is in front.
 */
function redraw() {
  if (queued || !showing()) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    if (showing()) void screen?.draw();
  }, 100);
}

window.addEventListener('online', () => {
  loadError = null;
  if (problem?.kind === 'offline') problem = null;
  if (showing()) void prepareGoogle();
  redraw();
});
window.addEventListener('offline', redraw);
// The pending count, as edits and the sync itself change it.
changes.addEventListener('change', redraw);

/** Starts loading Google's script, so sign-in can open straight from the tap. */
async function prepareGoogle() {
  if (isReady() || loadingGoogle || !navigator.onLine) return;
  loadingGoogle = true;
  loadError = null;
  redraw();
  try {
    await loadGoogle();
  } catch (err) {
    loadError = messageOf(err);
  } finally {
    loadingGoogle = false;
    redraw();
  }
}

/** @param {Ctx} ctx */
function onTap(ctx) {
  if (busy === 'syncing') return;
  const tap = (taps += 1);
  problem = null;

  if (!navigator.onLine) {
    problem = { kind: 'offline' };
  } else if (signedInUntil()) {
    void run(ctx);
  } else if (!isReady()) {
    // Only after loading failed; the button is disabled while it loads.
    void prepareGoogle();
  } else {
    // Nothing may be awaited before this, or the browser blocks the window.
    // A second tap while waiting opens a fresh one, in case the first never
    // appeared, and the first is then ignored.
    busy = 'signing-in';
    signIn().then(
      () => {
        if (tap === taps) void run(ctx);
      },
      (err) => {
        if (tap !== taps) return;
        busy = null;
        problem = { kind: 'signin-failed', detail: messageOf(err) };
        redraw();
      },
    );
  }
  redraw();
}

/** @param {Ctx} ctx */
async function run(ctx) {
  busy = 'syncing';
  problem = null;
  redraw();
  try {
    const result = await sync(ctx.db, createDriveAdapter({ getToken, root: FOLDER }));
    const unreachable = result.errors.find((e) => e.phase === 'list');
    if (unreachable) problem = { kind: 'unreachable', detail: unreachable.message };
    else ctx.flash(result.errors.length ? 'Synced, with problems' : 'Synced');
  } catch (err) {
    if (isAuthError(err)) {
      forgetToken();
      problem = { kind: 'expired' };
    } else {
      console.error(err);
      problem = { kind: 'failed', detail: detailOf(err) };
    }
  } finally {
    busy = null;
    redraw();
  }
}

/**
 * @param {Ctx} ctx
 * @returns {Promise<HTMLElement>}
 */
export async function render(ctx) {
  const section = h('section', { class: 'sync' });
  let drawn = 0;

  async function draw() {
    const mine = (drawn += 1);
    const pending = await countDirty(ctx.db);
    /** @type {SyncRun|undefined} */
    const lastRun = await getMeta(ctx.db, LAST_RUN_KEY);
    const report = lastRun ? await reportView(ctx.db, lastRun) : null;
    // A newer draw started while this one waited.
    if (mine !== drawn) return;

    const until = signedInUntil();
    const loading = !until && loadingGoogle && busy === null;
    const label =
      busy === 'syncing'
        ? 'Syncing…'
        : busy === 'signing-in'
          ? 'Waiting for Google…'
          : loading
            ? 'Loading Google sign-in…'
            : 'Sync now';

    const parts = [
      h('h1', null, 'Sync'),
      h(
        'ul',
        { class: 'sync-status' },
        h(
          'li',
          { class: pending ? 'pending' : null },
          pending ? `${plural(pending, 'change')} on this device waiting to be sent.` : 'Nothing waiting to be sent.',
        ),
        lastRun ? null : h('li', null, 'Not synced from this device yet.'),
        h('li', null, until ? `Signed in to Google until ${timeOf(until)}.` : 'Google asks you to sign in when you sync.'),
        navigator.onLine ? null : h('li', null, 'Offline. Everything else works; sync when you have a signal.'),
      ),
      h(
        'button',
        { type: 'button', class: 'button', disabled: busy === 'syncing' || loading, onclick: () => onTap(ctx) },
        label,
      ),
      busy === 'signing-in'
        ? h('p', { class: 'sync-hint' }, "Finish signing in in Google's window. If it didn't open, tap the button again.")
        : null,
      problem ? problemView(problem) : null,
      !problem && !until && loadError && navigator.onLine
        ? box("Couldn't load Google sign-in", 'Tap Sync now to try again.', loadError)
        : null,
      report,
      h(
        'p',
        { class: 'muted small-print' },
        'Syncs with ',
        h('code', null, `My Drive / ${FOLDER}`),
        LOCAL
          ? `, because this copy runs on ${location.host}. The app on GitHub Pages syncs with ${DRIVE_FOLDER}.`
          : '.',
      ),
    ];
    section.replaceChildren(...parts.filter((el) => el !== null));
  }

  screen = { section, draw };
  // Before the first draw, so the button shows it is waiting for Google.
  void prepareGoogle();
  await draw();
  return section;
}

/**
 * The last pass that reached Drive, in sentences.
 *
 * @param {IDBDatabase} db
 * @param {SyncRun} run
 * @returns {Promise<HTMLElement>}
 */
async function reportView(db, run) {
  const merged = await Promise.all(run.conflicts.map(async (path) => (await nameOf(db, path)) ?? path));
  const failures = await Promise.all(
    run.errors.map(async (e) => {
      const name = await nameOf(db, e.path);
      return `${e.phase} ${e.path}${name ? ` (${name})` : ''}: ${e.message}`;
    }),
  );
  const sent = run.pushed
    ? `Sent ${plural(run.pushed, 'change')}`
    : run.errors.some((e) => e.phase === 'push')
      ? 'Nothing sent'
      : 'Nothing to send';
  const received = run.pulled ? `received ${plural(run.pulled, 'change')}` : 'nothing new from Drive';

  return h(
    'section',
    { class: 'sync-report' },
    h('h2', null, `Last synced ${dayAndTime(run.at)}`),
    h('p', null, `${sent}; ${received}.`),
    merged.length ? h('p', null, `Also changed elsewhere during the sync, and merged: ${merged.join(', ')}.`) : null,
    failures.length
      ? [
          h('p', { class: 'sync-trouble' }, `${plural(failures.length, 'file')} did not sync, and will be tried again next time:`),
          h('pre', { class: 'detail' }, failures.join('\n')),
        ]
      : null,
  );
}

/**
 * @param {Problem} p
 * @returns {HTMLElement}
 */
function problemView(p) {
  switch (p.kind) {
    case 'offline':
      return box("You're offline", 'Nothing was synced. Your changes are saved on this device; sync again when you have a signal.');
    case 'unreachable':
      return box("Couldn't reach Google Drive", 'Nothing was synced. Your changes are saved on this device.', p.detail);
    case 'signin-failed':
      return box("Google sign-in didn't finish", 'Nothing was synced.', p.detail);
    case 'expired':
      return box(
        'Google sign-in ran out',
        'Drive stopped accepting it part way through. What had already synced is kept. Tap Sync now to sign in again and finish.',
      );
    case 'failed':
      return box('Sync stopped with an error', 'What had already synced is kept, and the rest is still waiting. Syncing again is safe.', p.detail);
  }
}

/**
 * @param {string} title
 * @param {string} text
 * @param {string} [detail]  shown as copyable text
 * @returns {HTMLElement}
 */
function box(title, text, detail) {
  return h(
    'div',
    { class: 'sync-problem', role: 'alert' },
    h('strong', null, title),
    h('p', null, text),
    detail ? h('pre', { class: 'detail' }, detail) : null,
  );
}

/**
 * What a person would call the record at a path, if this device has it.
 *
 * @param {IDBDatabase} db
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function nameOf(db, path) {
  if (path === 'catalog.json') return 'the catalog';
  if (!path) return null;
  const record = (await getEnvelope(db, path))?.record;
  const name = record?.title ?? record?.name;
  return typeof name === 'string' && name ? `"${name}"` : null;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function detailOf(err) {
  const message = messageOf(err);
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  // Chrome's stack starts with the message; Firefox's does not.
  return stack.includes(message) ? stack : `${message}\n${stack}`.trim();
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function timeOf(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * "today at 2:32 PM", "yesterday at 9:10 AM", "Sep 27 at 6:05 PM".
 *
 * @param {string} iso
 * @returns {string}
 */
function dayAndTime(iso) {
  const date = new Date(iso);
  /** @param {Date} d */
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Rounded, because a day across a clock change is 23 or 25 hours.
  const days = Math.round((midnight(new Date()) - midnight(date)) / 86_400_000);
  const time = timeOf(date.getTime());
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}
