// @ts-check
import { AuthError, NotFoundError, VersionConflictError, messageOf } from '../core/errors.js';

/**
 * StorageAdapter over Google Drive v3, called straight from the browser with
 * a token from Google sign-in. Files land in one folder in My Drive, laid out
 * exactly like the working copy's paths:
 *
 *   RecipeApp/catalog.json
 *   RecipeApp/recipes/<uuid>.json
 *   RecipeApp/lists/<uuid>.json
 *
 * Paths. Drive addresses files by id, not by path, so each listing rebuilds a
 * path -> file index from names and parent folders. Under the drive.file scope
 * a listing returns only files this app created, so a single query for
 * everything not in the trash stays small, and it is the only query that can
 * see a folder another device created since. The index is held in memory.
 * Sync always starts with list(), which has to ask Drive anyway, so a copy
 * persisted between syncs would save nothing and could only be stale.
 *
 * Duplicates. Drive allows two files with one name in one folder, which is
 * what two devices creating the same path in the same moment leave behind.
 * Folders that share a path read as one folder. Files that share a path
 * resolve to the one created first, so every device picks the same file.
 *
 * Versions. The adapter's version is the file's headRevisionId, not Drive's
 * `version` field. That field "reflects every change made to the file on the
 * server, even those not visible to the user", and on real Drive it moves on
 * its own shortly after a write, so every push would look like a conflict.
 * A head revision changes only when content is uploaded, which is exactly
 * "another device wrote this file".
 *
 * The version check. Drive v3 has no conditional write: no If-Match, and no
 * precondition on files.update. So write() fetches the file's head revision
 * immediately before uploading, compares, and only then uploads. A write from
 * another device that lands inside that gap, one round trip wide, is
 * overwritten. That is accepted, deliberately. The device whose write was
 * overwritten still holds the edit in its working copy. Its next sync pulls
 * the file that replaced it, which is newer than anything it has seen, and
 * merges its copy back in, just as it would have after a caught conflict. The
 * edit arrives one sync late, and is lost only if that device never syncs
 * again.
 *
 * remove() moves a file to the Drive trash rather than deleting it, so a
 * mistaken prune can be undone from the Drive web UI for 30 days.
 */

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,parents,headRevisionId,version,modifiedTime,createdTime';

/**
 * Waits before each retry. Rate limits are retried for any request, because
 * Drive turned the request away without doing it. Server and network errors
 * are retried only for reads: a write that failed that way may have landed
 * anyway, and uploading again could leave two copies of a file.
 */
const BACKOFF_MS = [1000, 2000, 4000];

/**
 * @typedef {object} DriveFile
 * @property {string} id
 * @property {string} name
 * @property {string} mimeType
 * @property {string[]} [parents]
 * @property {string} [headRevisionId]  Changes with each upload; the adapter's version.
 * @property {string} version        Drive's own counter. Moves for changes nobody made, so unused.
 * @property {string} modifiedTime   RFC 3339, as the sync watermark expects.
 * @property {string} createdTime
 * @property {boolean} [trashed]
 */

/**
 * @typedef {object} Index
 * @property {Map<string, DriveFile>} files   Path under the root -> the file it resolves to.
 * @property {Map<string, string[]>} folders  Full folder path from My Drive -> ids, oldest first.
 */

/**
 * @typedef {object} DriveAdapterOptions
 * @property {() => string | Promise<string>} getToken
 *   An access token for the drive.file scope. Asked for on every request, so
 *   a token renewed part way through a sync is used at once. It should throw
 *   AuthError when there is no token to give.
 * @property {string} [root]  Folder path in My Drive holding the data. Tests use their own.
 * @property {typeof fetch} [fetch]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/**
 * Oldest first, ties broken by id, so every device orders files the same way.
 *
 * @param {DriveFile} a
 * @param {DriveFile} b
 * @returns {number}
 */
