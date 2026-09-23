# Roadmap to a finished v1

Each chunk below is sized for one chat. They are ordered so that every chunk
ends with something working, and nothing waits on a chunk further down the
list. Each one ends the same way: `npm test`, `npm run typecheck`, commit.

Every chat can start cold — `CLAUDE.md` carries the design, this file carries
the plan. The **Start with** line is meant to be pasted in as the first message.

## Where things stand

Done: the working copy (`db.js`), merge and sync (`merge.js`, `sync.js`, proven
against an in-memory adapter), recipes with scaling and ratings, shopping lists
with combining and the catalog, and JSON import. 77 Node tests plus browser
suites at `/test/browser/`.

Missing: any real storage backend, so nothing leaves the browser it was typed
into. Also not deployed anywhere, and it does not yet load without a signal.

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

## 1. Put it on the web, and make it work with no signal

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
