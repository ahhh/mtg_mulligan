/**
 * Tag resolution.
 *
 * A card's visible tags come from several layers with a strict precedence:
 *
 *   user explicit removal
 *     > user explicit addition
 *     > imported deck-specific tags/categories
 *     > automatic inferred tags
 *     > basic type-derived tags
 *
 * Effective tags are always computed, never stored, so a tag edit changes every
 * downstream probability immediately.
 */

/** Tags the app understands out of the box. */
export const BUILT_IN_TAGS = Object.freeze([
  "Land",
  "Creature",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Planeswalker",
  "Battle",
  "Legendary",
  "Removal",
  "Ramp",
  "Card Draw",
  "Counterspell",
  "Tutor",
  "Wincon",
]);

const TYPE_TAGS = Object.freeze([
  "Land",
  "Creature",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Planeswalker",
  "Battle",
  "Legendary",
]);

/**
 * Tags derived purely from the type line. These are never wrong, so they form
 * the base layer.
 */
export function typeDerivedTags(card) {
  const typeLine = card.typeLine || "";
  const tags = [];
  for (const tag of TYPE_TAGS) {
    // Match whole words so "Artifact Creature" yields both, and "Landfall" in
    // rules text can never leak in (we only look at the type line).
    const pattern = new RegExp(`\\b${tag}\\b`, "i");
    if (pattern.test(typeLine)) tags.push(tag);
  }
  return tags;
}

/**
 * Conservative automatic inference. Phase 5 extends this; for now the only
 * inference beyond the type line is basic-land detection, which is unambiguous.
 */
export function inferTags(card) {
  const tags = new Set(typeDerivedTags(card));
  const typeLine = (card.typeLine || "").toLowerCase();
  if (typeLine.includes("basic") && typeLine.includes("land")) tags.add("Basic Land");
  return [...tags];
}

/** All imported tags across every provider that supplied them. */
export function importedTags(card) {
  const bySource = card.sourceTags || {};
  const tags = [];
  for (const list of Object.values(bySource)) {
    for (const tag of list || []) tags.push(tag);
  }
  return tags;
}

/**
 * The tags that currently apply to a card, as a Set.
 */
export function getEffectiveTags(card) {
  const removed = new Set((card.removedTags || []).map(normalizeTag));
  const effective = new Set();
  const add = (tag) => {
    const normalized = normalizeTag(tag);
    if (!normalized) return;
    if (removed.has(normalized)) return;
    effective.add(normalized);
  };

  for (const tag of inferTags(card)) add(tag);
  for (const tag of importedTags(card)) add(tag);
  for (const tag of card.userTags || []) add(tag);

  return effective;
}

/**
 * Where each effective tag came from, highest-precedence source wins.
 * Returns `[{ tag, source }]` where source is "user", a provider name,
 * "inferred", or "type".
 */
export function getTagProvenance(card) {
  const effective = getEffectiveTags(card);
  const userTags = new Set((card.userTags || []).map(normalizeTag));
  const typeTags = new Set(typeDerivedTags(card).map(normalizeTag));
  const inferred = new Set(inferTags(card).map(normalizeTag));

  const providerFor = new Map();
  for (const [provider, list] of Object.entries(card.sourceTags || {})) {
    for (const tag of list || []) {
      const normalized = normalizeTag(tag);
      if (!providerFor.has(normalized)) providerFor.set(normalized, provider);
    }
  }

  return [...effective].map((tag) => {
    if (userTags.has(tag)) return { tag, source: "user" };
    if (providerFor.has(tag)) return { tag, source: providerFor.get(tag) };
    if (typeTags.has(tag)) return { tag, source: "type" };
    if (inferred.has(tag)) return { tag, source: "inferred" };
    return { tag, source: "unknown" };
  });
}

/** Tags compare case-insensitively but keep the casing they were written with. */
export function normalizeTag(tag) {
  return typeof tag === "string" ? tag.trim() : "";
}

export function hasTag(card, tag) {
  const wanted = normalizeTag(tag).toLowerCase();
  for (const effective of getEffectiveTags(card)) {
    if (effective.toLowerCase() === wanted) return true;
  }
  return false;
}

/** A probability target that matches every card carrying `tag`. */
export function tagTarget(tag, label = tag) {
  return {
    id: `tag:${normalizeTag(tag).toLowerCase()}`,
    label,
    matches: (card) => hasTag(card, tag),
  };
}
