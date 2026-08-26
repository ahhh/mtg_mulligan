import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASES,
  bottomCard,
  bottomCountForKeep,
  conservationReport,
  createGameState,
  dealOpeningHand,
  drawCard,
  keepHand,
  mulligan,
  unbottomCard,
} from "../js/state.js";
import { commanderDeck, syntheticDeck } from "./helpers/decks.mjs";

function dealt(options = {}) {
  return dealOpeningHand(createGameState(commanderDeck(), { seed: "london", ...options }));
}

test("a London mulligan always draws a fresh seven", () => {
  let state = dealt();
  assert.equal(state.hand.length, 7);
  assert.equal(state.randomLibrary.length, 92);

  state = mulligan(state);
  assert.equal(state.mulligansTaken, 1);
  assert.equal(state.hand.length, 7, "still seven cards after a mulligan");
  assert.equal(state.randomLibrary.length, 92, "the old hand went back before the new draw");
  assert.equal(state.knownBottom.length, 0, "nothing is bottomed until the hand is kept");
  assert.equal(state.phase, PHASES.DEALT);
  assert.equal(conservationReport(state).ok, true);
});

test("mulliganing reshuffles rather than dealing the same seven", () => {
  const first = dealt();
  const second = mulligan(first);
  assert.notDeepEqual(
    first.hand.map((i) => i.id),
    second.hand.map((i) => i.id),
  );
});

test("two paid mulligans mean bottoming two cards", () => {
  let state = mulligan(mulligan(dealt()));
  assert.equal(state.mulligansTaken, 2);
  assert.equal(bottomCountForKeep(state), 2);

  state = keepHand(state);
  assert.equal(state.phase, PHASES.KEEP_PENDING_BOTTOM);
  assert.equal(state.cardsToBottom, 2);
  assert.throws(() => drawCard(state), /Cannot draw/);

  state = bottomCard(state, state.hand[0].id);
  assert.equal(state.phase, PHASES.KEEP_PENDING_BOTTOM);
  assert.equal(state.cardsToBottom, 1);
  assert.throws(() => drawCard(state), /Cannot draw/);

  state = bottomCard(state, state.hand[0].id);
  assert.equal(state.phase, PHASES.KEPT);
  assert.equal(state.hand.length, 5, "final hand is five cards");
  assert.equal(state.randomLibrary.length, 92, "random portion is unchanged by bottoming");
  assert.equal(state.knownBottom.length, 2);
  assert.equal(conservationReport(state).ok, true);
});

test("a free mulligan costs no cards", () => {
  let state = mulligan(dealt({ freeMulligans: 1 }));
  assert.equal(bottomCountForKeep(state), 0);
  state = keepHand(state);
  assert.equal(state.phase, PHASES.KEPT);
  assert.equal(state.hand.length, 7);

  // The second mulligan is paid for.
  let paid = mulligan(mulligan(dealt({ freeMulligans: 1 })));
  assert.equal(bottomCountForKeep(paid), 1);
});

test("bottomed cards go under the library in the order they were chosen", () => {
  let state = keepHand(mulligan(mulligan(dealt())));
  const firstId = state.hand[0].id;
  state = bottomCard(state, firstId);
  const secondId = state.hand[0].id;
  state = bottomCard(state, secondId);
  assert.deepEqual(state.knownBottom.map((i) => i.id), [firstId, secondId]);
});

test("a bottoming choice can be undone before drawing", () => {
  let state = keepHand(mulligan(dealt()));
  const id = state.hand[0].id;
  state = bottomCard(state, id);
  assert.equal(state.phase, PHASES.KEPT);
  state = unbottomCard(state, id);
  assert.equal(state.phase, PHASES.KEEP_PENDING_BOTTOM);
  assert.equal(state.hand.length, 7);
  assert.equal(state.knownBottom.length, 0);
  assert.equal(conservationReport(state).ok, true);
});

test("a bottoming choice cannot be undone once drawing starts", () => {
  let state = keepHand(mulligan(dealt()));
  state = bottomCard(state, state.hand[0].id);
  const id = state.knownBottom[0].id;
  state = drawCard(state);
  assert.throws(() => unbottomCard(state, id), /Cannot un-bottom/);
});

test("bottoming a card that is not in hand throws", () => {
  const state = keepHand(mulligan(dealt()));
  assert.throws(() => bottomCard(state, "not-a-card"), /not in hand/);
});

test("mulligan is only legal from a dealt hand", () => {
  const kept = keepHand(dealt());
  assert.throws(() => mulligan(kept), /Cannot mulligan from phase "kept"/);
});

test("mulliganing a tiny deck still deals what it can", () => {
  const state = dealOpeningHand(createGameState(syntheticDeck({ size: 5, hits: 2 })));
  assert.equal(state.hand.length, 5);
  assert.equal(state.randomLibrary.length, 0);
});
