# Roadmap to a finished v1

Each chunk below is sized for one chat. They are ordered so that every chunk
ends with something working, and nothing waits on a chunk further down the
list. Each one ends the same way: `npm test`, `npm run typecheck`, commit.

Every chat can start cold — `CLAUDE.md` carries the design, this file carries
the plan. The **Start with** line is meant to be pasted in as the first message.

## Where things stand

Done: the working copy (`db.js`), merge and sync (`merge.js`, `sync.js`, proven
against an in-memory adapter), recipes with scaling and ratings, shopping lists
with combining and the catalog, JSON import, a service worker (`sw.js`)
that opens the app with no signal, `DriveAdapter` (`src/adapters/drive.js`),
passing the adapter contract against real Google Drive, Google sign-in
(`src/ui/auth.js`) with a Sync screen (`src/ui/views/sync.js`), editing
lists and the catalog (`src/ui/views/catalog.js`), backups
(`src/core/backup.js`), pruning old deletes on sync, and archiving lists.

231 tests: 172 run under `npm test`, and 59 need a browser (IndexedDB), so they
skip in Node and run at <http://localhost:8123/test/browser/>. Both should be
green before and after every session. The adapter contract also runs against
real Drive at <http://localhost:8123/test/drive/>. That needs a Google sign-in,
so run it by hand whenever `drive.js` changes.

v1 is done: every chunk below is built. Recipes and lists sync between the
desktop and the phone through Drive. What is left is checking by hand (see
**Still to check by hand**, below the chunks), then what comes after v1.

| # | Chunk | Size | Leaves you with |
|---|-------|------|-----------------|
| 1 | Deploy to Pages, working offline | M | A URL that works on your phone in a shop |
| 2 | Google Cloud OAuth setup | S | A client ID the app can use |
| 3 | `DriveAdapter` | L | Drive passing the adapter contract |
| 4 | Sign-in and the Sync screen | M | Recipes on every device |
| 5 | List and catalog editing | M | Amounts, order, and managing staples |
| 6 | Backup, pruning, archiving | S | An exit door and a tidy store |

All six are done.

---

## Every session

**Start:** read `CLAUDE.md` and this file's chunk. Run `npm start`, then
`npm test`. Confirm green *before* changing anything, so a pre-existing failure
is never mistaken for one you caused.

**Finish:** `npm test`, `npm run typecheck`, the browser suite at
<http://localhost:8123/test/browser/>, a real click-through of what changed,
then commit and push. Update the **Status** line of the chunk.

Paste this as the first message, with the chunk's own **Start with** line after
it:

> Read CLAUDE.md and docs/roadmap.md, including the working agreements.

## Working agreements

These are decisions already made and paid for. They are easy to break by
accident in a fresh session, and each one exists for a reason.

**Code**
- Plain ES modules, no build step, no runtime dependencies. Every path stays
  relative — the site is served from a subfolder.
- `// @ts-check` and JSDoc on every file. `npm run typecheck` is strict and
  must pass.
- Build DOM with `h()` from `src/ui/dom.js`. **Never `innerHTML`** — recipe
  content comes from the web.
- **Never `await` between two requests in one IndexedDB transaction**; the
  transaction can go inactive. Chain through `onsuccess` instead, as
  `db.saveLocal` and `db.markSynced` do.
- **In a view, read and change the record in memory before a handler's first
  `await`.** Two handlers can overlap, from two quick taps, and one that read
  the list before the other saved it saves over it. The list view's `add`
  did this until chunk 5, and lost an item.
- **A new file the app loads goes in `SHELL` in `sw.js`**, or the app opens
  online but not in a shop. `test/shell.test.js` fails until it is listed.
  Keep every import static, so a file the app needs is fetched at startup.
- **Adapters throw `AuthError` when storage refuses the sign-in**, and `sync()`
  rejects with it rather than logging a failure per file. Catch it and offer to
  sign in again; re-running sync is always safe.
- **`requestAccessToken()` runs straight from the tap**, with nothing awaited
  before it, or the browser blocks Google's window. That is why Google's
  script is loaded when the Sync screen opens, and the button waits for it.
