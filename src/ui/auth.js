// @ts-check
import { DRIVE_SCOPE, GOOGLE_CLIENT_ID } from '../config.js';
import { AuthError } from '../core/errors.js';

/**
 * Google sign-in for sync, through the Google Identity Services token client.
 *
 * The access token is held in this module and nowhere else: not in IndexedDB,
 * not in localStorage. Closing the app forgets it, and the next sync asks
 * again. Google's tokens last an hour, and after the first time signing in is
 * a window that closes by itself, so keeping one longer would buy little and
 * leave a credential lying around.
 *
 * Google's script is loaded when the Sync screen opens, not with the app. The
 * app has to open in a shop with no signal, where there is nothing to sign in
 * to, and the script is not part of the cached shell.
 */

const SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/**
 * A token counts as expired this long before Google says it is, so it cannot
 * lapse part way through a sync on a slow connection.
 */
const MARGIN_MS = 5 * 60_000;

/** @type {{ value: string, expiresAt: number } | null} */
let token = null;

/** @type {Promise<void> | null} */
let loading = null;

/** @returns {any} Google's oauth2 namespace, once its script has run */
function oauth2() {
  return /** @type {any} */ (window).google?.accounts?.oauth2;
}

/** @returns {boolean} true once sign-in can open on a tap */
export function isReady() {
  return Boolean(oauth2());
}

/**
 * Loads Google's script. Safe to call again: a load that failed is forgotten,
 * so the next call tries afresh.
 *
 * @returns {Promise<void>}
 */
export function loadGoogle() {
  if (isReady()) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.onload = () => (isReady() ? resolve(undefined) : reject(new Error('Google sign-in loaded, but did not start.')));
    script.onerror = () => {
      script.remove();
      reject(new Error(`Could not load Google sign-in from ${SCRIPT_URL}`));
    };
    document.head.append(script);
  }).finally(() => {
    loading = null;
  });
  return /** @type {Promise<void>} */ (loading);
}

/** @returns {number|null} when the current token stops being used, or null if there is none */
export function signedInUntil() {
  return token && Date.now() < token.expiresAt ? token.expiresAt : null;
}

/**
 * The token for DriveAdapter, which asks before every request.
 *
 * @returns {string}
 */
export function getToken() {
  if (!token || Date.now() >= token.expiresAt) throw new AuthError();
  return token.value;
}

/** Drops the token, after storage refused it. */
export function forgetToken() {
  token = null;
}

/**
 * Opens Google's sign-in window, and resolves once it hands back a token.
 *
 * Call it straight from a tap, with nothing awaited first, or the browser
 * blocks the window. After the first consent, Google skips the consent
 * screen and the window closes by itself.
 *
 * @returns {Promise<void>}
 */
export function signIn() {
  const api = oauth2();
  if (!api) return Promise.reject(new Error('Google sign-in has not loaded yet.'));
  return new Promise((resolve, reject) => {
    api
      .initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        // Consent the first time only.
        prompt: '',
        callback: (/** @type {any} */ response) => {
          if (response.error) {
            reject(new Error(describeRefusal(response)));
          } else if (!api.hasGrantedAllScopes(response, DRIVE_SCOPE)) {
            // Google's consent screen lets the user untick Drive access.
            reject(new Error('Google Drive access was not granted. Sign in again and leave the Drive box ticked.'));
          } else {
            const seconds = Number(response.expires_in) || 3600;
            token = { value: response.access_token, expiresAt: Date.now() + seconds * 1000 - MARGIN_MS };
            resolve();
          }
        },
        error_callback: (/** @type {any} */ err) => reject(new Error(describeWindowError(err))),
      })
      .requestAccessToken();
  });
}

/**
 * @param {any} response  a token response carrying `error`
 * @returns {string}
 */
function describeRefusal(response) {
  return [`Google refused: ${response.error}`, response.error_description, response.error_uri]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {any} err  { type, message } from Google's error_callback
 * @returns {string}
 */
function describeWindowError(err) {
  switch (err?.type) {
    case 'popup_failed_to_open':
      return "The browser blocked Google's sign-in window. Allow pop-ups for this site, then try again.";
    case 'popup_closed':
      return 'The sign-in window was closed before it finished.';
    default:
      return `Sign-in failed: ${err?.message || err?.type || 'no reason given'}`;
  }
}