function byCreation(a, b) {
  const diff = Date.parse(a.createdTime) - Date.parse(b.createdTime);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The version the adapter reports and checks: the head revision, which only
 * an upload changes. Drive's own counter is the fallback for a file with no
 * revisions, which nothing this adapter writes can be.
 *
 * @param {DriveFile} file
 * @returns {string}
 */
function versionOf(file) {
  return file.headRevisionId ?? file.version;
}

/**
 * A string literal for a Drive search query.
 *
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * @param {string} path
 * @returns {[string, string]} the folder ('' at the top) and the file name
 */
function split(path) {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? ['', path] : [path.slice(0, cut), path.slice(cut + 1)];
}

/**
 * @param {DriveFile[]} all  every file and folder the app can see
 * @param {string} root
 * @returns {Index}
 */
function buildIndex(all, root) {
  const byId = new Map(all.map((file) => [file.id, file]));
  /** @type {Map<string, string>} */
  const fullPaths = new Map();

  /**
   * @param {DriveFile} file
   * @param {number} depth  a guard; Drive does not allow cycles
   * @returns {string}
   */
  function fullPath(file, depth = 0) {
    const known = fullPaths.get(file.id);
    if (known !== undefined) return known;
    // A parent the app cannot see is My Drive itself, or a folder made by
    // hand in the web UI. Either way, the app's paths start here.
    const parent = byId.get(file.parents?.[0] ?? '');
    const path =
      parent?.mimeType === FOLDER && depth < 32 ? `${fullPath(parent, depth + 1)}/${file.name}` : file.name;
    fullPaths.set(file.id, path);
    return path;
  }

  const prefix = `${root}/`;
  /** @type {Index} */
  const index = { files: new Map(), folders: new Map() };
  for (const file of [...all].sort(byCreation)) {
    const path = fullPath(file);
    if (file.mimeType === FOLDER) {
      index.folders.set(path, [...(index.folders.get(path) ?? []), file.id]);
    } else if (path.startsWith(prefix)) {
      const relative = path.slice(prefix.length);
      // Sorted oldest first, so the first file seen at a path is the one kept.
      if (!index.files.has(relative)) index.files.set(relative, file);
    }
  }
  return index;
}

/**
 * @param {Response} response
 * @returns {Promise<{ message: string, reason: string }>}
 */
async function describeFailure(response) {
  const text = await response.text().catch(() => '');
  try {
    const { error } = JSON.parse(text);
    return {
      message: String(error?.message ?? response.statusText),
      reason: String(error?.errors?.[0]?.reason ?? ''),
    };
  } catch {
    return { message: text || response.statusText, reason: '' };
  }
}

/**
 * @param {DriveAdapterOptions} options
 */
export function createDriveAdapter(options) {
  const { getToken, root = 'RecipeApp' } = options;
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** @type {Index|null} */
  let index = null;

  /**
   * One Drive request, retried as BACKOFF_MS describes. A 401 is an
   * AuthError straight away: waiting will not bring the token back.
   *
   * @param {string} method
   * @param {string} url
   * @param {{ body?: string, type?: string, missingOk?: boolean }} [init]
   *   missingOk returns a 404 to the caller instead of throwing.
   * @returns {Promise<Response>}
   */
  async function send(method, url, init = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = BACKOFF_MS[attempt];

      /** @type {Record<string, string>} */
      const headers = { Authorization: `Bearer ${await getToken()}` };
      if (init.type) headers['Content-Type'] = init.type;

      /** @type {Response} */
      let response;
      try {
        response = await request(url, { method, headers, body: init.body });
      } catch (err) {
        if (method === 'GET' && wait !== undefined) {
          await sleep(wait);
          continue;
        }
        throw new Error(`Could not reach Google Drive: ${messageOf(err)}`);
      }

      if (response.ok || (response.status === 404 && init.missingOk)) return response;
      if (response.status === 401) throw new AuthError();

      const failure = await describeFailure(response);
      const rateLimited =
        response.status === 429 || (response.status === 403 && /rateLimitExceeded/i.test(failure.reason));
      const retry = rateLimited || (method === 'GET' && response.status >= 500);
      if (retry && wait !== undefined) {
        await sleep(wait);
        continue;
      }
      // Drive's reason (appNotAuthorizedToFile, storageQuotaExceeded...) is
      // often the only useful part, so it goes in the message the user sees.
      const reason = failure.reason ? ` (${failure.reason})` : '';
      throw new Error(`Google Drive ${response.status}${reason}: ${failure.message}`);
    }
  }

  /**
   * @param {string} url
   * @param {boolean} [missingOk]
   * @returns {Promise<any>}  null for a 404 when missingOk
   */
  async function getJson(url, missingOk = false) {
    const response = await send('GET', url, { missingOk });
    return response.status === 404 ? null : response.json();
  }

  /**
   * Upload a file's metadata and content in one request.
   *
   * @param {'POST'|'PATCH'} method
   * @param {string} url
   * @param {object} metadata
   * @param {string} content
   * @returns {Promise<DriveFile>}
   */
  async function upload(method, url, metadata, content) {
    const boundary = `recipe-book-${crypto.randomUUID()}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const response = await send(method, url, { type: `multipart/related; boundary=${boundary}`, body });
    return response.json();
  }

  /** @returns {Promise<Index>} */
  async function refresh() {
    /** @type {DriveFile[]} */
    const all = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: 'trashed = false',
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        spaces: 'drive',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await getJson(`${API}?${params}`);
      all.push(...(page.files ?? []));
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);

    index = buildIndex(all, root);
    return index;
  }

  /**
   * @param {string} dir  under the root; '' for the root itself
   * @returns {string}
   */
  function fullDir(dir) {
    return dir ? `${root}/${dir}` : root;
  }

  /**
   * The file at a path as Drive has it right now, for a write or a remove to
   * check against. A file already in the index is fetched again for its
   * current version; the index can be as old as the last listing.
   *
   * @param {string} path
   * @returns {Promise<DriveFile|null>}
   */
  async function lookup(path) {
    const current = index ?? (await refresh());

    const known = current.files.get(path);
    if (known) {
      /** @type {DriveFile|null} */
      const fresh = await getJson(`${API}/${known.id}?fields=${FIELDS},trashed`, true);
      if (fresh && !fresh.trashed) {
        current.files.set(path, fresh);
        return fresh;
      }
      current.files.delete(path);
    }

    const [dir, name] = split(path);
    const parents = current.folders.get(fullDir(dir));
    // No folder here yet, as far as this device knows. Another device may
    // have made one since, and only a full listing would show it.
    if (!parents) return (await refresh()).files.get(path) ?? null;

    const inParents = parents.map((id) => `${quote(id)} in parents`).join(' or ');
    const params = new URLSearchParams({
      q: `name = ${quote(name)} and (${inParents}) and trashed = false`,
      fields: `files(${FIELDS})`,
      spaces: 'drive',
    });
    /** @type {DriveFile[]} */
    const matches = (await getJson(`${API}?${params}`)).files ?? [];
    const found = matches.filter((file) => file.mimeType !== FOLDER).sort(byCreation)[0] ?? null;
    if (found) current.files.set(path, found);
    return found;
  }

  /**
   * The id of a folder under the root, creating it and any folder above it
   * that is missing. Expects an index that is already fresh for this path,
   * which lookup() has just made sure of.
   *
   * @param {string} dir
   * @returns {Promise<string>}
   */
  async function ensureFolder(dir) {
    const current = index ?? (await refresh());
    /** @type {string|undefined} */
    let parent;
    let path = '';
    for (const name of fullDir(dir).split('/')) {
      path = path ? `${path}/${name}` : name;
      const existing = current.folders.get(path)?.[0];
      if (existing) {
        parent = existing;
        continue;
      }
      const response = await send('POST', `${API}?fields=${FIELDS}`, {
        type: 'application/json',
        body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
      });
      /** @type {DriveFile} */
      const folder = await response.json();
      current.folders.set(path, [folder.id]);
      parent = folder.id;
    }
    if (!parent) throw new Error(`No folder for "${fullDir(dir)}"`);
    return parent;
  }

  return {
    /**
     * @param {string} [prefix]
     * @param {{ modifiedSince?: string|null }} [opts]
     * @returns {Promise<Array<{ path: string, modifiedTime: string, version: string }>>}
     */
    async list(prefix = '', opts = {}) {
      const { files } = await refresh();
      const since = opts.modifiedSince ? Date.parse(opts.modifiedSince) : null;

      const entries = [];
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        if (since !== null && Date.parse(file.modifiedTime) <= since) continue;
        entries.push({ path, modifiedTime: file.modifiedTime, version: versionOf(file) });
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return entries;
    },

    /**
     * Reads the file the last listing found at this path. Sync reads only
     * what it has just listed, so that listing is seconds old.
     *
     * @param {string} path
     * @returns {Promise<any>}
     */
    async read(path) {
      const file = index?.files.get(path) ?? (await refresh()).files.get(path);
      if (!file) throw new NotFoundError(path);

      const response = await send('GET', `${API}/${file.id}?alt=media`, { missingOk: true });
      if (response.status === 404) {
        index?.files.delete(path);
        throw new NotFoundError(path);
      }
      if (!path.endsWith('.json')) return response.blob();

      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(`${path} is not valid JSON: ${messageOf(err)}`);
      }
    },

    /**
     * @param {string} path
     * @param {any} data
     * @param {{ expectedVersion?: string|null }} [opts]
     * @returns {Promise<{ version: string, modifiedTime: string }>}
     */
    async write(path, data, opts = {}) {
      const current = await lookup(path);

      // Compared against undefined, not with `in`: an explicit undefined
      // means unconditional, the same as leaving it out. null means "expect
      // no file here".
      if (opts.expectedVersion !== undefined) {
        const actual = current ? versionOf(current) : null;
        if (actual !== opts.expectedVersion) throw new VersionConflictError(path, opts.expectedVersion, actual);
      }

      // Indented, with a final newline, so the file reads well by hand.
      const content = `${JSON.stringify(data, null, 2)}\n`;
      const query = new URLSearchParams({ uploadType: 'multipart', fields: FIELDS });
      const [dir, name] = split(path);

      const written = current
        ? await upload('PATCH', `${UPLOAD}/${current.id}?${query}`, {}, content)
        : await upload(
            'POST',
            `${UPLOAD}?${query}`,
            { name, mimeType: 'application/json', parents: [await ensureFolder(dir)] },
            content,
          );

      index?.files.set(path, written);
      return { version: versionOf(written), modifiedTime: written.modifiedTime };
    },

    /**
     * Moves the file to the Drive trash. Silent when there is no file.
     *
     * @param {string} path
     * @returns {Promise<void>}
     */
    async remove(path) {
      const current = await lookup(path);
      if (!current) return;
      await send('PATCH', `${API}/${current.id}?fields=id`, {
        type: 'application/json',
        body: JSON.stringify({ trashed: true }),
        missingOk: true,
      });
      index?.files.delete(path);
    },
  };
}

/** @typedef {ReturnType<typeof createDriveAdapter>} DriveAdapter */
