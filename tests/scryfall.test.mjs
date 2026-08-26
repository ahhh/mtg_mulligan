/**
 * Scryfall client tests.
 *
 * No network: `fetch` and `sleep` are injected. The fixture in
 * `fixtures/scryfall-collection.json` is a real captured response, so the
 * normalizer is tested against shapes the live API actually returns —
 * including a split card and a modal double-faced card.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDeck, createDeckCard, ZONES } from "../js/deck-model.js";
import {
  COLLECTION_BATCH_SIZE,
  ScryfallError,
  applyScryfallCard,
  cacheKeyForIdentifier,
  createScryfallClient,
  hydrateDeck,
  identifierFor,
  lookupName,
  normalizeScryfallCard,
} from "../js/scryfall.js";
import { hasTag } from "../js/tags.js";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/scryfall-collection.json", import.meta.url), "utf8"),
);
const byName = new Map(fixture.data.map((card) => [card.name, card]));

/** A fetch stub that answers collection POSTs out of the fixture. */
function stubFetch({ onRequest = () => {}, responses = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const identifiers = JSON.parse(init.body).identifiers;
    calls.push({ url, identifiers });
    onRequest(calls.length, identifiers);
    if (responses && responses.length) {
      const next = responses.shift();
      if (next) return next;
    }
    const data = [];
    const notFound = [];
    for (const identifier of identifiers) {
      const match = fixture.data.find(
        (card) =>
          card.name.toLowerCase() === String(identifier.name || "").toLowerCase() ||
          card.name.toLowerCase().startsWith(`${String(identifier.name || "").toLowerCase()} //`) ||
          card.oracle_id === identifier.oracle_id ||
          card.id === identifier.id,
      );
      if (match) data.push(match);
      else notFound.push(identifier);
    }
    return jsonResponse({ object: "list", data, not_found: notFound });
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function client(overrides = {}) {
  const { fetchImpl, calls } = overrides.stub ?? stubFetch();
  return {
    calls,
    client: createScryfallClient({
      fetch: overrides.fetch ?? fetchImpl,
      sleep: async () => {}, // never actually wait in tests
      minDelayMs: 0,
      ...overrides.options,
    }),
  };
}

/* ---------------- normalization ---------------- */

test("normalizes an ordinary single-faced card", () => {
  const card = normalizeScryfallCard(byName.get("Fatal Push"));
  assert.equal(card.name, "Fatal Push");
  assert.equal(card.manaCost, "{B}");
  assert.equal(card.manaValue, 1);
  assert.match(card.typeLine, /Instant/);
  assert.ok(card.oracleId);
  assert.ok(card.imageUris?.normal);
});

test("a split card keeps its joined mana cost and both type lines", () => {
  const card = normalizeScryfallCard(byName.get("Wear // Tear"));
  assert.equal(card.name, "Wear // Tear");
  assert.equal(card.manaCost, "{1}{R} // {W}");
  assert.equal(card.typeLine, "Instant // Instant");
  assert.equal(card.faces.length, 2);
});

test("a double-faced card falls back to the front face for cost and image", () => {
  const raw = byName.get("Malakir Rebirth // Malakir Mire");
  assert.equal(raw.mana_cost, undefined, "fixture should have no top-level mana cost");
  assert.equal(raw.image_uris, undefined, "fixture should have no top-level image");

  const card = normalizeScryfallCard(raw);
  assert.equal(card.manaCost, "{B}", "front face cost is used when there is no top-level cost");
  assert.ok(card.imageUris?.normal, "front face image is used when there is no top-level image");
  assert.equal(card.faces.length, 2);
});

test("produced mana defaults to an empty list", () => {
  assert.deepEqual(normalizeScryfallCard(byName.get("Fatal Push")).producedMana, []);
  assert.deepEqual(normalizeScryfallCard(byName.get("Sol Ring")).producedMana, ["C"]);
});

/* ---------------- identifiers ---------------- */

test("split cards are looked up by their front face", () => {
  // Verified against the live API: `{"name":"Wear // Tear"}` returns not_found.
  assert.equal(lookupName("Wear // Tear"), "Wear");
  assert.equal(lookupName("Malakir Rebirth // Malakir Mire"), "Malakir Rebirth");
  assert.equal(lookupName("Sol Ring"), "Sol Ring");
  assert.deepEqual(identifierFor({ name: "Wear // Tear" }), { name: "Wear" });
});

test("identifiers prefer the most specific form available", () => {
  assert.deepEqual(identifierFor({ name: "X", scryfallId: "abc" }), { id: "abc" });
  assert.deepEqual(identifierFor({ name: "X", oracleId: "def" }), { oracle_id: "def" });
  assert.deepEqual(identifierFor({ name: "X", set: "CMM", collectorNumber: "396" }), {
    set: "cmm",
    collector_number: "396",
  });
  assert.deepEqual(identifierFor({ name: "X" }), { name: "X" });
});

test("cache keys are stable across name spellings", () => {
  assert.equal(cacheKeyForIdentifier({ name: "Fatal Push" }), cacheKeyForIdentifier({ name: "FATAL PUSH" }));
  assert.equal(cacheKeyForIdentifier({ name: "Wear // Tear" }), "name:wear");
});

/* ---------------- request discipline ---------------- */

test("a large deck is batched at 75 identifiers per request", async () => {
  const { client: api, calls } = client();
  const identifiers = Array.from({ length: 160 }, (_, index) => ({ name: `Filler ${index}` }));
  await api.collection(identifiers);

  assert.equal(calls.length, 3, "160 identifiers is three collection requests");
  assert.equal(calls[0].identifiers.length, COLLECTION_BATCH_SIZE);
  assert.equal(calls[1].identifiers.length, COLLECTION_BATCH_SIZE);
  assert.equal(calls[2].identifiers.length, 10);
});

test("cached cards are never requested twice", async () => {
  const cache = new Map();
  const stub = stubFetch();
  const api = createScryfallClient({
    fetch: stub.fetchImpl,
    sleep: async () => {},
    minDelayMs: 0,
    cache: {
      async getMany(keys) {
        return keys.map((key) => cache.get(key) ?? null);
      },
      async setMany(entries) {
        for (const [key, value] of entries) cache.set(key, value);
      },
    },
  });

  const first = await api.collection([{ name: "Fatal Push" }, { name: "Sol Ring" }]);
  assert.equal(stub.calls.length, 1);
  assert.equal(first.cards.filter(Boolean).length, 2);

  const second = await api.collection([{ name: "Fatal Push" }, { name: "Sol Ring" }]);
  assert.equal(stub.calls.length, 1, "the second lookup is served entirely from cache");
  assert.equal(second.cards[0].name, "Fatal Push");
});

test("concurrent identical requests are deduplicated", async () => {
  const { client: api, calls } = client();
  const [a, b] = await Promise.all([
    api.collection([{ name: "Sol Ring" }]),
    api.collection([{ name: "Sol Ring" }]),
  ]);
  assert.equal(calls.length, 1, "one request served both callers");
  assert.equal(a.cards[0].name, b.cards[0].name);
});

test("requests are serialized with the minimum delay between them", async () => {
  const waits = [];
  let clock = 0;
  const stub = stubFetch();
  const api = createScryfallClient({
    fetch: stub.fetchImpl,
    minDelayMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });

  await api.collection([{ name: "Sol Ring" }]);
  await api.collection([{ name: "Fatal Push" }]);

  assert.equal(stub.calls.length, 2);
  assert.deepEqual(waits, [100], "the second request waited out the rate limit");
});

test("a 429 backs off, retries, and then succeeds", async () => {
  const rateLimited = jsonResponse({}, { status: 429, headers: { "retry-after": "2" } });
  const stub = stubFetch({ responses: [rateLimited] });
  const slept = [];
  const api = createScryfallClient({
    fetch: stub.fetchImpl,
    minDelayMs: 0,
    sleep: async (ms) => slept.push(ms),
  });

  const result = await api.collection([{ name: "Sol Ring" }]);
  assert.equal(result.cards[0].name, "Sol Ring");
  assert.ok(slept.includes(2000), `Retry-After was honoured, slept: ${slept.join(", ")}`);
});

test("a persistent 429 gives up rather than retrying forever", async () => {
  const limited = () => jsonResponse({}, { status: 429, headers: { "retry-after": "1" } });
  const stub = stubFetch({ responses: [limited(), limited(), limited(), limited(), limited()] });
  const api = createScryfallClient({
    fetch: stub.fetchImpl,
    minDelayMs: 0,
    sleep: async () => {},
    maxRetries: 2,
  });

  await assert.rejects(() => api.collection([{ name: "Sol Ring" }]), ScryfallError);
  assert.ok(stub.calls.length <= 3, `stopped after ${stub.calls.length} attempts`);
});

test("a 404-class error is not retried", async () => {
  const stub = stubFetch({ responses: [jsonResponse({}, { status: 400 })] });
  const api = createScryfallClient({ fetch: stub.fetchImpl, minDelayMs: 0, sleep: async () => {} });
  await assert.rejects(() => api.collection([{ name: "Sol Ring" }]), /400/);
  assert.equal(stub.calls.length, 1);
});

/* ---------------- deck hydration ---------------- */

function unresolvedDeck() {
  return createDeck({
    name: "Hydration test",
    cards: [
      createDeckCard({ name: "Fatal Push", quantity: 4 }),
      createDeckCard({ name: "Sol Ring", quantity: 1 }),
      createDeckCard({ name: "Wear // Tear", quantity: 2 }),
      createDeckCard({ name: "Definitely Not A Real Card XYZ", quantity: 3 }),
    ],
  });
}

test("hydration fills in type lines and enables automatic tags", async () => {
  const { client: api } = client();
  const { deck, unresolved } = await hydrateDeck(unresolvedDeck(), api);

  const push = deck.cards.find((card) => card.name === "Fatal Push");
  assert.equal(push.resolved, true);
  assert.equal(push.manaCost, "{B}");
  assert.match(push.key, /^oracle:/, "hydrated cards are re-keyed by oracle id");
  assert.ok(hasTag(push, "Instant"), "the type line now drives automatic tags");

  const split = deck.cards.find((card) => card.name === "Wear // Tear");
  assert.equal(split.resolved, true, "a split card resolves via its front face");

  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].name, "Definitely Not A Real Card XYZ");
});

