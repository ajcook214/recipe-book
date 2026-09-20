// @ts-check

/**
 * Shared record shapes. This module exports no runtime values — it exists so
 * JSDoc elsewhere can reference these types. See docs/schema.md for the
 * authoritative field-by-field description.
 */

/**
 * @typedef {object} Ingredient
 * @property {number|null} qty          Decimal. null means unquantified ("to taste").
 * @property {string|null} unit         Short lowercase unit, or null for a bare count.
 * @property {string} item              Display text, as written.
 * @property {string} key               Slug, shared with catalog entries.
 * @property {string|null} note         "finely chopped", "divided", "to taste".
 * @property {boolean} scalable         False for things that must not be multiplied.
 */

/**
 * @typedef {object} Recipe
 * @property {string} id
 * @property {number} schemaVersion
 * @property {string} updatedAt
 * @property {boolean} deleted
 * @property {string} title
 * @property {number|null} rating       Integer 1-10, or null when unrated.
 * @property {string[]} tags
 * @property {number} servings          The baseline that scaling multiplies.
 * @property {number|null} prepMinutes
 * @property {number|null} cookMinutes
 * @property {string|null} source
 * @property {string|null} notes
 * @property {Ingredient[]} ingredients
 * @property {string[]} steps
 */

/**
 * @typedef {object} ListItemSource
 * @property {string} recipeId
 * @property {string} recipeTitle
 * @property {number} scale
 */

/**
 * @typedef {object} ListItem
 * @property {string} id                Stable; the unit of per-item merge.
 * @property {string} text
 * @property {string|null} key          null for free-form entries.
 * @property {number|null} qty
 * @property {string|null} unit
 * @property {boolean} checked
 * @property {string|null} checkedAt
 * @property {number} sort              Sparse integers, so reordering writes one value.
 * @property {string} updatedAt         Per item, for merge.
 * @property {boolean} deleted          Tombstone; survives until the list is pruned.
 * @property {ListItemSource|null} from null when added by hand.
 */

/**
 * @typedef {object} ShoppingList
 * @property {string} id
 * @property {number} schemaVersion
 * @property {string} updatedAt
 * @property {boolean} deleted
 * @property {string} name
 * @property {boolean} archived
 * @property {ListItem[]} items
 */

/**
 * @typedef {object} CatalogItem
 * @property {string} key               Identity. The unit of per-item merge.
 * @property {string} label
 * @property {string|null} defaultUnit
 * @property {number} useCount          Drives "most used" ordering.
 * @property {string|null} lastUsedAt
 * @property {boolean} pinned
 * @property {boolean} deleted
 * @property {string} updatedAt
 */

/**
 * @typedef {object} Catalog
 * @property {number} schemaVersion
 * @property {string} updatedAt
 * @property {CatalogItem[]} items
 */

export {};
