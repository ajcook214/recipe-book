// @ts-check

/**
 * A stand-in for the slice of the Drive v3 REST API that DriveAdapter uses,
 * served through an injected `fetch`. It lets the adapter run under
 * `npm test`, and lets a test do what real Drive will not do on demand:
 * expire a token, rate-limit, fail a write, or leave duplicate files.
 *
 * It is not Drive. It understands only the queries the adapter sends, and
 * throws on anything else, so a new query fails loudly here instead of being
 * answered wrongly. Real Drive has the final word: test/drive/ runs the same
 * contract against it.
 *
 * As under the drive.file scope, every file here is one the app created.
 * My Drive itself is the id 'root', which is never listed, so a folder made
 * with no parent sits at the top. Listings come back newest first, so an
 * adapter relying on the order would be caught.
 *
 * Drive's `version` field "reflects every change made to the file on the
 * server, even those not visible to the user", and real Drive moves it on its
 * own after a write. Here every content read moves it, standing in for that.
 * Only an upload makes a new headRevisionId.
 */

const EPOCH = Date.UTC(2026, 0, 1);
const FOLDER = 'application/vnd.google-apps.folder';

/**
 * @typedef {object} FakeFile
 * @property {string} id
 * @property {string} name
 * @property {string} mimeType
 * @property {string[]} parents
 * @property {number} version            Moves on any change, seen or not.
 * @property {string|undefined} headRevisionId  New with each upload; folders have none.
 * @property {string} createdTime
 * @property {string} modifiedTime
 * @property {boolean} trashed
 * @property {string} content
 */

/**
 * @typedef {object} Failure
 * @property {number} [status]
 * @property {string} [reason]    Drive's error reason, e.g. 'userRateLimitExceeded'.
 * @property {boolean} [network]  Reject, as fetch does with no connection.
 * @property {(method: string, url: URL) => boolean} [when]  Which request to fail; the next one by default.
 */

/**
 * @param {number} status
 * @param {string} reason
 * @param {string} message
 * @returns {Response}
 */
