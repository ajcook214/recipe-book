# Recipe & Shopping App — Project Brief

Personal-use recipe book and shopping list web app. Single user (the owner), multiple devices (desktop + phone). Owner is an experienced developer.

## Goals & constraints

- **Free forever.** No paid services, no subscriptions.
- **Permanent data ownership.** Data lives as plain files the owner controls and can read without the app.
- **Versioned code.** All app code in Git on GitHub.
- **Offline-first.** Must work in a grocery store with bad reception.

## Architecture decisions (settled)

- **Hosting:** GitHub Pages (public repo; the code contains no secrets).
- **Data backend:** JSON files in the owner's Google Drive, accessed directly from the browser via the Drive v3 REST API. No server, no Apps Script.
  - Alternatives considered and rejected: Google Sheets + Apps Script (shared-secret auth, clunkier), GitHub private repo as data store, Supabase/Firebase (free-tier terms can change, inactivity pausing), OneDrive (clunkier dev setup).
- **Auth:** Google Identity Services token client (browser-only, no client secret). The OAuth client ID is public and restricted to the GitHub Pages origin.
  - Scope: `drive.file` (non-sensitive, no app verification needed).
  - Consent screen stays in "testing" mode with the owner as a test user.
  - Tokens last about 1 hour; the user signs in only when syncing.
- **Offline model:** IndexedDB is the working copy, and the UI only reads/writes IndexedDB. Sync is **manual**: the user taps Sync, then works offline on local data.
- **PWA:** A service worker caches the app shell so the app loads with no signal, and the app is installable to the home screen.

## Storage abstraction

One interface, two swappable adapters, selected by a toggle in the app:

```js
interface StorageAdapter {
  list(path, { modifiedSince })          // -> [{ path, modifiedTime, version }]
  read(path)                             // -> parsed JSON or Blob
  write(path, data, { expectedVersion })
  remove(path)
}
```

- `DriveAdapter`: Google Drive v3 REST API.
- `LocalFolderAdapter`: File System Access API (`showDirectoryPicker`) on a real local folder with the **identical layout**. Only works in Chromium desktop browsers, so it's intended for desktop and development use. Persist the directory handle in IndexedDB; permission is re-prompted per session.

## Data layout

```
RecipeApp/
  manifest.json          { schemaVersion, lastModified }
  recipes/<uuid>.json    one file per recipe
  lists/<uuid>.json      one file per shopping list
  catalog.json           the common-items catalog (single file)
  images/<uuid>.jpg
```

- One file per record keeps writes small, reduces conflicts, and makes files easy to edit by hand.
- Every record has `id` (UUID), `updatedAt`, and `deleted` (tombstone flag).
- `schemaVersion` is a hook for future migrations.

## Sync algorithm

1. Pull remote files with `modifiedTime > lastSync`.
2. Merge per record using last-writer-wins on `updatedAt`. **Exception:** `lists/`
   and `catalog.json` merge per *item* (LWW on each `items[].id` / `key`), because
   checking things off on the phone while the same list is open on the desktop is
   the most likely conflict in this app, and record-level LWW would discard one side.
3. Push dirty local records, checking the remote file `version` before writing so a newer remote change isn't clobbered.
4. Propagate deletes as tombstones rather than removing files immediately.
5. The UI shows the pending (dirty) change count and the last sync time.

## Known gotchas

- With the `drive.file` scope, the app can only see files **it created** (or files opened via Google Picker). Files dropped into the folder through the Drive UI are invisible to the app. For bulk imports, use local mode and then sync, or add a Picker-based import.
- Local folder mode is not available on iOS or Firefox.

## Tooling (settled)

Plain ES modules, no build step. The repo deploys to Pages exactly as it sits.
Type safety comes from `// @ts-check` plus JSDoc annotations, verified by a
`tsc --noEmit` run against a `checkJs` tsconfig. TypeScript is a dev-time
checker only; nothing is emitted and nothing is bundled.

## v1 feature scope (settled)

- Recipe book with **tags/categories**
- Recipe **rating**, 1-10
- **Serving-size scaling** (implies structured ingredient amounts, not free text)
- Shopping lists, built from three sources:
  - a recipe's ingredients
  - a **catalog of common items** (tap to add, no typing)
  - **free-form entries** (e.g. "paper towels")

Deferred past v1: recipe photos and related assets, grouping shopping lists by
store aisle.

## Build order (settled)

Storage and sync first, exercised through `LocalFolderAdapter` so the merge
logic can be proven on desktop with no OAuth involved. `DriveAdapter` and the
Google sign-in flow come after the sync algorithm is correct. UI last.

## Record schemas (settled)

Full field-by-field draft lives in [docs/schema.md](docs/schema.md). The three
decisions behind it:

- **Quantities are decimals** (`qty: 1.5`), rendered through a formatter that
  snaps to kitchen fractions. One number, so scaling and summing are trivial.
- **Ingredients and catalog items share a slug `key`** (`"ground-beef"`) rather
  than a UUID foreign key. Enables dedupe and catalog suggestions with no
  referential integrity to maintain and nothing to break when files are edited
  by hand.
- **List items are stored one line per source**, and combined only at display
  time. Storage keeps full provenance (`from.recipeId`), so backing out a single
  recipe's contribution stays exact.

Ingredients carry `scalable`. Doubling a recipe doubles the beef, not the pinch
of salt.

## Open decisions

- None blocking. Next up is the storage layer.
