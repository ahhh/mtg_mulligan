import test from "node:test";
import assert from "node:assert/strict";

import { createDeckCard } from "../js/deck-model.js";
import {
  getEffectiveTags,
  getTagProvenance,
  hasTag,
  inferTags,
  tagTarget,
  typeDerivedTags,
} from "../js/tags.js";

const card = (fields) => createDeckCard({ name: "Test Card", ...fields });

function sourceOf(record, tag) {
  return getTagProvenance(record).find((entry) => entry.tag === tag)?.source ?? null;
}

test("type-derived tags come from the type line only", () => {
  assert.deepEqual(typeDerivedTags(card({ typeLine: "Instant" })), ["Instant"]);
  assert.deepEqual(typeDerivedTags(card({ typeLine: "Artifact Creature — Golem" })), ["Creature", "Artifact"]);
  assert.deepEqual(
    typeDerivedTags(card({ typeLine: "Legendary Creature — Naga Wizard" })),
    ["Creature", "Legendary"],
  );
  // Rules text must never leak into type tags.
  assert.deepEqual(typeDerivedTags(card({ typeLine: "Enchantment", oracleText: "Landfall — ..." })), [
    "Enchantment",
  ]);
});

test("basic lands are inferred conservatively", () => {
  const forest = card({ name: "Forest", typeLine: "Basic Land — Forest" });
  assert.equal(hasTag(forest, "Land"), true);
  assert.equal(hasTag(forest, "Basic Land"), true);
  assert.equal(inferTags(card({ typeLine: "Land" })).includes("Basic Land"), false);
});

test("imported tags are added on top of inferred ones", () => {
  const push = card({
    name: "Fatal Push",
    typeLine: "Instant",
    sourceTags: { moxfield: ["Removal"], archidekt: ["Interaction"] },
  });
  const tags = getEffectiveTags(push);
  assert.equal(tags.has("Instant"), true);
  assert.equal(tags.has("Removal"), true);
  assert.equal(tags.has("Interaction"), true);
  assert.equal(sourceOf(push, "Removal"), "moxfield");
  assert.equal(sourceOf(push, "Instant"), "type");
});

test("a user removal beats a suggested and an imported tag", () => {
  const push = card({
    typeLine: "Instant",
    sourceTags: { moxfield: ["Removal"] },
    removedTags: ["Removal"],
  });
  assert.equal(hasTag(push, "Removal"), false);
  assert.equal(hasTag(push, "Instant"), true);
});

test("a user removal beats a user addition", () => {
  const record = card({ typeLine: "Instant", userTags: ["Removal"], removedTags: ["Removal"] });
  assert.equal(hasTag(record, "Removal"), false);
});

test("a user addition works with no imported tag", () => {
  const record = card({ typeLine: "Sorcery", userTags: ["Removal"] });
  assert.equal(hasTag(record, "Removal"), true);
  assert.equal(sourceOf(record, "Removal"), "user");
});

test("a user can remove even a type-derived tag", () => {
  const record = card({ typeLine: "Creature — Bear", removedTags: ["Creature"] });
  assert.equal(hasTag(record, "Creature"), false);
});

test("tag matching is case- and whitespace-insensitive", () => {
  const record = card({ typeLine: "Instant", userTags: ["  Removal  "] });
  assert.equal(hasTag(record, "removal"), true);
  assert.equal(hasTag(record, "REMOVAL"), true);
  assert.equal(getEffectiveTags(record).has("Removal"), true, "casing is preserved as written");
});

test("tagTarget builds a usable probability target", () => {
  const target = tagTarget("Land");
  assert.equal(target.id, "tag:land");
  assert.equal(target.matches(card({ typeLine: "Basic Land — Forest" })), true);
  assert.equal(target.matches(card({ typeLine: "Instant" })), false);
});