- **The Google token lives in `auth.js`'s memory only.** Never persist it.

**Offline**
- The service worker serves the app cache-first and checks for a new version
  itself, a few seconds after each open. A deploy reaches the phone on the
  open after one that saw it, and a "new version is ready" banner offers to
  reload sooner. Nothing to bump on deploy.
- **On localhost the worker is off unless the URL has `?sw`**
  (<http://localhost:8123/?sw>), so edits show on the next reload. Loading
  without `?sw` removes it again; that first load can still be the cached
  version, so reload once more.
- To test offline for real, stop the server rather than using a browser toggle.
  The page should still open, from the cache.
- **Google's sign-in script is not part of the shell** and must never go in
  `index.html`. It loads when the Sync screen opens, so a start with no signal
  never waits on Google.

**Data**
- Records are written through `db.saveLocal` (marks it dirty, to push later) or
  `db.saveFromSync`. Never mutate a stored record in place, and set
  `updatedAt` on every edit or last-writer-wins breaks.
- **An adapter's version changes only when content is written.** Sync checks
  each push against the version it last saw. On Drive that is the file's
  `headRevisionId`. Drive's own `version` field moves by itself after a write
  and would turn every push into a false conflict.
- **Deletes are tombstones** (`deleted: true`), never removal from the store.
  `forget()` exists only for pruning something already propagated.
- **Only sync prunes tombstones**, after `KEEP_DELETES_DAYS` (30), and only
  from records with nothing waiting to push: then every tombstone in them has
  reached storage. A deleted record also needs its file to have held the
  tombstone that long, by storage's clock. A file is trashed only if storage
  still has the version this copy last saw. Pulling prunes too, or two devices
  would hand a pruned tombstone back and forth for ever.
- **Imports merge lists and the catalog; they never replace them.** A list on
  this device may hold items not yet synced. An import that changes nothing
  writes nothing, so it adds nothing to push.
- **localhost syncs with `My Drive / RecipeApp-dev`**, and only Pages syncs
  with the real `RecipeApp` (`DEV_DRIVE_FOLDER` in `src/config.js`). Trying
  things out, or a sync bug under development, never touches the real data.
  The Sync screen says which folder it uses.
- **The sync watermark never passes a file that failed to pull.** If any pull
  fails, it stays where it was, so the file is listed again next time.
- **Ids are file names, made to be read** (see `docs/schema.md`). A recipe's
  is its title as a slug (`recipeIdFor`), fixed once it exists. Never rename a
  recipe's id when its title changes: list lines point at it. A list's is when
  it was made (`listIdFor`). Ids from a file are kept if `isSafeId`, so a
  backup imports back onto its own records.
- **An import never overwrites a different recipe silently.** `placeRecipe`
  sorts each import into new, update (same id and same source URL) or clash
  (id or name taken by something else), and a clash asks: cancel, replace, or
  keep both (`keepBoth`).
- List items are stored **one line per source** and combined only for display
  (`groupItems`). `sort` is sparse integers, so moving one item writes one
  number. A row sits where its lowest line does, so a moved row gives every
  line behind it the same value (`sortsForMove`).
- **An edit writes only what changed.** An untouched amount keeps its exact
  value rather than the rounded one its field shows, and only the lines that
  changed get a new `updatedAt`, so they win a merge and nothing else does.
- **A catalog rename keeps the key.** Only the label changes, so the lines
  already on lists still match it, and `findCatalogEntry` finds it by its new
  name or its old one. A name another entry answers to is refused. A list
  item renamed in the app does take the new name's key, so a fixed typo
  combines with the real thing.
- **Every destructive action confirms first**, and says what will happen.

**Tests**
- Test where data can be lost — merge, sync, import validation. Keep the rest
  light. This is a personal project, not a product.
- Tests stay **flat**: `test(name[, options], fn)`, no subtests or hooks, so
  the same file runs in Node and in the browser.
- Pure suites live in `test/`; browser-only suites live in `test/browser/`,
  guard themselves with `{ skip: browserOnly }`, and are registered in the
  `SUITES` array in `test/browser/index.html`.
- For anything that can silently eat data, **check the failure path too**:
  break it on purpose, confirm the tests go red, then put it back.
- **In the browser pane, a `<dialog>`'s `close` event waits for a painted
  frame**, and the pane does not paint while hidden. So `ask()` and
  `editDialog()` seem to hang after a scripted click. Take a screenshot and
  they finish. A visible page is not affected.
- **Every adapter runs the shared contract** in
  `test/helpers/adapter-contract.js`. `DriveAdapter` runs it against a fake
  Drive (`test/helpers/fake-drive.js`) under `npm test`, and against real Drive
  at `test/drive/`. When real Drive shows something the fake missed, teach the
  fake first, so `npm test` catches it from then on.

**Phone**
- Tap targets 44px or larger. Check at 375px wide and confirm
  `document.documentElement.scrollWidth` still equals `clientWidth` — no
  sideways scrolling.

**Repo**
- **Never commit recipe data.** The repo is public. Samples live in
  `local-data/` (gitignored): five recipes in `import/`, a shopping list and a
  catalog in `shopping/`. Load them from the Import screen.
- **New recipes come in through the `ingest-recipe` skill**, never by hand
  into Drive. Its files wait in `local-data/inbox/` until the owner imports
  them on Pages, then move to `local-data/imported/`
  (`node tools/ingest.js archive`).
- Commit at the end of a chunk with everything green, and say plainly what was
  verified and what was not.

---

## 1. Put it on the web, and make it work with no signal

**Status:** done 2026-09-27. Live at <https://ajcook214.github.io/recipe-book/>,
and it opens on the owner's phone in airplane mode. `sw.js` caches the shell; a manifest
and icons make it installable. Verified locally with the server stopped: the
app opened from the cache, and a check-off was saved. Also verified: an update
reaches the page and offers a reload, and a deliberately broken deploy heals
on the open after its fix. On Pages, the worker installs with scope
`/recipe-book/`, and a reload loads the page and its files from the cache with
nothing over the network. Its cache hash matches the one tested locally, so
the files are byte-identical.

On an iPhone, add it to the home screen. Safari deletes a site's storage,
IndexedDB included, after 7 days without a visit, and home-screen apps are
exempt. Until sync exists, that storage is the only copy of your data.

The update strategy differs from the one suggested below, on purpose.
Network-first `index.html` does not help without a build step. The modules
keep the same URLs, so a fresh `index.html` would still load stale modules
from the cache. Instead, the whole shell is fetched as a set, named by its
hash, and swapped in only once all of it has arrived.

**Why first:** it is small, it proves the deployed paths work, and it gives you
the HTTPS origin that chunk 2 has to register. You also get a URL you can open
on your phone before any sync exists.

This is a website you visit, not something installed from a store. The service
worker still matters though: without it, opening the page in a shop with no
signal just fails, and "works in a grocery store with bad reception" is the
whole point.

**Work**
- Enable GitHub Pages on `main` at the repo root. The site lands at
  `https://ajcook214.github.io/recipe-book/`.
- `sw.js`: cache the app shell (`index.html`, `styles.css`, `src/**`) so the
  page opens with no signal. Version the cache name and clean up old caches on
  activate. **This is the part that matters.**
- Register the service worker from `app.js`, guarded so `file://` and the test
  page are unaffected.
- *Optional:* `manifest.webmanifest` plus icons, so the page can be added to
  the home screen and open without browser chrome. Nice, not required — it is
  the same website either way.

**Done when:** the Pages URL loads on your phone over mobile data, and still
loads in airplane mode.

**Watch out**
- The site is served from `/recipe-book/`, not the domain root. Every path must
  stay relative; the service worker's scope is that subfolder.
- A cache-first service worker can pin an old version of the app forever. Decide
  the update strategy deliberately (network-first for `index.html` is the safe
  default).
- No build step means no icon generation, so any icons have to be committed as
  real files. Skippable.

**Start with:** "Read docs/roadmap.md chunk 1 and deploy to GitHub Pages with
offline caching."

---

## 2. Google Cloud OAuth setup

**Status:** done 2026-09-27. `src/config.js` exports `GOOGLE_CLIENT_ID` and
`DRIVE_SCOPE`, from the `recipe-book` Google Cloud project. Both origins were
checked against Google directly. An authorize request with the token client's
redirect form (`storagerelay://…`) reaches the sign-in page from
`https://ajcook214.github.io` and from `http://localhost:8123`, while
`http://localhost:9999` is refused with `redirect_uri_mismatch`. No sign-in was
done; the first real token comes in chunk 4.

No `config.local.js` is needed: one client carries both origins, so localhost
and Pages use the same ID. Google deletes clients left unused for about six
months; if sign-in fails with `invalid_client`, make a new one and replace the
ID.

**Why:** chunk 3 cannot be tested without a client ID, and this is all clicking
in a console rather than code.

**Work** (mostly yours, in the Google Cloud console)
- New project, enable the **Google Drive API**.
- OAuth consent screen: External, **Testing**, add `ajcook214@gmail.com` as a
  test user. Add only the `drive.file` scope, which is non-sensitive and needs
  no verification.
- Create an **OAuth client ID** of type *Web application*. Authorised
  JavaScript origins: `https://ajcook214.github.io` and `http://localhost:8123`.
  No redirect URIs — the token client does not use them.
- Commit the client ID to `src/config.js`. It is public by design and
  restricted by origin; `config.local.js` is already gitignored for a dev
  override.

**Done when:** the client ID is in the repo and both origins are registered.

**Watch out:** in Testing mode, refresh tokens expire after 7 days. That is
fine here, because the app asks for a token only when you tap Sync.

**Start with:** "Walk me through docs/roadmap.md chunk 2, then commit the
client ID."

---

## 3. `DriveAdapter`

**Status:** done 2026-09-27. `src/adapters/drive.js` passes the adapter
contract, now shared in `test/helpers/adapter-contract.js`. It runs against a
fake Drive under `npm test`, and passed 22 of 22 against the owner's real Drive
at `test/drive/`. A test file opened in the Drive web UI reads as plain,
indented JSON.

Decisions made in that chat:
- **The version check is read, then write**, one round trip apart. Drive v3
  has no conditional write (no `If-Match`, no precondition). A write from
  another device that lands in that gap is overwritten. That device still holds
  the edit, though, and its next sync pulls the newer file and merges its copy
  back in. So the edit arrives one sync late rather than being lost.
- **The version is `headRevisionId`, not Drive's `version` field.** The first
  real run failed on this. `version` moved by itself after a write, which would
  have made every push a false conflict. The fake Drive now does the same, and
  a contract test waits five seconds on real Drive to check that only a write
  moves the version. It also showed that every upload makes a new revision,
  even when the content is the same.
- **The path index lives in memory, not in the `meta` store.** A listing asks
  for everything the app can see and rebuilds the index. Under `drive.file`
  that is one or two requests. Sync always lists first, so a persisted index
  could only ever be stale.
- **Duplicates are resolved, not prevented.** Folders that share a path read
  as one folder. Files that share a path resolve to the oldest, the same on
  every device.
- **`remove()` moves a file to the trash**, recoverable for 30 days.
- **Errors:** a 401 is `AuthError`, and `sync()` now rejects with it (see the
  working agreements). Rate limits (429, and 403 rate-limit reasons) are
  retried with backoff. Server and network errors are retried for reads only,
  because a failed upload may have landed anyway.

**Why:** this is the last piece of storage. Everything above it is already
written and tested.

**Work**
- `src/adapters/drive.js` implementing `list`, `read`, `write`, `remove`
  against Drive v3, satisfying `test/adapter-contract.test.js` — that file is
  the specification.
- Path mapping. Drive has file ids, not paths, so the adapter keeps a
  path → fileId index (in the `meta` store) and rebuilds it by listing. Under
  `drive.file` a listing only returns files this app created, which is exactly
  what we want.
- Folder bootstrap: find or create `RecipeApp/`, `recipes/`, `lists/`.
- Writes use the multipart upload endpoint.

**Done when:** the adapter contract suite passes against a real Drive folder,
and the files are readable by hand in the Drive web UI.

**Watch out**
- **The version check is the risky part.** Drive v3 does not honour `If-Match`
  on update the way v2 did, so `expectedVersion` may have to be enforced by
  re-reading the file's `version` immediately before writing. That leaves a
  small window where a concurrent write can be lost. Decide this explicitly in
  that chat rather than letting it happen by accident — `sync.js` depends on
  `VersionConflictError` being thrown when it should be.
- Drive's `version` field changes on every modification, which suits
  `expectedVersion`. `modifiedTime` is RFC 3339, which the sync watermark
  already expects.
- A token can expire mid-sync. A 401 should surface as a clear "sign in again",
  not a failed record.

**Start with:** "Read docs/roadmap.md chunk 3 and build DriveAdapter against
the adapter contract."

---

## 4. Sign-in and the Sync screen

**Status:** done 2026-10-01. On Pages, the owner added the samples on the
desktop, synced them to `My Drive / RecipeApp/`, and synced the phone. A list
changed on both devices, with the phone in airplane mode, merged correctly on
both after each synced. Earlier, on localhost, a real Google sign-in pushed
the same 7 records to `My Drive / RecipeApp-dev/`. Every other path was clicked through in the
browser pane against a stand-in token client and the fake Drive: a second
device's edit and check-off pulled with no new sign-in, a hand-broken file
reported and then pulled once fixed, a token refused part way through, a
closed sign-in window, Drive access unticked, offline, Drive unreachable,
leaving the screen mid-sync, and the layout at 375px.

On the phone, airplane mode first failed with "site can't be reached",
because clearing the site's data had also removed the service worker. One
visit with a signal reinstalled it. See the known gap about the address
without its final slash.

Decisions made in that chat:
- **localhost syncs with `RecipeApp-dev`**, Pages with `RecipeApp` (see the
  working agreements).
- **A failed pull holds the watermark.** Before, a newer file pulled in the
  same pass carried the watermark past the one that failed, and it was not
  listed again until it changed. A weak signal in a shop makes that likely.
- **Each pass that reaches storage is stored as a `SyncRun`** (meta key
  `lastRun`: the `SyncResult` plus when it ran), so the Sync screen shows the
  last report after a reload.
- **The pending count updates live** from `db.changes`, an `EventTarget` that
  fires after each write to the records store commits.
- **Sign-in uses `prompt: ''`**: consent the first time, then a window that
  closes by itself.
- Drive's error reason is now in the message (`Google Drive 403
  (storageQuotaExceeded): …`). Nav links are now 44px tall, and the brand hides
  below 440px wide so four links and the count fit on one line.
- **Readable file names** (the owner's request, made before any real data
  reached Drive, so nothing needed migrating). Recipes are
  `recipes/<title-slug>.json`, unique by slug; lists are
  `lists/<made-at>.json`. A clashing import asks to cancel, replace (the new
  one takes over the old id and keeps its rating), or keep both (numbered).
  The samples in `local-data/` were rewritten to the new ids. Before the
  two-device check, each device's old UUID-keyed copy and the `RecipeApp-dev`
  folder are cleared, and the samples re-imported.

**Why:** the point of the whole project. After this, the phone and the desktop
hold the same data.

**Work**
- Google Identity Services token client. Token held in memory only, never
  persisted; the user signs in when they sync.
- A Sync screen: sign in, the pending-change count (`countDirty`), last sync
  time, a Sync button, and a readable report of what happened (`SyncResult`
  already carries pulled, pushed, conflicts and errors).
- The pending count belongs in the top bar, so it is visible while shopping.
- Handle offline: a Sync tap with no connection should say so plainly.

**Done when:** a recipe added on the desktop appears on the phone after both
sync, and checking something off in the store survives a desktop edit to the
same list. That is `sync.js`'s per-item merge doing its job for real.

**Watch out:** test with the phone genuinely offline, not just the browser's
offline toggle.

**From chunk 3**
- `createDriveAdapter({ getToken })` calls `getToken` on every request, so a
  renewed token takes effect at once. It should throw `AuthError` when there
  is no token.
- `sync()` rejects with `AuthError` when Drive refuses the token. Catch it and
  offer to sign in again.
- `test/drive/index.html` has a working token-client sign-in to start from. It
  checks `hasGrantedAllScopes`, since the user can untick Drive access on
  Google's consent screen.
- Delete `My Drive / RecipeApp-tests/` in the Drive web UI once it is no longer
  useful. The app's listings include it, because the app created it, and only
  filter it out afterwards.

**Start with:** "Read docs/roadmap.md chunk 4 and build the sign-in and Sync
screen."

---

## 5. List and catalog editing

**Status:** done 2026-10-01. Clicked through in the browser pane at 375px,
light and dark, on the samples. Verified: fixing an amount from a recipe
(20 oz to 1 1/2 lbs: stored as 1.5 lb, and the row combines with the other
recipe's 1 lb to 2½ lb), refusing "lots", renaming an item, dragging rows to
the top and between two others, arrow keys on a handle, a common item renamed
("Bread" to "Sourdough") and still found by typing "bread", a clashing rename
refused, pin, delete and re-add, no sideways scroll, 44px targets. Not
verified: dragging with a finger on the phone (the pane sends mouse events),
the page scrolling during a long drag, and the service worker, which the
browser pane will not register. `test/shell.test.js` confirms the new screen
is in the shell.

Decisions made in that chat:
- **Edit is a mode on the list.** It swaps each checkbox for a drag handle
  (☰) and makes a tap open the item. Handles never show while shopping, so a
  thumb scrolling the list in a shop cannot drag anything. The cart rows can
  be edited too.
- **A row from two recipes is edited line by line**, one amount per recipe,
  so taking one recipe off the list still removes exactly its share.
- **Dragging moves the other rows, never the dragged one.** Moving the dragged
  element releases its pointer capture, and the drop never arrives. The first
  version stuck that way. Arrow keys on a handle move a row one place.
- **Amounts are typed as people write them**: `parseQty` takes 2, 1.5, 1,5,
  3/4, 1 1/2 and 1½. Units are stored singular and short (`normalizeUnit`:
  "lbs." to lb, "Cups" to cup), because only stored forms combine.
- **The Common items screen** (`#/catalog`, linked from Lists and from edit
  mode) lists entries in quick-add order, with a Find box once there are ten.
  Rename and the default unit are in a form; pin and delete are on the row.
  It has no add box: the catalog fills itself from lists.
