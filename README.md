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

## Repo conventions

- `.nojekyll` — Pages serves the repo as-is, no Jekyll processing.
- `.gitattributes` — everything normalizes to LF.
- App data is never committed. `/RecipeApp/`, `/local-data/`, and `/data/` are
  ignored so a local-folder dev target can live beside the code safely.

See [CLAUDE.md](CLAUDE.md) for the full design brief and the decisions behind it.