function error(status, reason, message) {
  const body = { error: { code: status, message, errors: [{ reason, message }] } };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** @param {unknown} value */
function json(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Split on `sep` where it is outside quotes and parentheses.
 *
 * @param {string} text
 * @param {string} sep
 * @returns {string[]}
 */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i += 1;
      else if (c === "'") quoted = false;
    } else if (c === "'") quoted = true;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** @param {string} quoted */
function unquote(quoted) {
  return quoted.replace(/\\(.)/g, '$1');
}

export function createFakeDrive() {
  /** @type {Map<string, FakeFile>} */
  const files = new Map();
  /** @type {Failure[]} */
  const failures = [];
  let tick = 0;
  let ids = 0;
  let revisions = 0;

  function nextRevision() {
    revisions += 1;
    return `rev-${revisions}`;
  }

  function stamp() {
    tick += 1;
    return new Date(EPOCH + tick * 1000).toISOString();
  }

  /** @param {FakeFile} file @returns {boolean} */
  function isTrashed(file) {
    if (file.trashed) return true;
    const parent = files.get(file.parents[0] ?? '');
    return parent ? isTrashed(parent) : false;
  }

  /** @param {FakeFile} file @returns {string} */
  function pathOf(file) {
    const parent = files.get(file.parents[0] ?? '');
    return parent ? `${pathOf(parent)}/${file.name}` : file.name;
  }

  /** @param {FakeFile} file */
  function meta(file) {
    const { content, version, ...rest } = file;
    return { ...rest, version: String(version), trashed: isTrashed(file) };
  }

  /**
   * @param {string} text
   * @returns {(file: FakeFile) => boolean}
   */
  function clause(text) {
    let m;
    if ((m = text.match(/^trashed = (true|false)$/))) {
      const want = m[1] === 'true';
      return (file) => isTrashed(file) === want;
    }
    if ((m = text.match(/^name = '((?:[^'\\]|\\.)*)'$/))) {
      const name = unquote(m[1] ?? '');
      return (file) => file.name === name;
    }
    if ((m = text.match(/^'((?:[^'\\]|\\.)*)' in parents$/))) {
      const id = unquote(m[1] ?? '');
      return (file) => file.parents.includes(id);
    }
    if (text.startsWith('(') && text.endsWith(')')) {
      const any = splitTop(text.slice(1, -1), ' or ').map(clause);
      return (file) => any.some((test) => test(file));
    }
    throw new Error(`Fake Drive does not understand the query clause: ${text}`);
  }

  /** @param {URL} url */
  function list(url) {
    const tests = splitTop(url.searchParams.get('q') ?? '', ' and ').map(clause);
    const matching = [...files.values()].filter((file) => tests.every((test) => test(file))).reverse();

    const size = Math.min(Number(url.searchParams.get('pageSize') ?? 100), drive.pageLimit);
    const start = Number(url.searchParams.get('pageToken') ?? 0);
    const page = matching.slice(start, start + size);
    const next = start + size < matching.length ? String(start + size) : undefined;
    return json({ files: page.map(meta), ...(next ? { nextPageToken: next } : {}) });
  }

  /**
   * @param {string} body
   * @param {Headers} headers
   * @returns {{ metadata: any, content: string }}
   */
  function multipart(body, headers) {
    const boundary = (headers.get('Content-Type') ?? '').match(/^multipart\/related; boundary=(.+)$/)?.[1];
    if (!boundary) throw new Error('Fake Drive expected a multipart/related upload');
    const parts = body
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((part) => part.slice(part.indexOf('\r\n\r\n') + 4, -2));
    return { metadata: JSON.parse(parts[0] ?? '{}'), content: parts[1] ?? '' };
  }

  /**
   * @param {any} metadata
   * @param {string} content
   * @returns {FakeFile|Response}
   */
  function create(metadata, content) {
    const parents = metadata.parents ?? ['root'];
    for (const id of parents) {
      if (id !== 'root' && !files.has(id)) return error(404, 'notFound', `File not found: ${id}.`);
    }
    return drive.add({ name: metadata.name, mimeType: metadata.mimeType, parent: parents[0], content });
  }

  /**
   * @param {string} method
   * @param {URL} url
   * @param {string} body
   * @param {Headers} headers
   * @returns {Response}
   */
  function route(method, url, body, headers) {
    const m = url.pathname.match(/^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/);
    if (!m) return error(404, 'notFound', `No such endpoint: ${url.pathname}`);
    const upload = Boolean(m[1]);
    const id = m[2];

    if (!id) {
      if (method === 'GET') return list(url);
      if (method === 'POST') {
        const { metadata, content } = upload ? multipart(body, headers) : { metadata: JSON.parse(body), content: '' };
        const made = create(metadata, content);
        return made instanceof Response ? made : json(meta(made));
      }
    } else {
      const file = files.get(id);
      if (!file) return error(404, 'notFound', `File not found: ${id}.`);
      if (method === 'GET') {
        if (url.searchParams.get('alt') !== 'media') return json(meta(file));
        file.version += 1;
        return new Response(file.content, { status: 200 });
      }
      if (method === 'PATCH') {
        const { metadata, content } = upload ? multipart(body, headers) : { metadata: JSON.parse(body), content: null };
        if (typeof metadata.trashed === 'boolean') file.trashed = metadata.trashed;
        if (content !== null) {
          file.content = content;
          file.headRevisionId = nextRevision();
        }
        file.version += 1;
        file.modifiedTime = stamp();
        return json(meta(file));
      }
    }
    throw new Error(`Fake Drive does not handle ${method} ${url.pathname}`);
  }

  const drive = {
    /**
     * Every request, as "METHOD files/<id>" or "METHOD upload/<id>", with
     * " media" on a content read.
     * @type {string[]}
     */
    requests: [],
    /** @type {string[]} The Authorization header of every request. */
    tokens: [],
    /** Drive pages its listings; lower this to make a listing span pages. */
    pageLimit: 1000,

    /**
     * @param {string|URL|Request} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);

      const where = url.pathname.replace(/^\/drive\/v3\/files/, 'files').replace(/^\/upload\/drive\/v3\/files/, 'upload');
      drive.requests.push(`${method} ${where}${url.searchParams.get('alt') === 'media' ? ' media' : ''}`);
      drive.tokens.push(headers.get('Authorization') ?? '');

      const i = failures.findIndex((f) => !f.when || f.when(method, url));
      if (i >= 0) {
        const [failure] = failures.splice(i, 1);
        if (failure?.network) throw new TypeError('Failed to fetch');
        return error(failure?.status ?? 500, failure?.reason ?? 'backendError', 'Injected failure');
      }
      if (!headers.get('Authorization')?.startsWith('Bearer ')) return error(401, 'authError', 'Missing token');
      return route(method, url, init.body == null ? '' : String(init.body), headers);
    },

    /**
     * Fail one request. Failures queue in order.
     * @param {Failure} failure
     */
    fail(failure) {
      failures.push(failure);
    },

    /**
     * Put a file or folder in place directly, as another device or a person
     * might have. Duplicates are allowed, as they are in Drive.
     *
     * @param {{ name: string, parent?: string, folder?: boolean, mimeType?: string, content?: string }} spec
     * @returns {FakeFile}
     */
    add(spec) {
      ids += 1;
      const time = stamp();
      /** @type {FakeFile} */
      const file = {
        id: `f${ids}`,
        name: spec.name,
        mimeType: spec.folder ? FOLDER : (spec.mimeType ?? 'application/json'),
        parents: [spec.parent ?? 'root'],
        version: 1,
        headRevisionId: spec.folder ? undefined : nextRevision(),
        createdTime: time,
        modifiedTime: time,
        trashed: false,
        content: spec.content ?? '',
      };
      files.set(file.id, file);
      return file;
    },

    /**
     * The newest file at a full path from My Drive, trashed or not.
     * @param {string} path
     * @returns {FakeFile|undefined}
     */
    find(path) {
      return [...files.values()].reverse().find((file) => pathOf(file) === path);
    },

    /** Full paths of every folder not in the trash, sorted. */
    folders() {
      return [...files.values()]
        .filter((file) => file.mimeType === FOLDER && !isTrashed(file))
        .map(pathOf)
        .sort();
    },
  };

  return drive;
}

/** @typedef {ReturnType<typeof createFakeDrive>} FakeDrive */