- **A deleted catalog entry starts over** when it is added to a list again:
  unpinned, one use. Before, it came back as it was.
- **Aisle grouping stays deferred.** Dragging rows into store order covers it
  for now.
- **Fixed a lost update in `add`** (see the working agreements): two adds
  close together kept only the second. Seen when typing on straight after
  Enter, which also ran the next item's text into the first.

**Why:** the gaps noticed while using the list screens.

**Work**
- Edit an item's amount, unit and text on a list.
- Reorder items — `sort` is already sparse integers, so moving one is a single
  value change.
- A catalog screen: rename, set a default unit, pin, unpin, delete.
- Optionally, group a list by aisle. This was deferred past v1; it needs a
  category on catalog entries plus an editable aisle order.

**Done when:** you can fix a wrong amount and manage your staples without
editing files.

**Start with:** "Read docs/roadmap.md chunk 5 and build list and catalog
editing."

---

## 6. Backup, pruning, archiving

**Status:** done 2026-10-04. Pruning is proven by seven new sync tests in
`test/browser/sync.test.js`, and each of its five safety checks was broken on
purpose and turned a test red. In the browser pane at 375px, on the samples:
a backup's contents (read from the download link without saving a file), a
restore over changed data (a deleted recipe came back, a list item added
since and a rating given since both survived, everything else unchanged), a
damaged backup refused, Cancel, re-importing the samples writing nothing,
archive and unarchive, the archived list missing from a recipe's list picker,
the Sync report's pruning line, no sideways scroll, 44px targets. Not
verified, and on the list below: a real download on the phone, a restore on
another device, archiving across a sync, and pruning against real Drive,
which cannot happen before 30 days have passed.

