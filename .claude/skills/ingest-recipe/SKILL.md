---
name: ingest-recipe
description: Turn a recipe web page (a URL, or a saved HTML file) into a recipe JSON file for the recipe app's Import screen. Use whenever the owner shares a recipe link or page, or asks to add, ingest, import, or re-summarize a recipe.
---

# Ingest a recipe

You turn a recipe page into a file matching `docs/schema.md`, check it with the
app's own validator, and leave it in `local-data/inbox/`. The owner imports it
on Pages and syncs. You never write to Drive: under the `drive.file` scope the
app cannot see files it did not create.

The repo is public. Recipe files live only in `local-data/` (gitignored).
Never commit them, and never put recipe data anywhere else in the repo.

Run the helper with Node (`C:\Program Files\nodejs`; prepend it to `PATH` if
`node` is not found):

```
node tools/ingest.js fetch <url|file.html>   # the page's schema.org Recipe, trimmed
node tools/ingest.js vocab                   # tags, keys and units already in use
node tools/ingest.js check                   # lint everything in local-data/inbox/
node tools/ingest.js archive [file...]       # move imported files to local-data/imported/
```

## Steps

1. **Inbox first.** If `local-data/inbox/` already holds files, ask whether
   they were imported. Archive them only on a yes.

2. **Get the recipe**, stopping at the first that works:
   1. `node tools/ingest.js fetch <url>`. It prints the canonical `url`, the
      `site` name and each Recipe found.
   2. If the site refuses (403, a bot check), open the page in the built-in
      browser and read the JSON-LD with `javascript_tool`:
      `[...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join('\n')`.
      Use the canonical URL from `<link rel="canonical">` without tracking
      parameters.
   3. Ask the owner to save the page (Save as → "Webpage, HTML only") into
      `local-data/html/`, then `node tools/ingest.js fetch local-data/html/<file>.html`.
   4. No JSON-LD at all: read the page text and structure it yourself.

3. **Learn the vocabulary**: `node tools/ingest.js vocab`. Reuse its tags
   wherever they fit, and its ingredient and catalog keys where **Choosing
   the key** (below) allows. A recipe whose ingredients use catalog keys
   combines with tapped catalog items on a list. If the recipe ids it lists
   include this page, keep that recipe's title.

4. **Write `local-data/inbox/<id>.json`**, by the rules below.

5. **Check**: `node tools/ingest.js check`. Fix every `fix:` line and run it
   again until it passes. Read each `note:` and act on the ones that matter.
   A new key that looks like a known one is a question for **Choosing the
   key**, not an answer, and a new tag should be one you meant.

