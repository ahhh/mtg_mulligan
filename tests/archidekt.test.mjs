import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ZONES, drawableSize, findCardByName } from "../js/deck-model.js";
import {
  canHandle,
  createArchidektImporter,
  fetchArchidektDeck,
  parseArchidektDeck,
  parseDeckUrl,
  requestUrl,
} from "../js/importers/archidekt.js";

/**
 * A real `GET /api/decks/365563/` response, trimmed to five cards that cover
 * every branch: commander, maybeboard, multi-category, quantity > 1, plain.
 */
const payload = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/archidekt-deck.json", import.meta.url)), "utf8"),
);

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test("deck ids are read from any link shape", () => {
  const cases = [
    "https://archidekt.com/decks/365563/brago_blink",
    "https://archidekt.com/decks/365563/",
    "http://archidekt.com/decks/365563",
    "archidekt.com/decks/365563/slug",
    "  https://archidekt.com/decks/365563  ",
    "365563",
  ];
  for (const input of cases) assert.equal(parseDeckUrl(input), "365563", input);
});

test("non-Archidekt input is declined", () => {
  for (const input of ["", null, "1 Sol Ring", "https://moxfield.com/decks/abc", "https://archidekt.com/"]) {
    assert.equal(parseDeckUrl(input), null);
    assert.equal(canHandle(input), false);
  }
});

test("categories decide zones, not card fields", () => {
  const { deck } = parseArchidektDeck(payload);
  const zoneOf = (name) => findCardByName(deck, name)?.zone;

  // isPremier: true
  assert.equal(zoneOf("Brago, King Eternal"), ZONES.COMMANDER);
  // includedInDeck: false
  assert.equal(zoneOf("Scroll Rack"), ZONES.MAYBEBOARD);
  assert.equal(zoneOf("Pact of Negation"), ZONES.MAIN);
  assert.equal(zoneOf("Arid Mesa"), ZONES.MAIN);
});

test("maybeboard and commander stay out of the library count", () => {
  const { deck } = parseArchidektDeck(payload);
  // Pact of Negation + Arid Mesa + 5 Snow-Covered Island; not Brago, not Scroll Rack.
  assert.equal(drawableSize(deck), 7);
});

test("categories become tags, minus the ones that became zones", () => {
  const { deck } = parseArchidektDeck(payload);
  assert.deepEqual(findCardByName(deck, "Arid Mesa").sourceTags, { archidekt: ["Land", "Fetches"] });
  assert.deepEqual(findCardByName(deck, "Pact of Negation").sourceTags, { archidekt: ["Interaction"] });
  // "Commander" and "Maybeboard" are structural, so they are not tags.
  assert.deepEqual(findCardByName(deck, "Brago, King Eternal").sourceTags, {});
  assert.deepEqual(findCardByName(deck, "Scroll Rack").sourceTags, {});
});

test("printing id and oracle id are not swapped", () => {
  const { deck } = parseArchidektDeck(payload);
  const pact = findCardByName(deck, "Pact of Negation");
  assert.equal(pact.scryfallId, "dd125949-38c4-470f-9128-b80c45621086"); // card.uid
  assert.equal(pact.oracleId, "f3e213a4-ba5a-468a-93b3-c0a34e1bd725"); // card.oracleCard.uid
  assert.notEqual(pact.scryfallId, pact.oracleId);
});

test("quantity, set, and collector number survive", () => {
  const { deck } = parseArchidektDeck(payload);
  const island = findCardByName(deck, "Snow-Covered Island");
  assert.equal(island.quantity, 5);
  const pact = findCardByName(deck, "Pact of Negation");
  assert.equal(pact.set, "a25");
  assert.equal(pact.collectorNumber, "68");
});

test("deck name, source, and format come through", () => {
  const { deck } = parseArchidektDeck(payload);
  assert.equal(deck.name, "Brago Blink");
  assert.equal(deck.format, "commander");
  assert.deepEqual(deck.source, {
    type: "archidekt",
    url: "https://archidekt.com/decks/365563",
    sourceDeckId: "365563",
  });
  assert.deepEqual(deck.commanders, [findCardByName(deck, "Brago, King Eternal").key]);
});

test("cards are left unresolved for Scryfall hydration", () => {
  const { deck } = parseArchidektDeck(payload);
  assert.ok(deck.cards.every((card) => card.resolved === false));
});

test("a nameless entry is reported, not silently dropped", () => {
  const broken = { ...payload, cards: [...payload.cards, { quantity: 1, categories: [], card: {} }] };
  const { deck, problems } = parseArchidektDeck(broken);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, "no card name");
  assert.equal(deck.cards.length, 5);
});

test("junk payloads are rejected", () => {
  for (const bad of [null, {}, { cards: "nope" }, 42]) {
    assert.throws(() => parseArchidektDeck(bad), /Archidekt deck payload/);
  }
  assert.throws(() => parseArchidektDeck({ cards: [] }), /no cards/);
});

test("the proxy is applied to the request URL, and is optional", () => {
  assert.equal(
    requestUrl("365563", "https://proxy.corsfix.com/?url="),
    "https://proxy.corsfix.com/?url=https%3A%2F%2Farchidekt.com%2Fapi%2Fdecks%2F365563%2F",
  );
  assert.equal(requestUrl("365563", ""), "https://archidekt.com/api/decks/365563/");
});

test("fetch failures explain the proxy, not just 'failed to fetch'", async () => {
  const dead = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(fetchArchidektDeck("365563", { fetch: dead }), /rate limited|not be registered/);
  await assert.rejects(fetchArchidektDeck("365563", { fetch: dead, proxy: "" }), /CORS/);
});

test("404 and 403 get their own messages", async () => {
  const status = (code) => async () => ({ ok: false, status: code, json: async () => ({}) });
  await assert.rejects(fetchArchidektDeck("1", { fetch: status(404) }), /No Archidekt deck found/);
  await assert.rejects(fetchArchidektDeck("1", { fetch: status(403) }), /private, or the import proxy/);
});

test("importing end to end goes through the proxy exactly once", async () => {
  const calls = [];
  const importer = createArchidektImporter({
    proxy: "https://example-proxy.test/?url=",
    fetch: async (url) => {
      calls.push(url);
      return okResponse(payload);
    },
  });

  assert.equal(importer.provider, "archidekt");
  const { deck } = await importer.import("https://archidekt.com/decks/365563/brago_blink");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0],
    "https://example-proxy.test/?url=https%3A%2F%2Farchidekt.com%2Fapi%2Fdecks%2F365563%2F",
  );
  assert.equal(deck.name, "Brago Blink");
  assert.equal(drawableSize(deck), 7);
});

test("a non-Archidekt input is refused before any request", async () => {
  const importer = createArchidektImporter({
    fetch: () => assert.fail("should not have fetched"),
  });
  await assert.rejects(importer.import("1 Sol Ring"), /not an Archidekt deck URL/);
});
