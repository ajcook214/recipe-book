# Record schemas

`schemaVersion` is `1` for everything below. Every top-level record carries
`id`, `updatedAt` (ISO 8601, UTC) and `deleted`.

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

## `manifest.json`

```jsonc
{
  "schemaVersion": 1,
  "lastModified": "2026-09-20T17:04:00.000Z"
}
```

## `recipes/<uuid>.json`

```jsonc
{
  "id": "0d6f…",
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

## `lists/<uuid>.json`

```jsonc
{
  "id": "9ab3…",
  "schemaVersion": 1,
  "updatedAt": "2026-09-20T17:04:00.000Z",
  "deleted": false,

  "name": "Week of Sep 21",
  "archived": false,

  "items": [
    {
      "id": "c14e…",                  // stable; the unit of per-item merge
      "text": "ground beef",
      "key": "ground-beef",           // null for free-form entries
      "qty": 3, "unit": "lb",
      "checked": false,
      "checkedAt": null,
      "sort": 100,
      "updatedAt": "2026-09-20T17:04:00.000Z",   // per item, for merge
      "from": {                       // null when added by hand
        "recipeId": "0d6f…",
        "recipeTitle": "Weeknight Chili",
        "scale": 2
      }
    },
    {
      "id": "77b0…", "text": "paper towels", "key": null,
      "qty": null, "unit": null, "checked": false, "checkedAt": null,
      "sort": 200, "updatedAt": "…", "from": null
    }
  ]
}
```

Two recipes contributing flour produce **two items**. The list view groups by
`key` + `unit` and shows one combined row with the total, expandable to the
underlying lines. Removing a recipe from the list drops exactly the items whose
`from.recipeId` matches.

Deleted items are tombstoned in place (`deleted: true` on the item) until the
list itself is pruned, so a delete on one device survives a merge with another.

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

The catalog self-populates: adding a free-form item to a list creates or bumps
a catalog entry for its key, so the things you actually buy drift to the top
without any curation.