6. **Report** briefly, for each recipe: title, servings, tags, and anything the
   owner should know: a clash Import will ask about, a meal-kit swap, a key
   merged into a known one or kept apart from it, or another judgement call.
   Then tell them how to import:
   1. Open <https://ajcook214.github.io/recipe-book/>, then Import →
      Choose files…, and pick from
      `C:\Users\kille\Documents\recipe-book\local-data\inbox\`.
   2. Sync, so the phone gets them.
   3. Say when they are in, and you will archive them.

   localhost syncs only with `RecipeApp-dev`, so recipes meant to keep go in
   through Pages.

7. **Archive** when the owner confirms: `node tools/ingest.js archive`.
   Archived files still count for `vocab` and `check`, and a later re-ingest
   replaces the older copy there.

Several recipes in one go: do steps 2–4 for each, then check and report once.

## Writing the file

Every field is present, in this order:

```json
{
  "id": "corn-chowder",
  "schemaVersion": 1,
  "updatedAt": "<now, ISO 8601 UTC>",
  "deleted": false,
  "title": "Corn Chowder",
  "rating": null,
  "tags": ["soup", "main course", "american"],
  "servings": 8,
  "prepMinutes": 15,
  "cookMinutes": 30,
  "source": "Natasha's Kitchen - https://natashaskitchen.com/corn-chowder-recipe/",
  "notes": "About 2 cups per serving.",
  "ingredients": [
    { "qty": 1, "unit": null, "item": "large onion", "key": "onion", "note": "finely diced", "scalable": true }
  ],
  "steps": ["Soften the onion in the bacon fat, 7-8 min."]
}
```

**Header**
- `title`: the dish, minus SEO words ("Corn Chowder Recipe" →
  "Corn Chowder", "The BEST Easy Lasagna" → "Lasagna"). If the page is
  already in the app, keep the title it has there (step 3).
- `id`: the title as a slug, at most 60 characters, cut at a word break.
  `check` says what it must be. The file name is `<id>.json`.
- `rating`: `null`. It is the owner's judgement, and Import keeps the one
  already set when a recipe is updated.
- `tags`: 2–4, lowercase. Reuse the vocabulary: course ("main course",
  "side", "dessert"), main protein or "vegetarian", cuisine, and diet
  ("low carb"). Add a new tag only when nothing fits.
- `servings`: the number from the recipe's yield.
- `prepMinutes` and `cookMinutes`: from the JSON-LD, or `null`.
- `source`: `"<Site Name> - <url>"`, with the canonical URL from `fetch`.
  Import recognises a recipe imported again by this URL.
- `notes`: only what changes the outcome, such as serving size, make-ahead or
  freezing, or a substitution worth knowing. Otherwise `null`.

**Ingredients are facts.** Structure each one:
- `qty`: a decimal (1 1/2 → `1.5`). For a range, give the low end and put
  the range in the note ("up to 3, to taste"). `null` for "to taste", "a
  pinch" or "for serving", with that phrase in `note`.
- `unit`: the form the app stores: singular and abbreviated (`tsp`, `tbsp`,
  `cup`, `oz`, `lb`, `g`, `ml`, `clove`, `can`, `stalk`, `package`…), or
  `null` for a bare count. Only stored forms combine on a shopping list.
- `item`: what the cook buys, as the page names it, without prep
  ("large onion", "Yukon Gold potatoes").
- `key`: what the cook buys, as a slug. See **Choosing the key**.
- `note`: prep and asides ("finely diced", "divided", "optional", "for the
  sauce"), or `null`.
- `scalable`: `true`, except for amounts that should not grow with the batch,
  such as a pan's worth of frying oil. A `null` qty never scales.
- An ingredient listed twice (butter for the sauce and for the pan) becomes
  one line noted "divided", and the steps say "half the butter".
- **Meal-kit units** ("1 unit stock concentrate") become something a store
  sells, with a note saying what it replaces ("replaces 1 HelloFresh stock
  concentrate").

**Choosing the key.** The key names the ingredient exactly as precisely as
the recipe does. Lines that share a key merge into one row on a shopping
list, so the owner wants more granularity, not less. An extra row is a
small nuisance, but a wrong merge is a wrong purchase.
- Keep every detail the recipe specifies: "onion" is `onion`, "yellow
  onion" is `yellow-onion`, and "red onion" is `red-onion`. None of them
  merge. Never add a detail the recipe left out, or drop one it gave.
- Drop only what never changes what gets bought: size, prep, and singular
  versus plural. "Large egg" and "2 eggs" are both `eggs`, and "1 onion,
  finely diced" is `onion`. For singular or plural, reuse whichever form is
  already known. `check` notes a mismatch.
- Merge different words only when they are synonyms for the same product,
  like scallions and green onions. Then reuse the known key. Two things a
  cook could substitute for each other are still two things: `garlic-powder`
  is not `garlic`.
- If you are not sure two names mean the same product, look it up. If it is
  still unclear, ask the owner before writing the file. Never merge on a
  guess.
- `item` keeps the recipe's own wording either way, so the recipe still
  says "kosher salt" when the key is `salt`.
- Add each answer the owner gives to the list below, so it is asked only
  once, and mention the change, so it gets committed.

**Settled by the owner**
- Merge: kosher salt, sea salt and plain salt are all `salt`, being close
  enough that it never matters. Seasoned salt is a different product:
  `seasoned-salt`.
- Merge: "large egg" and "eggs" are both `eggs`.
- Keep apart: an onion the recipe does not specify is `onion`. A yellow,
  red or white onion has its own key.

**Steps are written in your own words**, never copied, and **carry no
quantities**: amounts live in the ingredients, so scaling stays right.
- Refer to ingredients relatively: "the butter", "half the zest", "the
  rest of the cheese".
- The one exception is something that is not an ingredient, like pasta
  water. Give it per serving ("about 1/4 cup pasta water per serving"), so
  it still scales.
- Summarize hard. Short, imperative steps a cook can follow at a glance,
  usually 4–8. Drop the life story, SEO filler, obvious tips and "about 1 cup"
  volume hints. Keep what changes the outcome: times, temperatures, pan sizes
  and doneness cues ("until the potatoes are tender, 10-15 min").
- Merge section headings into the step text ("For the stock: …") instead of
  keeping them as steps.
