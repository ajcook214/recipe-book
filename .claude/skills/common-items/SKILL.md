---
name: common-items
description: Review and manage the recipe app's common items (the catalog behind a list's suggestions and quick-add buttons) against the owner's shopping lists, from a backup. Use when the owner asks to review, clean up, update or bulk-edit the common items or catalog, or to find things on their lists worth keeping.
---

# Review the common items

The common items are what a shopping list suggests as you type and offers as
quick-add buttons, pinned ones first, then the most added. They grow two
ways:
- **Recipe ingredients**, always. Importing a recipe adds the ones missing,
  and changes none that exist.
- **Things bought by hand that are worth keeping**, chosen in a review like
  this one.

Typing an item on a list never creates a common item, so a typo or a one-off
purchase is not remembered for good. It only counts a use of a common item
that already exists.

A review works on a backup, at the desktop, with the owner. You never write
to Drive: under the `drive.file` scope the app cannot see files it did not
create. The result is one file the owner imports.

The repo is public. Backups and review files live only in `local-data/`
(gitignored). Never commit them.

```
node tools/common-items.js review [backup.json]   # report, and a copy to edit
node tools/common-items.js write                  # the edited copy, as a file to import
node tools/ingest.js archive                      # after the import
```

## Steps

1. **Get a fresh backup.** The owner opens
   <https://ajcook214.github.io/recipe-book/> on the desktop, taps Sync so
   it has the phone's changes, then Import → Download a backup. It lands in
   `C:\Users\kille\Downloads` as `recipe-book-<date>.json`. Move it into
   `local-data/backups/`. Keep old backups there: they are the history, and
   importing one restores it.

2. **Review**: `node tools/common-items.js review`. It reads the newest
   backup and prints:
   - things added by hand that are not common items, by how many lists they
     were on, with any that look like an existing common item
   - recipe ingredients that are not common items yet. They are already in
     the copy, and need no approval.
   - common items to look at: added once or never (often typos and one-offs
     from before typing stopped creating them), or looking like another one
   - common items on half the lists or more that are not pinned

   It also writes `local-data/review/catalog.json`, the copy you edit.

3. **Propose** changes to the owner, grouped, with the reason for each:
   - **Add**: bought on more than one list, a real product, spelled right.
     One list is usually a one-off. Ask if unsure.
   - **Fix**: a typo or a second spelling of an existing item. Keep the
     better-named entry, add the other's `useCount` to it, and take the
     other out.
   - **Remove**: one-offs and typos. List every removal by name and get a
     clear yes for them, because removing deletes on every device.
   - **Pin**: things on most lists.
   - **Rename** or **set a unit**, where it helps.

   The owner may also ask for bulk changes of their own. Wait for their
   answer before editing anything.

4. **Edit `local-data/review/catalog.json`** to match what was agreed.
   - Change `label`, `defaultUnit`, `pinned` or `useCount` in place.
   - Take an entry out of the array to remove it.
   - Add a new entry as `{ "key": "paper-plates", "label": "Paper plates" }`.
   - **Never change an existing entry's key.** A rename changes the label
     only, so the lines already on lists still match it.

   Keys follow **Choosing the key** in the `ingest-recipe` skill: as precise
   as the item, merged only with true synonyms, singular or plural as that
   section says, and the owner's settled answers apply. A label reads as on
   a shopping list: "Limes" for the key `lime`, so typing either finds it.

5. **Write**: `node tools/common-items.js write`. It compares the copy with
   the backup and writes `common-items-review-<time>.json` to the inbox: the
   whole list, each entry stamped for the merge that Import does.
   - Unchanged entries keep their own time, so anything changed in the app
     since the backup still wins.
   - Changed entries are stamped now, so the change wins.
   - Removed entries become deletes, stamped now.
   - Added entries are stamped now. Recipe ingredients get the oldest
     possible time, so they only fill gaps.

   Fix any `fix:` line in the copy and write again. Then show the owner its
   summary of what was added, changed and deleted.

6. **Import.** The owner opens Pages, goes to Import → Choose files…, picks
   the file from `C:\Users\kille\Documents\recipe-book\local-data\inbox\`,
   and syncs. Import merges it one entry at a time and never replaces the
   whole list. localhost syncs only with `RecipeApp-dev`, so a real review
   goes in through Pages.

7. **Archive** when the owner confirms: `node tools/ingest.js archive`.

A use made in the app between the backup and the import is lost on an entry
the review changed, because the changed entry wins whole. That is a count or
two at most; a fresh backup in step 1 keeps it to none.
