// @ts-check

/**
 * Errors that form part of the StorageAdapter contract. Adapters throw these;
 * sync catches them by class rather than by sniffing messages, so a Drive HTTP
 * 412 and a File System Access mismatch surface identically.
 */

/**
 * The file changed underneath us. Thrown by write() when the stored version
 * does not match the caller's `expectedVersion`, which is the check that stops
 * a push from clobbering a newer remote edit.
 */
export class VersionConflictError extends Error {
  /**
   * @param {string} path
   * @param {string|null|undefined} expected
   * @param {string|null|undefined} actual
   */
  constructor(path, expected, actual) {
    super(`Version conflict on ${path}: expected ${expected ?? 'no file'}, found ${actual ?? 'no file'}`);
    this.name = 'VersionConflictError';
    this.path = path;
    this.expected = expected ?? null;
    this.actual = actual ?? null;
  }
}

/**
 * No file at that path.
 */
export class NotFoundError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`Not found: ${path}`);
    this.name = 'NotFoundError';
    this.path = path;
  }
}

/**
 * @param {unknown} err
 * @returns {err is VersionConflictError}
 */
export function isVersionConflict(err) {
  return err instanceof VersionConflictError;
}

/**
 * @param {unknown} err
 * @returns {err is NotFoundError}
 */
export function isNotFound(err) {
  return err instanceof NotFoundError;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
