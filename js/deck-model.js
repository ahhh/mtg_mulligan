/**
 * The canonical deck model.
 *
 * Importers and Scryfall hydration both funnel into these shapes. Everything
 * downstream — game state, probability, mana, UI — reads only from here.
 */

import { getEffectiveTags } from "./tags.js";

/** Where a card lives relative to the drawable library. */
export const ZONES = Object.freeze({
  MAIN: "main",
  COMMANDER: "commander",
  SIDEBOARD: "sideboard",
  MAYBEBOARD: "maybeboard",
});

/**
 * Normalized name used for matching and as a fallback key.
 * Case-folded, punctuation-relaxed, and split-card aware.
 */
export function normalizeName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*\/\/\s*/g, " // ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The front face of a split / modal card, used when matching deck lists. */
export function frontFaceName(name) {
  const normalized = normalizeName(name);
  const [front] = normalized.split(" // ");
  return front;
}

/**
 * Stable identity for a card: its Scryfall oracle id when hydrated, otherwise
 * its normalized name. Keys let quantities collapse and instances group.
 */
export function cardKey({ oracleId, name }) {
  return oracleId ? `oracle:${oracleId}` : `name:${normalizeName(name)}`;
}

let nextLocalId = 1;

function localId(prefix) {
  nextLocalId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextLocalId.toString(36)}`;
}

/**
 * Builds a canonical DeckCard. Only `name` is required; Scryfall hydration
 * fills the rest later.
 */
export function createDeckCard(fields = {}) {
  const name = String(fields.name || "").trim();
  if (!name) throw new TypeError("createDeckCard requires a name");
  const quantity = fields.quantity === undefined ? 1 : fields.quantity;
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError(`quantity must be a non-negative integer, got ${quantity}`);
  }

  return {
    key: fields.key || cardKey({ oracleId: fields.oracleId, name }),
    name,
    quantity,
    zone: fields.zone || ZONES.MAIN,

    scryfallId: fields.scryfallId ?? null,
    oracleId: fields.oracleId ?? null,
    set: fields.set ?? null,
    collectorNumber: fields.collectorNumber ?? null,

    manaCost: fields.manaCost ?? null,
    manaValue: fields.manaValue ?? null,
    typeLine: fields.typeLine ?? "",
    oracleText: fields.oracleText ?? "",
    producedMana: fields.producedMana ?? [],

    imageUris: fields.imageUris ?? null,

    sourceTags: fields.sourceTags ?? {},
    inferredTags: fields.inferredTags ?? [],
    userTags: fields.userTags ?? [],
    removedTags: fields.removedTags ?? [],

    /** True once Scryfall metadata has been merged in. */
    resolved: Boolean(fields.resolved),
  };
}

/**
 * Builds a canonical Deck. Cards with the same key are merged and their
 * quantities summed, so a list with "2 Forest" twice becomes 4 Forests.
 */
export function createDeck(fields = {}) {
  const merged = new Map();
  for (const raw of fields.cards || []) {
    const card = raw.key && raw.zone ? raw : createDeckCard(raw);
    const mergeKey = `${card.zone}:${card.key}`;
    const existing = merged.get(mergeKey);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      merged.set(mergeKey, { ...card });
    }
  }

  const cards = [...merged.values()];

  return {
    id: fields.id || localId("deck"),
    name: fields.name || "Untitled deck",
    format: fields.format || "commander",
    source: fields.source || { type: "text", url: null, sourceDeckId: null },
    commanders: fields.commanders
      ? [...fields.commanders]
      : cards.filter((card) => card.zone === ZONES.COMMANDER).map((card) => card.key),
    cards,
    importedAt: fields.importedAt || new Date().toISOString(),
  };
}

/** Cards that are actually shuffled into the library. */
export function getDrawableCards(deck) {
  return deck.cards.filter((card) => card.zone === ZONES.MAIN && card.quantity > 0);
}

/** Total number of physical cards in the drawable library. */
export function drawableSize(deck) {
  return getDrawableCards(deck).reduce((total, card) => total + card.quantity, 0);
}

export function getCommanders(deck) {
  return deck.cards.filter((card) => card.zone === ZONES.COMMANDER);
}

export function getSideboard(deck) {
  return deck.cards.filter((card) => card.zone === ZONES.SIDEBOARD);
}

export function findCardByKey(deck, key) {
  return deck.cards.find((card) => card.key === key) ?? null;
}

/** Loose lookup used by the deck-list parser and the real-hand autocomplete. */
export function findCardByName(deck, name, zone = null) {
  const wanted = normalizeName(name);
  const front = frontFaceName(name);
  return (
    deck.cards.find((card) => {
      if (zone && card.zone !== zone) return false;
      const cardName = normalizeName(card.name);
      return cardName === wanted || frontFaceName(card.name) === front;
    }) ?? null
  );
}

/**
 * Expands the drawable cards into one CardInstance per physical copy.
 * Instances carry a reference to their DeckCard so predicates can read live
 * tags without any copying.
 */
export function expandToInstances(deck) {
  const instances = [];
  for (const card of getDrawableCards(deck)) {
    for (let copy = 0; copy < card.quantity; copy += 1) {
      instances.push({ id: `${card.key}#${copy}`, key: card.key, card });
    }
  }
  return instances;
}

/** How many instances in `instances` match a probability target. */
export function countMatching(instances, target) {
  const matches = toMatcher(target);
  let count = 0;
  for (const instance of instances) {
    if (matches(instance.card)) count += 1;
  }
  return count;
}

/**
 * Accepts a target object, a bare predicate, or a tag string, and returns a
 * `(card) => boolean` function.
 */
export function toMatcher(target) {
  if (typeof target === "function") return target;
  if (target && typeof target.matches === "function") return (card) => target.matches(card);
  if (typeof target === "string") {
    const wanted = target.toLowerCase();
    return (card) => {
      for (const tag of getEffectiveTags(card)) {
        if (tag.toLowerCase() === wanted) return true;
      }
      return false;
    };
  }
  throw new TypeError("target must be a predicate, a target object, or a tag name");
}

/** Unresolved cards block accurate math, so the UI needs to surface them. */
export function getUnresolvedCards(deck) {
  return deck.cards.filter((card) => !card.resolved);
}