test("unresolved cards keep their quantity and stay in the deck", async () => {
  const { client: api } = client();
  const before = unresolvedDeck();
  const { deck } = await hydrateDeck(before, api);

  const total = (target) => target.cards.reduce((sum, card) => sum + card.quantity, 0);
  assert.equal(total(deck), total(before), "deck size must never shrink because Scryfall missed a card");

  const missing = deck.cards.find((card) => card.name === "Definitely Not A Real Card XYZ");
  assert.equal(missing.quantity, 3);
  assert.equal(missing.resolved, false);
});

test("hydration preserves user tags and quantities", () => {
  const deckCard = createDeckCard({
    name: "fatal push",
    quantity: 4,
    userTags: ["Removal"],
    sourceTags: { text: ["Interaction"] },
  });
  const merged = applyScryfallCard(deckCard, normalizeScryfallCard(byName.get("Fatal Push")));

  assert.equal(merged.quantity, 4);
  assert.deepEqual(merged.userTags, ["Removal"]);
  assert.deepEqual(merged.sourceTags, { text: ["Interaction"] });
  assert.equal(merged.name, "Fatal Push", "Scryfall's spelling replaces the pasted one");
});

test("cards that turn out to be identical are merged after re-keying", async () => {
  const { client: api } = client();
  // A deck list may write a split card either way; both are the same card.
  const deck = createDeck({
    name: "Duplicate spellings",
    cards: [
      createDeckCard({ name: "Wear // Tear", quantity: 2 }),
      createDeckCard({ name: "Wear", quantity: 2 }),
    ],
  });
  assert.equal(deck.cards.length, 2, "different raw keys before hydration");

  const { deck: hydrated } = await hydrateDeck(deck, api);
  assert.equal(hydrated.cards.length, 1, "same oracle id, so one entry");
  assert.equal(hydrated.cards[0].quantity, 4);
});

test("a Scryfall outage leaves the deck usable instead of throwing", async () => {
  const api = createScryfallClient({
    fetch: async () => {
      throw new Error("network down");
    },
    minDelayMs: 0,
    sleep: async () => {},
  });

  const { deck, unresolved, error } = await hydrateDeck(unresolvedDeck(), api);
  assert.ok(error, "the failure is reported");
  assert.equal(deck.cards.length, 4, "every card is still there");
  assert.equal(unresolved.length, 4, "they are simply all unresolved");
});

test("commander keys are updated when hydration re-keys cards", async () => {
  const { client: api } = client();
  const deck = createDeck({
    name: "Commander re-key",
    cards: [
      createDeckCard({ name: "Sol Ring", quantity: 1, zone: ZONES.COMMANDER }),
      createDeckCard({ name: "Fatal Push", quantity: 1 }),
    ],
  });
  const { deck: hydrated } = await hydrateDeck(deck, api);
  const commander = hydrated.cards.find((card) => card.zone === ZONES.COMMANDER);
  assert.deepEqual(hydrated.commanders, [commander.key]);
  assert.match(commander.key, /^oracle:/);
});
