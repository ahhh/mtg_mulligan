/**
 * Storage tests.
 *
 * These exercise the memory backend, which is the same code path a browser in
 * private mode takes when IndexedDB is unavailable. The point is that nothing
 * upstream has to know which backend it got.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createDeck, createDeckCard } from "../js/deck-model.js";
import {
  DEFAULT_SETTINGS,
  PROFILE_VERSION,
  STORES,
  applyOverrides,
  collectOverrides,
  createCardCache,
  createStore,
  deleteDeck,
  exportProfile,
  importProfile,
  listDecks,
  loadDeck,
  memoryStore,
  openDatabase,
  saveDeck,
} from "../js/storage.js";
import { hasTag } from "../js/tags.js";

function sampleDeck(name = "Storage deck") {
  return createDeck({
    name,
    cards: [
      createDeckCard({ name: "Sol Ring", quantity: 1, typeLine: "Artifact", resolved: true }),
      createDeckCard({ name: "Forest", quantity: 36, typeLine: "Basic Land — Forest", resolved: true }),
    ],
  });
}

test("openDatabase resolves null when IndexedDB is unavailable", async () => {
  assert.equal(await openDatabase(undefined), null);
});

test("createStore falls back to memory with no IndexedDB", async () => {
  const store = await createStore({ db: null });
  assert.equal(store.kind, "memory");
});

test("the memory store round-trips values", async () => {
  const store = memoryStore();
  await store.put(STORES.CARDS, "a", { value: 1 });
  await store.putMany(STORES.CARDS, [
    ["b", { value: 2 }],
    ["c", { value: 3 }],
  ]);

  assert.deepEqual(await store.get(STORES.CARDS, "a"), { value: 1 });
  assert.deepEqual(await store.getMany(STORES.CARDS, ["b", "missing", "c"]), [
    { value: 2 },
    null,
    { value: 3 },
  ]);

  await store.remove(STORES.CARDS, "a");
  assert.equal(await store.get(STORES.CARDS, "a"), null);
  assert.equal((await store.all(STORES.CARDS)).length, 2);
});

/* ---------------- card cache ---------------- */

test("the card cache stores and returns records", async () => {
  const cache = createCardCache(memoryStore());
  await cache.setMany([["name:sol ring", { name: "Sol Ring" }]]);
  assert.deepEqual(await cache.getMany(["name:sol ring"]), [{ name: "Sol Ring" }]);
  assert.deepEqual(await cache.getMany(["name:nothing"]), [null]);
});

test("expired card records are treated as misses", async () => {
  let clock = 0;
  const cache = createCardCache(memoryStore(), { ttlMs: 1000, now: () => clock });
  await cache.setMany([["name:sol ring", { name: "Sol Ring" }]]);

  clock = 999;
  assert.deepEqual(await cache.getMany(["name:sol ring"]), [{ name: "Sol Ring" }]);
  clock = 1001;
  assert.deepEqual(await cache.getMany(["name:sol ring"]), [null], "stale records are refetched");
});

test("a failing store never breaks a cache read or write", async () => {
  const broken = {
    async getMany() {
      throw new Error("quota exceeded");
    },
    async putMany() {
      throw new Error("quota exceeded");
    },
  };
  const cache = createCardCache(broken);
  assert.deepEqual(await cache.getMany(["a", "b"]), [null, null]);
  await cache.setMany([["a", {}]]); // must not throw
});

/* ---------------- decks ---------------- */

test("decks round-trip and list newest first", async () => {
  const store = await createStore({ db: null });
  const first = sampleDeck("First");
  const second = sampleDeck("Second");

  await saveDeck(store, first);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await saveDeck(store, second);

  const loaded = await loadDeck(store, first.id);
  assert.equal(loaded.name, "First");

  const listed = await listDecks(store);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].name, "Second");
  assert.equal(listed[0].cardCount, 37, "card count reflects quantities, not entries");

  await deleteDeck(store, first.id);
  assert.equal(await loadDeck(store, first.id), null);
});

/* ---------------- overrides ---------------- */

test("only cards with real edits are persisted as overrides", () => {
  const deck = sampleDeck();
  deck.cards[0].userTags = ["Ramp"];
  deck.cards[1].removedTags = ["Land"];

  const overrides = collectOverrides(deck);
  assert.equal(Object.keys(overrides).length, 2);
  assert.deepEqual(overrides[deck.cards[0].key].userTags, ["Ramp"]);
});

test("overrides re-apply onto a freshly imported deck", () => {
  const original = sampleDeck();
  original.cards[0].userTags = ["Ramp"];
  const overrides = collectOverrides(original);

  // A re-import produces new objects with the same keys and no user tags.
  const reimported = sampleDeck();
  assert.equal(hasTag(reimported.cards[0], "Ramp"), false);

  const restored = applyOverrides(reimported, overrides);
  assert.equal(hasTag(restored.cards[0], "Ramp"), true, "hours of tagging survive a re-import");
});

test("a removal override still beats the type line after re-import", () => {
  const original = sampleDeck();
  original.cards[1].removedTags = ["Land"];
  const restored = applyOverrides(sampleDeck(), collectOverrides(original));
  assert.equal(hasTag(restored.cards[1], "Land"), false);
});

/* ---------------- profiles ---------------- */

test("a profile exports and imports without losing tags", () => {
  const deck = sampleDeck("Portable");
  deck.cards[0].userTags = ["Ramp"];

  const profile = exportProfile({ deck, settings: { ...DEFAULT_SETTINGS, freeMulligans: 1 } });
  assert.equal(profile.version, PROFILE_VERSION);

  const restored = importProfile(JSON.stringify(profile));
  assert.equal(restored.deck.name, "Portable");
  assert.equal(restored.settings.freeMulligans, 1);
  assert.equal(hasTag(restored.deck.cards[0], "Ramp"), true);
});

test("an unknown profile version is refused rather than half-read", () => {
  assert.throws(() => importProfile({ version: 99, deck: null }), /Unsupported profile version/);
  assert.throws(() => importProfile("null"), /not an app profile/);
});
