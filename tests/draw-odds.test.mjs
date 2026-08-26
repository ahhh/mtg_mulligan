import test from "node:test";
import assert from "node:assert/strict";

import { findCardByName } from "../js/deck-model.js";
import {
  MODES,
  assignToHand,
  assignToKnownBottom,
  assignToKnownOutside,
  bottomCard,
  createGameState,
  dealOpeningHand,
  drawCards,
  keepHand,
  mulligan,
} from "../js/state.js";
import {
  buildOddsTable,
  createCardTarget,
  createGroupTarget,
  getDrawProbability,
  hitDistribution,
  nextCardProbability,
  probabilityForGroup,
} from "../js/draw-odds.js";
import { probabilityAtLeast, probabilityAtLeastOne } from "../js/probability.js";
import { commanderDeck, syntheticDeck } from "./helpers/decks.mjs";

const CLOSE = 1e-12;

function analyzeState(deck) {
  return createGameState(deck, { mode: MODES.ANALYZE });
}

test("odds from an untouched library match the raw hypergeometric", () => {
  const state = createGameState(commanderDeck());
  const result = getDrawProbability({ state: null, gameState: state, target: "Land", draws: 7 });
  assert.equal(result.population, 99);
  assert.equal(result.successes, 38);
  assert.equal(result.exact, true);
  assert.ok(
    Math.abs(result.probability - probabilityAtLeastOne({ population: 99, successes: 38, draws: 7 })) < CLOSE,
  );
});

test("the next-card probability is K / N", () => {
  const deck = commanderDeck();
  const state = keepHand(dealOpeningHand(createGameState(deck, { seed: "next" })));
  const result = nextCardProbability(state, "Land");
  assert.equal(result.population, 92);
  assert.ok(Math.abs(result.probability - result.successes / 92) < CLOSE);
});

test("known cards in hand leave the denominator", () => {
  const deck = commanderDeck();
  const forest = findCardByName(deck, "Forest");
  let state = analyzeState(deck);
  for (let i = 0; i < 3; i += 1) state = assignToHand(state, forest.key);

  const result = getDrawProbability({ gameState: state, target: "Land", draws: 2 });
  assert.equal(result.population, 96, "three known cards are out of the library");
  assert.equal(result.successes, 35, "and three of the lands are gone with them");
  assert.ok(
    Math.abs(result.probability - probabilityAtLeastOne({ population: 96, successes: 35, draws: 2 })) < CLOSE,
  );
});

test("cards known to be outside the library leave the denominator too", () => {
  const deck = commanderDeck();
  const push = findCardByName(deck, "Fatal Push");
  let state = analyzeState(deck);
  state = assignToKnownOutside(state, push.key);
  const result = getDrawProbability({ gameState: state, target: "Removal", draws: 5 });
  assert.equal(result.population, 98);
  assert.equal(result.successes, 3);
});

test("odds update after every draw", () => {
  const deck = commanderDeck();
  let state = keepHand(dealOpeningHand(createGameState(deck, { seed: "update" })));
  const before = getDrawProbability({ gameState: state, target: "Land", draws: 1 });
  state = drawCards(state, 1);
  const after = getDrawProbability({ gameState: state, target: "Land", draws: 1 });
  assert.equal(after.population, before.population - 1);
  assert.equal(after.successes, before.successes - (state.drawn[0].card.typeLine.includes("Land") ? 1 : 0));
});

test("bottomed cards are unreachable inside the horizon", () => {
  // The subtle bug this guards against: 10 cards, 2 hits, both bottomed.
  // P(hit in the next 2 cards) must be exactly 0, not 2/10.
  const deck = syntheticDeck({ size: 10, hits: 2 });
  const forest = findCardByName(deck, "Forest");
  let state = analyzeState(deck);
  state = assignToKnownBottom(state, forest.key);
  state = assignToKnownBottom(state, forest.key);

  const result = getDrawProbability({ gameState: state, target: "Land", draws: 2 });
  assert.equal(result.probability, 0);
  assert.equal(result.population, 8);
  assert.equal(result.successes, 0);
  assert.equal(result.reachesKnownBottom, false);
});

test("a horizon reaching the known bottom resolves deterministically", () => {
  const deck = syntheticDeck({ size: 10, hits: 2 });
  const forest = findCardByName(deck, "Forest");
  let state = analyzeState(deck);
  state = assignToKnownBottom(state, forest.key);
  state = assignToKnownBottom(state, forest.key);

  // Eight unknown cards, none of them a land; the ninth card is a known Forest.
  assert.equal(getDrawProbability({ gameState: state, target: "Land", draws: 8 }).probability, 0);
  const reaching = getDrawProbability({ gameState: state, target: "Land", draws: 9 });
  assert.equal(reaching.probability, 1);
  assert.equal(reaching.reachesKnownBottom, true);
  assert.equal(reaching.method, "deterministic");
  assert.equal(reaching.knownBottomDrawn, 1);
  assert.equal(reaching.knownBottomHits, 1);
});

