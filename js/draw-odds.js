/**
 * Deck-aware probability queries.
 *
 * This is the seam between the pure hypergeometric math in `probability.js` and
 * the game state. It exists as its own module so the math stays testable
 * without decks, and so no UI code ever computes odds itself.
 *
 * The subtle part is the known bottom. Cards put on the bottom after a London
 * mulligan are NOT ordinary unknown library cards: if the draw horizon does not
 * reach them, their probability of being drawn is exactly 0. Only when the
 * horizon runs past the random portion do they enter the calculation, and then
 * they do so deterministically.
 */

import { toMatcher } from "./deck-model.js";
import {
  distribution,
  expectedHits,
  probabilityAtLeast,
  probabilityAtLeastOne,
} from "./probability.js";

/**
 * Exact probability of drawing at least `minimumHits` cards matching `target`
 * within the next `draws` cards.
 *
 * Returns an explanation object rather than a bare number; the UI renders it.
 */
export function getDrawProbability({ gameState, target, draws, minimumHits = 1 }) {
  if (!Number.isInteger(draws) || draws < 0) {
    throw new RangeError(`draws must be a non-negative integer, got ${draws}`);
  }
  if (!Number.isInteger(minimumHits) || minimumHits < 0) {
    throw new RangeError(`minimumHits must be a non-negative integer, got ${minimumHits}`);
  }

  const matches = toMatcher(target);
  const randomLibrary = gameState.randomLibrary;
  const knownBottom = gameState.knownBottom;

  const population = randomLibrary.length;
  const successes = randomLibrary.reduce((n, i) => n + (matches(i.card) ? 1 : 0), 0);

  const available = population + knownBottom.length;
  const clampedDraws = Math.min(draws, available);
  const truncated = clampedDraws < draws;

  const base = {
    targetId: target?.id ?? null,
    targetLabel: target?.label ?? null,
    exact: true,
    method: "hypergeometric",
    population,
    successes,
    draws: clampedDraws,
    requestedDraws: draws,
    truncated,
    minimumHits,
    reachesKnownBottom: false,
    knownBottomHits: 0,
    knownBottomDrawn: 0,
  };

  // Horizon stays inside the unknown portion: ordinary hypergeometric.
  if (clampedDraws <= population) {
    const probability =
      minimumHits === 1
        ? probabilityAtLeastOne({ population, successes, draws: clampedDraws })
        : probabilityAtLeast({ population, successes, draws: clampedDraws, minHits: minimumHits });
    return {
      ...base,
      probability,
      expected: expectedHits({ population, successes, draws: clampedDraws }),
    };
  }

  // Horizon runs past the unknown portion. Every random card is drawn, so all
  // `successes` are guaranteed, plus a deterministic slice of the known bottom.
  const knownBottomDrawn = clampedDraws - population;
  const knownBottomHits = knownBottom
    .slice(0, knownBottomDrawn)
    .reduce((n, i) => n + (matches(i.card) ? 1 : 0), 0);
  const guaranteedHits = successes + knownBottomHits;

  return {
    ...base,
    method: "deterministic",
    reachesKnownBottom: true,
    knownBottomDrawn,
    knownBottomHits,
    probability: guaranteedHits >= minimumHits ? 1 : 0,
    expected: guaranteedHits,
  };
}

/** Convenience: probability of at least one hit in the next `draws` cards. */
export function probabilityForGroup(gameState, target, draws) {
  return getDrawProbability({ gameState, target, draws, minimumHits: 1 }).probability;
}

/**
 * Probability the very next random card is a hit. Mathematically K / N, but
 * routed through the same API so there is one code path to trust.
 */
export function nextCardProbability(gameState, target) {
  return getDrawProbability({ gameState, target, draws: 1, minimumHits: 1 });
}

/**
 * Full hit-count distribution over the next `draws` cards. Only meaningful
 * while the horizon stays inside the unknown portion.
 */
export function hitDistribution({ gameState, target, draws }) {
  const matches = toMatcher(target);
  const population = gameState.randomLibrary.length;
  const successes = gameState.randomLibrary.reduce((n, i) => n + (matches(i.card) ? 1 : 0), 0);
  const clampedDraws = Math.min(draws, population);
  return distribution({ population, successes, draws: clampedDraws });
}

/**
 * A row per target across several draw horizons — the shape the odds dashboard
 * renders. Categories overlap, so these are independent hit rates, not slices
 * of a pie.
 */
export function buildOddsTable({ gameState, targets, horizons = [1, 2, 3] }) {
  return targets.map((target) => {
    const matches = toMatcher(target);
    const inLibrary = gameState.randomLibrary.reduce((n, i) => n + (matches(i.card) ? 1 : 0), 0);
    const inHand = gameState.hand.reduce((n, i) => n + (matches(i.card) ? 1 : 0), 0);
    return {
      target,
      id: target?.id ?? null,
      label: target?.label ?? null,
      inHand,
      inLibrary,
      horizons: horizons.map((draws) => ({
        draws,
        ...getDrawProbability({ gameState, target, draws }),
      })),
    };
  });
}

/** A probability target matching a fixed set of card keys — used by combos. */
export function createGroupTarget({ id, label, cardKeys }) {
  const keys = cardKeys instanceof Set ? cardKeys : new Set(cardKeys);
  return {
    id,
    label: label || id,
    cardKeys: keys,
    matches: (card) => keys.has(card.key),
  };
}

/** A probability target matching one specific card by key. */
export function createCardTarget(card) {
  return {
    id: `card:${card.key}`,
    label: card.name,
    matches: (other) => other.key === card.key,
  };
}

/* ------------------------------------------------------------------ */
/* Draw horizon (plan section 15)                                      */
/* ------------------------------------------------------------------ */

/**
 * How many cards the player will actually see between now and their draw step
 * on `targetTurn`.
 *
 * Only ordinary draw steps count. Cantrips and draw spells are deliberately
 * excluded: the plan is explicit that a deeper model must not be assumed, so
 * extra cards are only counted when the user states them via
 * `guaranteedExtraDraws`.
 */
export function drawsBeforeTurn(targetTurn, settings = {}) {
  const { onPlay = true, drawOnTurnOne = false, currentTurn = 0, guaranteedExtraDraws = 0 } = settings;
  if (!Number.isInteger(targetTurn) || targetTurn < 1) {
    throw new RangeError(`targetTurn must be a positive integer, got ${targetTurn}`);
  }

  // The player on the play skips their first draw step unless a variant grants
  // it; the player on the draw sees one card per turn including turn one.
  const skipsFirstDraw = onPlay && !drawOnTurnOne;
  const drawsThrough = (turn) => Math.max(0, skipsFirstDraw ? turn - 1 : turn);

  const seen = drawsThrough(targetTurn) - drawsThrough(currentTurn);
  return Math.max(0, seen) + guaranteedExtraDraws;
}

/**
 * The question the hand-check panel actually asks: "I need one more land by
 * turn N — what are my odds?" Returns the horizon alongside the probability so
 * the UI can say both without recomputing either.
 */
export function oddsByTurn({ gameState, target, targetTurn, settings = {}, minimumHits = 1 }) {
  const draws = drawsBeforeTurn(targetTurn, settings);
  return { targetTurn, ...getDrawProbability({ gameState, target, draws, minimumHits }) };
}
