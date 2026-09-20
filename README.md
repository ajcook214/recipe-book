# Recipe Book

A personal recipe book and shopping list web app. Offline-first, installable,
and free to run forever.

## How it works

- **Hosting:** static site on GitHub Pages. No server, no build secrets.
- **Data:** JSON files in the owner's Google Drive, read and written directly
  from the browser via the Drive v3 REST API.
- **Auth:** Google Identity Services token client, `drive.file` scope. The
  OAuth client ID is public and origin-restricted.
- **Offline:** IndexedDB is the working copy. The UI only ever reads and writes
  IndexedDB; syncing to Drive is a manual, user-triggered action.

Storage sits behind one small interface with two adapters: `DriveAdapter`
(Google Drive) and `LocalFolderAdapter` (File System Access API, Chromium
desktop only, used for development and bulk import).

## Data layout

Identical in Drive and in a local folder:

```
RecipeApp/
  manifest.json          { schemaVersion, lastModified }
  recipes/<uuid>.json
  lists/<uuid>.json
  images/<uuid>.jpg
```

Every record carries `id`, `updatedAt`, and a `deleted` tombstone flag.

## Development

There is no build step and nothing to install. The app is served exactly as it
sits in the repo.

You do need an `http://` origin, though — ES module imports, import maps and
service workers are all blocked from `file://`:

```
powershell -ExecutionPolicy Bypass -File tools/serve.ps1
```

That serves the repo at <http://localhost:8123/> using only what ships with
Windows. Pass `-Port` to change the port.

### Tests

The same test files run two ways.

- **In a browser**, with nothing installed: <http://localhost:8123/test/browser/>.
  An import map points `node:test` and `node:assert/strict` at small shims in
  `test/browser/`, so the standard test files run unmodified.
- **Under Node**: `npm test`. The script globs `test/**/*.test.js` explicitly
  rather than passing a directory — bare `node --test` would also pick up the
  shims in `test/browser/`, since Node treats every `.js` file under a `test/`
  directory as a test file.

Keep tests flat — plain `test(name[, options], fn)`, no subtests or hooks — so
both runners can execute them. Browser-dependent suites guard themselves with
`{ skip }` so the Node run stays green.

Type checking is `tsc --noEmit` against `tsconfig.json` (`checkJs`, `strict`).
TypeScript is a dev-time checker only; nothing is emitted and nothing is
bundled.

## Repo conventions

- `.nojekyll` — Pages serves the repo as-is, no Jekyll processing.
- `.gitattributes` — everything normalizes to LF.
- App data is never committed. `/RecipeApp/`, `/local-data/`, and `/data/` are
  ignored so a local-folder dev target can live beside the code safely.

See [CLAUDE.md](CLAUDE.md) for the full design brief and the decisions behind it.
