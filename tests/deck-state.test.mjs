import test from "node:test";
import assert from "node:assert/strict";

import {
  ZONES,
  countMatching,
  createDeck,
  createDeckCard,
  drawableSize,
  expandToInstances,
  findCardByName,
  getDrawableCards,
  normalizeName,
  toMatcher,
} from "../js/deck-model.js";
import {
  MODES,
  PHASES,
  assignToHand,
  assignToKnownBottom,
  assignToKnownOutside,
  conservationReport,
  countInRandomLibrary,
  createGameState,
  dealOpeningHand,
  drawCard,
  drawCards,
  hashSeed,
  keepHand,
  resetGame,
  returnToLibrary,
  shuffle,
} from "../js/state.js";
import { commanderDeck, syntheticDeck } from "./helpers/decks.mjs";

test("normalizeName folds case, punctuation, and diacritics", () => {
  assert.equal(normalizeName("Jötun Grunt"), "jotun grunt");
  assert.equal(normalizeName("  Ach! Hans, Run!  "), "ach hans run");
  assert.equal(normalizeName("Fire//Ice"), "fire // ice");
  assert.equal(normalizeName("Sol Ring"), normalizeName("sol ring"));
});

test("identical cards merge and quantities sum", () => {
  const deck = createDeck({
    cards: [
      createDeckCard({ name: "Forest", quantity: 2 }),
      createDeckCard({ name: "forest", quantity: 2 }),
    ],
  });
  assert.equal(deck.cards.length, 1);
  assert.equal(deck.cards[0].quantity, 4);
});

test("commanders and sideboard are excluded from the drawable library", () => {
  const deck = commanderDeck();
  assert.equal(drawableSize(deck), 99);
  assert.equal(getDrawableCards(deck).every((card) => card.zone === ZONES.MAIN), true);
  assert.equal(expandToInstances(deck).length, 99);
  assert.equal(findCardByName(deck, "Pithing Needle").zone, ZONES.SIDEBOARD);
});

test("instances are unique and countMatching respects targets", () => {
  const deck = commanderDeck();
  const instances = expandToInstances(deck);
  assert.equal(new Set(instances.map((i) => i.id)).size, instances.length);
  assert.equal(countMatching(instances, "Land"), 38);
  assert.equal(countMatching(instances, "Removal"), 4);
  assert.equal(countMatching(instances, toMatcher((card) => card.manaValue === 2)), 57);
});

test("seeded shuffle is reproducible and loses nothing", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ id: i }));
  const a = shuffle(items, hashSeed("kaladesh"));
  const b = shuffle(items, hashSeed("kaladesh"));
  const c = shuffle(items, hashSeed("dominaria"));
  assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
  assert.notDeepEqual(a.items.map((i) => i.id), c.items.map((i) => i.id));
  assert.deepEqual([...a.items].sort((x, y) => x.id - y.id), items);
});

test("dealing conserves cards", () => {
  const deck = commanderDeck();
  const dealt = dealOpeningHand(createGameState(deck, { seed: "test" }));
  assert.equal(dealt.hand.length, 7);
  assert.equal(dealt.randomLibrary.length, 92);
  assert.equal(dealt.phase, PHASES.DEALT);
  assert.equal(conservationReport(dealt).ok, true);
});

test("keeping on the play with no mulligans requires no bottoming", () => {
  const deck = commanderDeck();
  const kept = keepHand(dealOpeningHand(createGameState(deck, { seed: "keep" })));
  assert.equal(kept.phase, PHASES.KEPT);
  assert.equal(kept.cardsToBottom, 0);
});

test("drawing moves exactly one card and updates counts", () => {
  const deck = commanderDeck();
  const kept = keepHand(dealOpeningHand(createGameState(deck, { seed: "draw" })));
  const landsBefore = countInRandomLibrary(kept, "Land");
  const after = drawCard(kept);

  assert.equal(after.hand.length, 8);
  assert.equal(after.randomLibrary.length, 91);
  assert.equal(after.drawn.length, 1);
  assert.equal(conservationReport(after).ok, true);

  const drawnIsLand = after.drawn[0].card.typeLine.includes("Land");
  assert.equal(countInRandomLibrary(after, "Land"), landsBefore - (drawnIsLand ? 1 : 0));
});

test("drawing many cards never loses or duplicates a card", () => {
  const deck = commanderDeck();
  let state = keepHand(dealOpeningHand(createGameState(deck, { seed: "many" })));
  state = drawCards(state, 50);
  assert.equal(state.hand.length, 57);
  assert.equal(state.randomLibrary.length, 42);
  assert.equal(conservationReport(state).ok, true);
});

test("drawing past an empty library throws", () => {
  const deck = syntheticDeck({ size: 10, hits: 2 });
  let state = keepHand(dealOpeningHand(createGameState(deck, { seed: "empty" })));
  state = drawCards(state, 3);
  assert.equal(state.randomLibrary.length, 0);
  assert.throws(() => drawCard(state), /library is empty/i);
});

test("draw is locked until the mulligan cost is paid", () => {
  const deck = commanderDeck();
  const dealt = dealOpeningHand(createGameState(deck, { seed: "locked" }));
  assert.throws(() => drawCard(dealt), /Cannot draw from phase "dealt"/);
});

test("reset returns to an undealt full library", () => {
  const deck = commanderDeck();
  let state = keepHand(dealOpeningHand(createGameState(deck, { seed: "reset" })));
  state = drawCards(state, 5);
  const fresh = resetGame(state);
  assert.equal(fresh.phase, PHASES.UNDEALT);
  assert.equal(fresh.randomLibrary.length, 99);
  assert.equal(fresh.hand.length, 0);
  assert.equal(fresh.drawn.length, 0);
  assert.equal(conservationReport(fresh).ok, true);
});

test("analyze mode assigns known cards without shuffling", () => {
  const deck = commanderDeck();
  const forest = findCardByName(deck, "Forest");
  const push = findCardByName(deck, "Fatal Push");
  let state = createGameState(deck, { mode: MODES.ANALYZE, seed: "analyze" });

  state = assignToHand(state, forest.key);
  state = assignToHand(state, forest.key);
  state = assignToHand(state, push.key);
  state = assignToKnownBottom(state, push.key);
  state = assignToKnownOutside(state, push.key);

  assert.equal(state.hand.length, 3);
  assert.equal(state.knownBottom.length, 1);
  assert.equal(state.knownOutsideLibrary.length, 1);
  assert.equal(state.randomLibrary.length, 94);
  assert.equal(countInRandomLibrary(state, "Land"), 36);
  assert.equal(countInRandomLibrary(state, "Removal"), 1);
  assert.equal(conservationReport(state).ok, true);
});

test("analyze mode refuses to over-assign a card", () => {
  const deck = syntheticDeck({ size: 10, hits: 2 });
  const forest = findCardByName(deck, "Forest");
  let state = createGameState(deck, { mode: MODES.ANALYZE });
  state = assignToHand(state, forest.key);
  state = assignToHand(state, forest.key);
  assert.throws(() => assignToHand(state, forest.key), /No unaccounted copy/);
});

test("a known card can be returned to the unknown library", () => {
  const deck = syntheticDeck({ size: 10, hits: 2 });
  const forest = findCardByName(deck, "Forest");
  let state = createGameState(deck, { mode: MODES.ANALYZE });
  state = assignToHand(state, forest.key);
  const instanceId = state.hand[0].id;
  state = returnToLibrary(state, instanceId);
  assert.equal(state.hand.length, 0);
  assert.equal(state.randomLibrary.length, 10);
  assert.equal(conservationReport(state).ok, true);
});
