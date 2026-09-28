# Roadmap to a finished v1

Each chunk below is sized for one chat. They are ordered so that every chunk
ends with something working, and nothing waits on a chunk further down the
list. Each one ends the same way: `npm test`, `npm run typecheck`, commit.

Every chat can start cold — `CLAUDE.md` carries the design, this file carries
the plan. The **Start with** line is meant to be pasted in as the first message.

## Where things stand

Done: the working copy (`db.js`), merge and sync (`merge.js`, `sync.js`, proven
against an in-memory adapter), recipes with scaling and ratings, shopping lists
with combining and the catalog, JSON import, and a service worker (`sw.js`)
that opens the app with no signal.

127 tests: 79 run under `npm test`, and 48 need a browser (IndexedDB), so they
skip in Node and run at <http://localhost:8123/test/browser/>. Both should be
green before and after every session.

Missing: any real storage backend, so nothing leaves the browser it was typed
into.

| # | Chunk | Size | Leaves you with |
|---|-------|------|-----------------|
| 1 | Deploy to Pages, working offline | M | A URL that works on your phone in a shop |
| 2 | Google Cloud OAuth setup | S | A client ID the app can use |
| 3 | `DriveAdapter` | L | Drive passing the adapter contract |
| 4 | Sign-in and the Sync screen | M | Recipes on every device |
| 5 | List and catalog editing | M | Amounts, order, and managing staples |
| 6 | Backup, pruning, archiving | S | An exit door and a tidy store |

Chunks 5 and 6 are independent of each other and of everything above. Do them
in any order, or skip them; the app is usable without them.

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
- **A new file the app loads goes in `SHELL` in `sw.js`**, or the app opens
  online but not in a shop. `test/shell.test.js` fails until it is listed.
  Keep every import static, so a file the app needs is fetched at startup.

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

**Data**
- Records are written through `db.saveLocal` (marks it dirty, to push later) or
  `db.saveFromSync`. Never mutate a stored record in place, and set
  `updatedAt` on every edit or last-writer-wins breaks.
- **Deletes are tombstones** (`deleted: true`), never removal from the store.
  `forget()` exists only for pruning something already propagated.
- List items are stored **one line per source** and combined only for display
  (`groupItems`). `sort` is sparse integers, so moving one item writes one
  number.
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

**Phone**
- Tap targets 44px or larger. Check at 375px wide and confirm
  `document.documentElement.scrollWidth` still equals `clientWidth` — no
  sideways scrolling.

**Repo**
- **Never commit recipe data.** The repo is public. Samples live in
  `local-data/` (gitignored): five recipes in `import/`, a shopping list and a
  catalog in `shopping/`. Load them from the Import screen.
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

**Status:** not started.

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

**Status:** not started.

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

**Start with:** "Read docs/roadmap.md chunk 4 and build the sign-in and Sync
screen."

---

## 5. List and catalog editing

**Status:** not started.

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

**Status:** not started.

**Why:** small loose ends, one chat.

**Work**
- **Export everything** as a zip or a single JSON file. The data-ownership goal
  deserves a one-click exit that does not depend on Drive.
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

## Known gaps, deliberately left

Recorded so no session has to rediscover them:

- **Tombstones are never pruned.** Deleted records and list items accumulate
  forever (chunk 6).
- **`archived` is filtered in the UI but never set.** Nothing can archive a
  list yet (chunk 6).
- **`manifest.json` is in the data layout and the schema, but nothing reads or
  writes it.** Either write it on sync or drop it (chunk 6).
- **`LocalFolderAdapter` is unbuilt**, deferred once the Import screen covered
  bulk import.
- **The sync watermark is the newest `modifiedTime` seen.** A file written
  remotely during a sync pass, stamped earlier than that maximum, is missed
  until it changes again. Effectively impossible with one person syncing by
  hand, but it is a real edge.
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
- The fiddly part is ingredient rows on a phone. Keep amount, unit and item as
  three fields rather than one parsed string.

Also deferred, recorded so they are not forgotten: recipe photos and `images/`,
and grouping shopping lists by store aisle (unless it is picked up in chunk 5).
