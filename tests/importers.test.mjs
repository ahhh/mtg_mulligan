import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ZONES, drawableSize, findCardByName, getSideboard } from "../js/deck-model.js";
import { canHandle, importText, parseDeckList } from "../js/importers/text.js";

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");

test("quantity forms", () => {
  const { cards } = parseDeckList(["1 Sol Ring", "1x Sol Ring", "4 Lightning Bolt", "Black Lotus"].join("\n"));
  assert.deepEqual(
    cards.map((c) => [c.quantity, c.name]),
    [
      [1, "Sol Ring"],
      [1, "Sol Ring"],
      [4, "Lightning Bolt"],
      [1, "Black Lotus"],
    ],
  );
});

test("set and collector-number suffixes", () => {
  const { cards } = parseDeckList(["1 Sol Ring (CMM) 396", "1x Sol Ring [CMM:396]", "1 Sol Ring (cmm)"].join("\n"));
  assert.deepEqual(cards.map((c) => c.name), ["Sol Ring", "Sol Ring", "Sol Ring"]);
  assert.deepEqual(cards.map((c) => c.set), ["cmm", "cmm", "cmm"]);
  assert.deepEqual(cards.map((c) => c.collectorNumber), ["396", "396", null]);
});

test("card names containing parentheses survive", () => {
  const { cards } = parseDeckList("1 Erase (Not the Urza's Legacy One)");
  assert.equal(cards[0].name, "Erase (Not the Urza's Legacy One)");
});

test("section headings switch zones", () => {
  const { cards } = parseDeckList(
    ["Commander", "1 Sidisi, Brood Tyrant", "Deck", "1 Sol Ring", "Sideboard (15)", "1 Pithing Needle", "Maybeboard", "1 Buried Alive"].join("\n"),
  );
  assert.deepEqual(
    cards.map((c) => [c.name, c.zone]),
    [
      ["Sidisi, Brood Tyrant", ZONES.COMMANDER],
      ["Sol Ring", ZONES.MAIN],
      ["Pithing Needle", ZONES.SIDEBOARD],
      ["Buried Alive", ZONES.MAYBEBOARD],
    ],
  );
});

test("inline *CMDR* annotations mark commanders and become source tags", () => {
  const { cards } = parseDeckList(["1 Sidisi, Brood Tyrant *CMDR*", "1 Fatal Push #Removal#"].join("\n"));
  assert.equal(cards[0].zone, ZONES.COMMANDER);
  assert.deepEqual(cards[0].sourceTags, []);
  assert.equal(cards[1].name, "Fatal Push");
  assert.deepEqual(cards[1].sourceTags, ["Removal"]);
});

test("comments and blank lines are ignored", () => {
  const { cards, problems } = parseDeckList(["// my deck", "", "   ", "1 Sol Ring", "// end"].join("\n"));
  assert.equal(cards.length, 1);
  assert.deepEqual(problems, []);
});

test("canHandle rejects URLs and JSON, accepts deck lists", () => {
  assert.equal(canHandle("1 Sol Ring"), true);
  assert.equal(canHandle("https://archidekt.com/decks/123"), false);
  assert.equal(canHandle('{"deck": []}'), false);
  assert.equal(canHandle("   "), false);
  assert.equal(canHandle(42), false);
});

test("importing an empty list throws", () => {
  assert.throws(() => importText("// nothing here"), /No cards found/);
});

test("the sample fixture imports as a legal 99-card commander deck", () => {
  const { deck, problems } = importText(fixture("sample-deck.txt"), { name: "Sidisi" });

  assert.deepEqual(problems, []);
  assert.equal(deck.format, "commander");
  assert.equal(drawableSize(deck), 99, "commander and sideboard are not drawable");
  assert.equal(deck.commanders.length, 1);

  const commander = findCardByName(deck, "Sidisi, Brood Tyrant");
  assert.equal(commander.zone, ZONES.COMMANDER);
  assert.equal(commander.set, "c15");
  assert.equal(commander.collectorNumber, "46");

  assert.equal(findCardByName(deck, "Arcane Signet").set, "eld");
  assert.equal(getSideboard(deck).length, 1);
  assert.equal(findCardByName(deck, "Forest").quantity, 9);
});

test("nothing in a freshly imported deck is resolved yet", () => {
  const { deck } = importText(fixture("sample-deck.txt"));
  assert.equal(deck.cards.every((card) => card.resolved === false), true);
  assert.equal(deck.cards.every((card) => card.typeLine === ""), true);
});

test("a 60-card list without sections is treated as constructed", () => {
  const lines = ["4 Lightning Bolt", "24 Mountain", "32 Grizzly Bears"];
  const { deck } = importText(lines.join("\n"));
  assert.equal(deck.format, "constructed");
  assert.equal(drawableSize(deck), 60);
});