test("a horizon past the whole library is clamped and flagged", () => {
  const deck = syntheticDeck({ size: 10, hits: 2 });
  const state = analyzeState(deck);
  const result = getDrawProbability({ gameState: state, target: "Land", draws: 25 });
  assert.equal(result.truncated, true);
  assert.equal(result.draws, 10);
  assert.equal(result.requestedDraws, 25);
  assert.equal(result.probability, 1);
});

test("bottoming after a mulligan does not shrink the random library", () => {
  const deck = commanderDeck();
  let state = keepHand(mulligan(dealOpeningHand(createGameState(deck, { seed: "bottoming" }))));
  const before = getDrawProbability({ gameState: state, target: "Land", draws: 3 });
  const bottomed = state.hand[0];
  state = bottomCard(state, bottomed.id);
  const after = getDrawProbability({ gameState: state, target: "Land", draws: 3 });

  assert.equal(before.population, 92);
  assert.equal(after.population, 92, "the bottomed card never rejoins the random portion");
  assert.equal(after.successes, before.successes);
  assert.ok(Math.abs(after.probability - before.probability) < CLOSE);
});

test("minimumHits asks for multiples", () => {
  const state = createGameState(commanderDeck());
  const result = getDrawProbability({ gameState: state, target: "Land", draws: 7, minimumHits: 3 });
  assert.ok(
    Math.abs(result.probability - probabilityAtLeast({ population: 99, successes: 38, draws: 7, minHits: 3 })) <
      CLOSE,
  );
  assert.ok(result.probability < probabilityForGroup(state, "Land", 7));
});

test("hit distribution sums to one", () => {
  const state = createGameState(commanderDeck());
  const dist = hitDistribution({ gameState: state, target: "Land", draws: 7 });
  assert.equal(dist.length, 8);
  assert.ok(Math.abs(dist.reduce((a, b) => a + b, 0) - 1) < 1e-10);
});

test("group and single-card targets", () => {
  const deck = commanderDeck();
  const push = findCardByName(deck, "Fatal Push");
  const forest = findCardByName(deck, "Forest");
  const state = createGameState(deck);

  const single = getDrawProbability({ gameState: state, target: createCardTarget(push), draws: 7 });
  assert.equal(single.successes, 4);

  const group = createGroupTarget({
    id: "combo-b",
    label: "Combo piece B",
    cardKeys: [push.key, forest.key],
  });
  const both = getDrawProbability({ gameState: state, target: group, draws: 7 });
  assert.equal(both.successes, 40);
  assert.ok(both.probability > single.probability);
});

test("a group with no copies left is impossible", () => {
  const deck = commanderDeck();
  const push = findCardByName(deck, "Fatal Push");
  let state = analyzeState(deck);
  for (let i = 0; i < 4; i += 1) state = assignToHand(state, push.key);
  const result = getDrawProbability({ gameState: state, target: createCardTarget(push), draws: 20 });
  assert.equal(result.successes, 0);
  assert.equal(result.probability, 0);
});

test("the odds table reports in-hand and in-library counts per target", () => {
  const deck = commanderDeck();
  const forest = findCardByName(deck, "Forest");
  let state = analyzeState(deck);
  state = assignToHand(state, forest.key);

  const table = buildOddsTable({
    gameState: state,
    targets: [
      { id: "land", label: "Land", matches: (card) => card.typeLine.includes("Land") },
      { id: "removal", label: "Removal", matches: (card) => card.name === "Fatal Push" },
    ],
    horizons: [1, 2, 3],
  });

  assert.equal(table.length, 2);
  assert.equal(table[0].inHand, 1);
  assert.equal(table[0].inLibrary, 37);
  assert.deepEqual(table[0].horizons.map((h) => h.draws), [1, 2, 3]);
  // Longer horizons can only help.
  const [p1, p2, p3] = table[0].horizons.map((h) => h.probability);
  assert.ok(p1 < p2 && p2 < p3);
  assert.equal(table[1].inHand, 0);
  assert.equal(table[1].inLibrary, 4);
});

test("overlapping categories are independent, not a partition", () => {
  const deck = commanderDeck();
  const state = createGameState(deck);
  const creature = getDrawProbability({ gameState: state, target: "Creature", draws: 7 });
  const twoDrop = getDrawProbability({
    gameState: state,
    target: (card) => card.manaValue === 2,
    draws: 7,
  });
  // The same 57 Grizzly Bears satisfy both targets.
  assert.equal(creature.successes, 57);
  assert.equal(twoDrop.successes, 57);
  assert.ok(creature.probability + twoDrop.probability > 1);
});

test("invalid horizons throw", () => {
  const state = createGameState(commanderDeck());
  assert.throws(() => getDrawProbability({ gameState: state, target: "Land", draws: -1 }), RangeError);
  assert.throws(() => getDrawProbability({ gameState: state, target: "Land", draws: 1.5 }), RangeError);
  assert.throws(
    () => getDrawProbability({ gameState: state, target: "Land", draws: 2, minimumHits: -1 }),
    RangeError,
  );
});