Decisions made in that chat:
- **`manifest.json` is dropped** from the layout and the schema. Nothing read
  it, every file already carries `schemaVersion`, and writing it on each sync
  would have been a Drive revision a sync for nothing.
- **A backup is one JSON file, not a zip.** No dependencies means a zip
  writer and reader by hand; one indented JSON file reads without the app
  and imports back. Format in `docs/schema.md`. It leaves out tombstones and
  deleted items, and holds archived lists. The button is on the Import
  screen, which restores it after one question.
- **Restoring merges lists and the catalog** with what is there, and list
  import in general now merges rather than replaces (see the working
  agreements). Recipes go through the ordinary import, so a recipe from the
  same source comes back as the backup has it. Anything unchanged is
  reported as such and not written.
- **Pruning runs inside sync, after 30 days**, matching Drive's trash. A
  pruned record's file goes to the trash; pruned items just leave their
  file. The Sync report says how many were cleared. Details in the working
  agreements and in `prune()` in `sync.js`.
- **Archiving is a button on the list**, with no question, since it is undone
  as easily. Archived lists fold away under "Archived lists" on the Lists
  screen, open as usual, and say so, with Unarchive.
- **The dev data set** is a backup from Pages saved in `local-data/` and
  imported on localhost, which syncs only to `RecipeApp-dev`. For a clean
  start, clear the site's data and delete `RecipeApp-dev` in Drive first.

