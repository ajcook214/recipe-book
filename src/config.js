// @ts-check

/**
 * The Google OAuth client used to sign in for Drive sync, from the
 * `recipe-book` project in the Google Cloud console.
 *
 * Public by design: a browser app has no secret to keep, and Google accepts
 * this ID only from the origins registered on it, https://ajcook214.github.io
 * and http://localhost:8123. Serving the app anywhere else, including another
 * port, needs that origin added to the client first.
 *
 * Google deletes clients left unused for about six months. If sign-in starts
 * failing with "invalid_client", create a new one and replace this ID.
 */
export const GOOGLE_CLIENT_ID = '1015346435916-g9sqgcffkc35vprffi8bmjpthk0n9jik.apps.googleusercontent.com';

/**
 * Only the files this app created. Non-sensitive, so the app needs no review
 * by Google, and it cannot see anything else in the Drive.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
