# Record schemas

`schemaVersion` is `1` for everything below. Every top-level record carries
`id`, `updatedAt` (ISO 8601, UTC) and `deleted`. Each file carries its own
`schemaVersion`, so there is no folder-wide manifest.

`deleted: true` is a tombstone, kept so the delete reaches every device.
Sync clears tombstones out after 30 days: a deleted recipe or list once it
was deleted that long ago and its file has held the tombstone that long, and
a deleted list item or catalog entry once it was deleted that long ago. A
pruned file goes to Drive's trash.

The `id` is also the file name, so it is made to be read:

- **A recipe's id is its title as a slug**: `"Tomato Soup"` → `"tomato-soup"` →
  `recipes/tomato-soup.json`. At most 60 characters, cut at a word break. It is
  fixed once the recipe exists; renaming the recipe later keeps the file, so
  list lines that point at it keep working. Titles are unique by slug: an
  import with a name already taken asks to cancel, replace, or keep both,
  and keeping both numbers the new one ("Tomato Soup 2", `tomato-soup-2`).
- **A list's id is when it was made**, in local time to the second:
  `lists/2026-09-30-143205.json`. Lists get renamed freely, and duplicate
  names are normal for them.
- Ids are limited to letters, digits, `-` and `_`. Older records with UUID
  ids still load as they are.

## Shared conventions

- **`key`** — a slug derived from an item name (`"Ground Beef"` → `"ground-beef"`).
  Lowercase, trimmed, non-alphanumerics collapsed to `-`. It is a *soft* link:
  nothing breaks if no catalog entry has that key.
- **`qty`** — a decimal number or `null`. `null` means "unquantified"
  (a pinch, to taste); the human-readable part lives in `note`.
- **`unit`** — a short lowercase string (`"lb"`, `"cup"`, `"tbsp"`, `"clove"`)
  or `null` for bare counts.
- **`sort`** — sparse integers (100, 200, 300) so items can be reordered by
  writing one value instead of renumbering the array.

## `recipes/<id>.json`

```jsonc
{
  "id": "weeknight-chili",            // the title as a slug; the file name
  "schemaVersion": 1,
  "updatedAt": "2026-09-20T17:04:00.000Z",
  "deleted": false,

  "title": "Weeknight Chili",
  "rating": 8,                        // integer 1–10, or null when unrated
  "tags": ["dinner", "one-pot"],      // lowercase, deduped on write
  "servings": 4,                      // the baseline that scaling multiplies
  "prepMinutes": 15,                  // nullable
  "cookMinutes": 45,                  // nullable
  "source": "Grandma / https://… / Book p.42",   // nullable free text
  "notes": "Freezes well.",           // nullable

  "ingredients": [
    {
      "qty": 1.5,
      "unit": "lb",
      "item": "ground beef",          // display text, as written
      "key": "ground-beef",
      "note": null,                   // "finely chopped", "divided"
      "scalable": true
    },
    {
      "qty": null, "unit": null, "item": "salt", "key": "salt",
      "note": "to taste", "scalable": false
    }
  ],

  "steps": [
    "Brown the beef over medium-high heat.",
    "Add everything else and simmer 45 minutes."
  ]
}
```

Scaling multiplies `qty` by `target / servings` for every ingredient where
`scalable` is `true`. Unscalable ingredients pass through untouched.

## `lists/<id>.json`