**Why:** small loose ends, one chat.

**Work**
- **Export everything** as a zip or a single JSON file. The data-ownership goal
  deserves a one-click exit that does not depend on Drive.
- **Use the export as a clean dev data set** (the owner's idea). Once the real
  data is good, an export kept in `local-data/` (gitignored) and imported on
  localhost gives development a known, managed copy of it, which syncs to
  `RecipeApp-dev` and never to the real folder. The Import screen probably
  needs to accept the export's format for this.
- **Prune tombstones.** Deleted records and list items accumulate forever right
  now. Drop them once they are older than the last sync by some margin, so a
  delete cannot come back from a device that has not synced recently.
- **Archive lists.** `archived` is in the schema and the UI filters on it, but
  nothing ever sets it. Last week's shopping list should be archivable, not
  deletable.
- **Decide about `manifest.json`.** It is in the data layout and in
  `docs/schema.md`, but nothing reads or writes it. Either write it on sync, or
  drop it from the schema.

**Start with:** "Read docs/roadmap.md chunk 6."

---

## Still to check by hand

What the tests and the browser pane cannot reach: a real phone, real Drive,
and time. Strike each out here once it has been seen to work.

**This update reaching the phone**
1. Open the app on the phone with a signal. Within a few seconds a "new
   version is ready" banner appears; tap Reload.
2. Then airplane mode, close the app fully, and open it from the home-screen
   icon. It should open, and Lists → Common items, and Import, should both
   load. They are new files in the offline cache.

**Lists (chunk 5)**
3. In edit mode on the phone, drag a row by ☰ with a finger, up and down.
4. On a list longer than the screen, drag a row towards the bottom edge and
   hold it there. The page should scroll by itself.
5. Tap a row in edit mode and change its amount. The keypad should be a
   number pad. Save, then check the amount reads right.
6. Rename a common item and pin another on the phone, sync, then sync the
   desktop. Both changes should be there.

**Archiving**
7. Archive a finished list on the phone and sync. Sync the desktop: the list
   should be under "Archived lists". Unarchive it there, sync both, and it
   should be back on the phone.

**Backups**
8. On the phone: Import → Download a backup. The file should land in
   Downloads as `recipe-book-<date>.json`, and open as readable text.
9. On the desktop, on Pages: sync, then download a backup and save it in
   `local-data/`. On localhost, import it. The question should count what is
   in it; after Restore, the recipes and lists are there. Sync on localhost:
   the Sync screen should name `RecipeApp-dev`, never `RecipeApp`.

**Pruning, from about 3 November 2026**
10. Delete a recipe now, on either device, and sync both. Thirty days on, the
    next sync should report "Cleared out … deletes", and the recipe's file
    should be in Drive's trash rather than in `RecipeApp/recipes`. A list
    item deleted now should likewise be gone from its file.

## Known gaps, deliberately left

Recorded so no session has to rediscover them:

- **A device that does not sync for over 30 days can bring deletes back.**
  Pruning assumes every device syncs within `KEEP_DELETES_DAYS`. One that
  does not keeps showing records deleted elsewhere, and a list item deleted
  elsewhere comes back on its next sync. A record comes back only if that
  device edits it.
- **A deleted list item that reaches storage more than 30 days after it was
  deleted is pruned at once.** Items have no timestamp from storage, so their
  age is the age of the delete. Deleted records do not have this problem.
  It takes a device holding an unsynced delete for a month.
- **`LocalFolderAdapter` is unbuilt**, deferred once the Import screen covered
  bulk import.
- **The sync watermark is the newest `modifiedTime` seen.** A file written
  remotely during a sync pass, stamped earlier than that maximum, is missed
  until it changes again. Effectively impossible with one person syncing by
  hand, but it is a real edge. `DriveAdapter` lists every file on each sync
  anyway, so sync could close this by comparing each file's version with the
  one its envelope holds, instead of filtering on `modifiedTime`.
- **Two devices creating the same path in the same moment leave two files in
  Drive.** The adapter resolves them to the oldest, the same way on every
  device, so nothing is corrupted. The newer copy is hidden, though, and its
  content reaches Drive only when either device next changes that record. It
  takes both devices syncing a new record within the same second.
- **Trashing a folder through the Drive API fails** with
  `403 appNotAuthorizedToChild`, seen on `RecipeApp-tests/` after two test
  runs. Trashing single files works. The app never trashes folders, so this
  was not pursued. Delete test folders in the Drive web UI.
- **Recipe names are unique per device until it syncs.** Two devices that
  each import a different recipe with the same new name, before either
  syncs, share one file, and last-writer-wins keeps the newer. It takes two
  devices importing by hand at once.
- **The address without its final slash does not open offline.** The service
  worker covers only its own folder, `…/recipe-book/`, and GitHub Pages cannot
  send the header that would widen that. So `…/recipe-book`, or
  `…/recipe-book#/lists`, reaches the network, and with no signal it fails,
  unless the phone still remembers GitHub's redirect to the slashed address.
  Every screen inside the app is a `#/…` route on the one page, and all of them
  work offline. Use the home-screen icon, which always opens `start_url`
  (`./`), or a bookmark that ends in `/`.
- **Sign-in from an iPhone home-screen app is untested.** Google's popup may
  not work there. The owner does not use an iPhone, so this is very low
  priority.
- **A rating once came back empty after a reload** and could not be reproduced;
  the save path was verified working. If a rating ever vanishes, that is a
  genuine bug, not a fluke.

## After v1

**Recipe editing and creation.** Essential, but not for the MVP: recipes arrive
by import today, and editing one means changing the JSON and re-importing. The
first thing to build once the build is stable.

- An edit form for every field, including add, remove and reorder of
  ingredients and steps, plus "New recipe" for something with no website.
- Reuse `normalizeRecipe` on save, so hand-edits meet the same bar as imports.
- A new title must be unique by slug, as on import (`placeRecipe`). A rename
  keeps the recipe's id and file; only "New recipe" makes an id.
- The fiddly part is ingredient rows on a phone. Keep amount, unit and item as
  three fields rather than one parsed string.

Also deferred, recorded so they are not forgotten: recipe photos and `images/`,
and grouping shopping lists by store aisle (chunk 5 left it, since rows can be
dragged into store order).
