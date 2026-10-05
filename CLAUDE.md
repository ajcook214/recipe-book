# Recipe & Shopping App — Project Brief

Personal-use recipe book and shopping list web app. Single user (the owner), multiple devices (desktop + phone). Owner is an experienced developer.

## Start here

**The plan is [docs/roadmap.md](docs/roadmap.md)** — remaining work in chunks of
about one session each, plus the **working agreements**: conventions already
paid for that are easy to break by accident. Read that file's agreements before
writing code, and update the chunk's **Status** line when you finish.

```
npm start        # serves the app at http://localhost:8123/ (tools/serve.ps1)
npm test         # 182 Node tests
npm run typecheck
```

Node lives at `C:\Program Files\nodejs`; if `npm` is not found, prepend that to
`PATH` for the call.

The other 59 tests need a browser (IndexedDB) and skip under Node. Run them at
<http://localhost:8123/test/browser/>. Both suites should be green before and
after a session. The adapter contract against real Google Drive is at
<http://localhost:8123/test/drive/>; it needs the owner's sign-in, so it is run
by hand when `src/adapters/drive.js` changes.

Sample data is in `local-data/` (gitignored): five recipes in `import/`, a
shopping list and a catalog in `shopping/`. Load them from the Import screen.
For a copy of the real data, download a backup on Pages (Import → Download a
backup), keep it in `local-data/`, and import it on localhost; localhost
syncs only with `RecipeApp-dev`.

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
  recipes/<id>.json      one file per recipe: recipes/tomato-soup.json
  lists/<id>.json        one file per shopping list: lists/2026-09-30-143205.json
  catalog.json           the common-items catalog (single file)
  images/<uuid>.jpg
```

- One file per record keeps writes small, reduces conflicts, and makes files easy to edit by hand.
- Every record has `id`, `updatedAt`, and `deleted` (tombstone flag). The id is
  the file name, so it is readable: a recipe's is its title as a slug, fixed
  once it exists, and titles are unique by slug; a list's is when it was made.
  List item ids are UUIDs. Details in [docs/schema.md](docs/schema.md).
- Every file carries its own `schemaVersion`, the hook for future migrations.
  There is no `manifest.json`: it was planned, but nothing ever needed it, and
  a version per file migrates one file at a time, hand edits included.

## Sync algorithm

1. Pull remote files with `modifiedTime > lastSync`.
2. Merge per record using last-writer-wins on `updatedAt`. **Exception:** `lists/`
   and `catalog.json` merge per *item* (LWW on each `items[].id` / `key`), because
   checking things off on the phone while the same list is open on the desktop is
   the most likely conflict in this app, and record-level LWW would discard one side.
3. Push dirty local records, checking the remote file `version` before writing so a newer remote change isn't clobbered. (On Drive the version is the file's `headRevisionId`; see `src/adapters/drive.js`.)
4. Propagate deletes as tombstones rather than removing files immediately.
   Tombstones are pruned on sync after 30 days (`KEEP_DELETES_DAYS` in
   `src/core/sync.js`): long enough for every device to have heard of them.
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

1. ~~Storage and sync~~ — done. `merge.js`, `db.js` and `sync.js` are proven
   against an in-memory adapter (`test/helpers/memory-adapter.js`).
2. **Minimal UI** on the local IndexedDB working copy, so the app is usable
   offline on a phone before any sync exists.
3. ~~`DriveAdapter`~~ — done. `src/adapters/drive.js` passes the adapter
   contract against real Drive. The Google sign-in flow (`src/ui/auth.js`)
   and the Sync screen (`src/ui/views/sync.js`) are built too.

`LocalFolderAdapter` is **deferred**. Its remaining value was bulk import, and
the Import screen covers that.

## Engineering approach

This is a personal project. Test where data can be lost (merge, sync, import
validation) and keep everything else light. Favour a usable app over
infrastructure.

## Recipe ingestion (settled)

Claude is the primary ingestion engine. Given a recipe URL or saved HTML, it
writes a recipe JSON file matching docs/schema.md, and the owner loads it on
the Import screen. **The how-to lives in the `ingest-recipe` skill**
([.claude/skills/ingest-recipe/SKILL.md](.claude/skills/ingest-recipe/SKILL.md)):
the writing rules (ingredients are structured facts; steps are summarized
hard, written in Claude's own words, and carry no quantities), and
`tools/ingest.js`, which fetches a page's schema.org `Recipe` JSON-LD and
checks each file with the app's own `normalizeRecipe`.

- **Go through the app, never straight into Drive.** Under the `drive.file`
  scope the app cannot see files it did not create, so a recipe written into
  Drive directly would be invisible. Imported records are pushed on next sync
  and the app creates the Drive files itself.
- **Files, not integrations.** New files wait in `local-data/inbox/`. The owner
  imports them on Pages, and they move to `local-data/imported/`. Writing
  through a Drive connector into an inbox the app opens with Google Picker
  was considered and turned down: it needs an API key and a Picker setup, and
  this public app should stay as simple as possible.
- **`id` is the title as a slug**, because it becomes the file name.
  Re-ingesting a recipe from the same URL gives the same id, and importing it
  updates the one in the app and keeps its rating. Another recipe with a
  title already taken makes the Import screen ask: cancel, replace, or keep
  both.
- **This repo is public: never commit recipe data.** Everything ingested
  stays in `local-data/` (gitignored).

Later, for independence: an in-app JSON-LD importer could handle most sites
deterministically, with no LLM involved. `findRecipes` and `trimRecipe` in
`tools/ingest.js` are a start.

## Common items (settled)

The catalog is what a list suggests as you type and offers as quick-add
buttons. **Typing on a list never adds to it**; it only counts a use of an
entry that exists. Entries arrive by import:

- **Every recipe ingredient**, through the `ingest-recipe` skill, in a file
  stamped so it only fills gaps.
- **Things bought by hand that are worth keeping**, through the
  `common-items` skill
  ([.claude/skills/common-items/SKILL.md](.claude/skills/common-items/SKILL.md)).
  It reviews the lists in a backup with the owner, then writes the whole
  catalog back, stamped for the per-entry merge.

Bulk changes go through Import, never by overwriting the file in Drive.
Sync merges entry by entry either way, and Import reports what it did. The
catalog is not kept in the repo: it is shopping history, and the repo is
public. Dated backups in `local-data/backups/` are its history.

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

- None blocking. The minimal UI (recipes, lists, catalog, import) is live on
  Pages, and `sw.js` makes it open with no signal. Sign-in and the Sync screen
  work against real Drive, and the phone and the desktop sync through it.
  localhost syncs with `RecipeApp-dev`, and only Pages with the real
  `RecipeApp`. Lists can be edited, reordered and archived, the catalog has
  its own screen, backups download from the Import screen, and sync prunes
  deletes after 30 days. Every chunk in the [roadmap](docs/roadmap.md) is
  done; its **Still to check by hand** list is what remains of v1.

Recipe editing and creation is **after v1**, not part of the MVP.