```jsonc
{
  "id": "2026-09-20-170400",          // when it was made; the file name
  "schemaVersion": 1,
  "updatedAt": "2026-09-20T17:04:00.000Z",
  "deleted": false,

  "name": "Week of Sep 21",
  "archived": false,                  // put away: folded at the bottom of Lists, kept

  "items": [
    {
      "id": "c14e…",                  // a UUID; stable; the unit of per-item merge
      "text": "ground beef",
      "key": "ground-beef",           // slug; free-form text gets one too
      "qty": 3, "unit": "lb",
      "checked": false,
      "checkedAt": null,
      "sort": 100,
      "updatedAt": "2026-09-20T17:04:00.000Z",   // per item, for merge
      "from": {                       // null when added by hand
        "recipeId": "weeknight-chili",
        "recipeTitle": "Weeknight Chili",
        "scale": 2
      }
    },
    {
      "id": "77b0…", "text": "paper towels", "key": "paper-towels",
      "qty": null, "unit": null, "checked": false, "checkedAt": null,
      "sort": 200, "updatedAt": "…", "from": null
    }
  ]
}
```

Two recipes contributing flour produce **two items**. The list view groups by
`key` and shows one combined row with the total and the recipes it came from;
checking the row checks every line behind it. When a row mixes units, weights
(oz, lb) and volumes (tsp, tbsp, cup) convert within their family — 20 oz +
1 lb shows as 2¼ lb — while a single unit is left as written. Removing a recipe
from the list drops exactly the items whose `from.recipeId` matches.

Adding a recipe to a list shows its ingredients with checkboxes, so pantry
staples can be unticked before anything is stored.

Deleted items are tombstoned in place (`deleted: true` on the item) until the
list itself is pruned, so a delete on one device survives a merge with another.

Renaming a row in the app gives each line behind it the new text and that
text's key, so a fixed typo combines with the real thing. Moving a row gives
every line behind it the same `sort`, since a row sits where its lowest line
does.

## `catalog.json`

A single file, not one per item — a few hundred staples as individual files
would mean a few hundred requests on first sync for no benefit. Merged per
entry on `key`.

```jsonc
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-20T17:04:00.000Z",
  "items": [
    {
      "key": "paper-towels",
      "label": "Paper towels",
      "defaultUnit": null,
      "useCount": 12,                 // drives "most used" ordering
      "lastUsedAt": "2026-09-14T…",
      "pinned": true,                 // always show near the top
      "deleted": false,
      "updatedAt": "…"
    }
  ]
}
```

Adding an item to a list counts a use of the entry it matches, by label or
key, so the things you actually buy drift to the top. Something with no entry
goes on the list only. Typing never creates an entry, so a typo or a one-off
purchase is not remembered for good. Entries arrive by import:

- **Recipe ingredients**, one entry per key, added when the recipe is
  imported (`withRecipeItems` in `src/core/list.js`), unless an entry has
  the key or answers to it, deleted ones included. Each is labelled from the
  ingredient's `item` when that names the key, or else from the key, and
  stamped `1970-01-01T00:00:00.000Z`, older than any real edit, so on sync
  another device's copy of the entry wins.
- **A starter list** of common shopping items, made once, stamped the same
  way.
- **A review of the lists** (`tools/common-items.js`): the whole catalog
  from a backup, after edits. Unchanged entries keep their own time, changed
  ones are stamped now, and removed ones become deletes stamped now.

`key` never changes once an entry exists. Renaming one changes its `label`
only, so lines already on a list still match it, and typing either the new
name or the old one finds it. That is the one place a key can stop matching
its own name. Deleting an entry forgets it: adding the item to a list puts
it on the list only. A recipe that uses it brings it back only after the
delete has been pruned, 30 days on.

## Backups

Not a file in Drive: the one file the Import screen downloads, holding
everything on that device. The records are exactly as stored, less the
tombstones and deleted items, which only matter to sync.

```jsonc
{
  "format": "recipe-book-backup",     // how the Import screen knows it
  "schemaVersion": 1,                 // of this wrapper
  "exportedAt": "2026-10-04T12:00:00.000Z",
  "recipes": [ /* recipes/<id>.json, sorted by id */ ],
  "lists": [ /* lists/<id>.json, archived ones too */ ],
  "catalog": { /* catalog.json */ }   // or null
}
```

Importing one asks first, then takes each record through the ordinary import:
recipes come back as the backup has them, and lists and the catalog merge
with what is there.
