/**
 * Game / hand state and its transitions.
 *
 * Every transition is a pure function: it takes a state and returns a new one.
 * The invariant that matters most is conservation — no transition may create,
 * destroy, or duplicate a card:
 *
 *   drawable deck = hand + randomLibrary + knownBottom + knownOutsideLibrary
 *
 * `drawn` is a chronological log of instances that are also in `hand`; it is
 * deliberately excluded from the conservation sum.
 */

import { expandToInstances, toMatcher } from "./deck-model.js";

export const PHASES = Object.freeze({
  UNDEALT: "undealt",
  DEALT: "dealt",
  KEEP_PENDING_BOTTOM: "keep_pending_bottom",
  KEPT: "kept",
  DRAWING: "drawing",
});

export const MODES = Object.freeze({
  SIMULATE: "simulate",
  ANALYZE: "analyze",
});

export const OPENING_HAND_SIZE = 7;

/* ------------------------------------------------------------------ */
/* Seeded RNG                                                          */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hashes a string seed to a 32-bit integer so users can type any seed. */
export function hashSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  const text = String(seed ?? "");
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Fisher-Yates using a seeded stream. Returns the shuffled copy plus the
 * advanced RNG state, so shuffles stay reproducible across serialization.
 */
export function shuffle(items, rngState) {
  const random = mulberry32(rngState);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // Advance the stored state deterministically for the next shuffle.
  return { items: out, rngState: hashSeed(rngState + out.length + 1) };
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export function createGameState(deck, options = {}) {
  const instances = expandToInstances(deck);
  return {
    deckId: deck.id,
    mode: options.mode || MODES.SIMULATE,
    phase: PHASES.UNDEALT,

    mulligansTaken: 0,
    freeMulligans: options.freeMulligans ?? 0,
    cardsToBottom: 0,

    hand: [],
    randomLibrary: instances,
    knownBottom: [],
    knownOutsideLibrary: [],
    drawn: [],

    onPlay: options.onPlay ?? true,
    drawOnTurnOne: options.drawOnTurnOne ?? false,

    seed: options.seed ?? null,
    rngState: hashSeed(options.seed ?? Date.now()),

    keepProfileId: options.keepProfileId || "default",

    /** Every drawable instance, kept for conservation checks and resets. */
    allInstances: instances,
  };
}

/* ------------------------------------------------------------------ */
/* Invariants                                                          */
/* ------------------------------------------------------------------ */

export function conservationReport(state) {
  const zones = [state.hand, state.randomLibrary, state.knownBottom, state.knownOutsideLibrary];
  const seen = new Map();
  for (const zone of zones) {
    for (const instance of zone) {
      seen.set(instance.id, (seen.get(instance.id) || 0) + 1);
    }
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const missing = state.allInstances.filter((instance) => !seen.has(instance.id)).map((i) => i.id);
  const total = zones.reduce((sum, zone) => sum + zone.length, 0);
  return {
    ok: duplicated.length === 0 && missing.length === 0 && total === state.allInstances.length,
    total,
    expected: state.allInstances.length,
    duplicated,
    missing,
  };
}

export function assertConservation(state) {
  const report = conservationReport(state);
  if (!report.ok) {
    throw new Error(
      `Card conservation violated: ${report.total} accounted for vs ${report.expected} expected` +
        (report.duplicated.length ? `; duplicated: ${report.duplicated.join(", ")}` : "") +
        (report.missing.length ? `; missing: ${report.missing.join(", ")}` : ""),
    );
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* Simulate-mode transitions                                           */
/* ------------------------------------------------------------------ */

/** Returns every card to the random library and reshuffles it. */
function reshuffleAll(state) {
  const all = [
    ...state.hand,
    ...state.randomLibrary,
    ...state.knownBottom,
    ...state.knownOutsideLibrary,
  ];
  const { items, rngState } = shuffle(all, state.rngState);
  return { ...state, hand: [], randomLibrary: items, knownBottom: [], knownOutsideLibrary: [], drawn: [], rngState };
}

/**
 * Shuffle and draw a fresh seven. Used for the first hand and for every
 * London mulligan, which always draws a full seven.
 */
export function dealOpeningHand(state) {
  const shuffled = reshuffleAll(state);
  const size = Math.min(OPENING_HAND_SIZE, shuffled.randomLibrary.length);
  return assertConservation({
    ...shuffled,
    hand: shuffled.randomLibrary.slice(0, size),
    randomLibrary: shuffled.randomLibrary.slice(size),
    phase: PHASES.DEALT,
    cardsToBottom: 0,
  });
}

/**
 * London mulligan: hand goes back, shuffle, draw seven again. The cost is paid
 * later, when the hand is kept.
 */
export function mulligan(state) {
  if (state.phase !== PHASES.DEALT) {
    throw new Error(`Cannot mulligan from phase "${state.phase}"`);
  }
  const dealt = dealOpeningHand({ ...state, mulligansTaken: state.mulligansTaken + 1 });
  return dealt;
}

/** How many cards must go to the bottom if this hand is kept. */
export function bottomCountForKeep(state) {
  return Math.max(0, state.mulligansTaken - state.freeMulligans);
}

/**
 * Begin keeping the current hand. If cards must be bottomed, the state enters
 * KEEP_PENDING_BOTTOM and drawing stays locked until they are chosen.
 */
export function keepHand(state) {
  if (state.phase !== PHASES.DEALT) {
    throw new Error(`Cannot keep from phase "${state.phase}"`);
  }
  const cardsToBottom = bottomCountForKeep(state);
  return assertConservation({
    ...state,
    cardsToBottom,
    phase: cardsToBottom > 0 ? PHASES.KEEP_PENDING_BOTTOM : PHASES.KEPT,
  });
}

/**
 * Put one card from hand on the bottom. Bottomed cards are appended, so
 * `knownBottom[0]` is the card closest to the top of the library.
 */
export function bottomCard(state, instanceId) {
  if (state.phase !== PHASES.KEEP_PENDING_BOTTOM) {
    throw new Error(`Cannot bottom a card from phase "${state.phase}"`);
  }
  const index = state.hand.findIndex((instance) => instance.id === instanceId);
  if (index === -1) throw new Error(`Card ${instanceId} is not in hand`);

  const hand = [...state.hand];
  const [moved] = hand.splice(index, 1);
  const knownBottom = [...state.knownBottom, moved];
  const remaining = state.cardsToBottom - 1;

  return assertConservation({
    ...state,
    hand,
    knownBottom,
    cardsToBottom: remaining,
    phase: remaining > 0 ? PHASES.KEEP_PENDING_BOTTOM : PHASES.KEPT,
  });
}

/** Undo one bottoming decision while the keep is still pending. */
export function unbottomCard(state, instanceId) {
  if (state.phase !== PHASES.KEEP_PENDING_BOTTOM && state.phase !== PHASES.KEPT) {
    throw new Error(`Cannot un-bottom a card from phase "${state.phase}"`);
  }
  const index = state.knownBottom.findIndex((instance) => instance.id === instanceId);
  if (index === -1) throw new Error(`Card ${instanceId} is not on the bottom`);
  if (state.drawn.length > 0) {
    throw new Error("Cannot un-bottom a card after drawing has started");
  }

  const knownBottom = [...state.knownBottom];
  const [moved] = knownBottom.splice(index, 1);

  return assertConservation({
    ...state,
    hand: [...state.hand, moved],
    knownBottom,
    cardsToBottom: state.cardsToBottom + 1,
    phase: PHASES.KEEP_PENDING_BOTTOM,
  });
}

/**
 * Draw one card. Draws come off the random library first; once it is empty the
 * known bottom is drawn in its deterministic order.
 */
export function drawCard(state) {
  if (state.phase !== PHASES.KEPT && state.phase !== PHASES.DRAWING) {
    throw new Error(`Cannot draw from phase "${state.phase}"`);
  }
  let randomLibrary = state.randomLibrary;
  let knownBottom = state.knownBottom;
  let drawnCard;

  if (randomLibrary.length > 0) {
    [drawnCard, ...randomLibrary] = randomLibrary;
  } else if (knownBottom.length > 0) {
    [drawnCard, ...knownBottom] = knownBottom;
  } else {
    throw new Error("The library is empty");
  }

  return assertConservation({
    ...state,
    hand: [...state.hand, drawnCard],
    randomLibrary,
    knownBottom,
    drawn: [...state.drawn, drawnCard],
    phase: PHASES.DRAWING,
  });
}

export function drawCards(state, count) {
  let next = state;
  for (let i = 0; i < count; i += 1) next = drawCard(next);
  return next;
}

/** Back to an undealt library with the same deck and settings. */
export function resetGame(state) {
  return assertConservation({
    ...state,
    hand: [],
    randomLibrary: state.allInstances,
    knownBottom: [],
    knownOutsideLibrary: [],
    drawn: [],
    mulligansTaken: 0,
    cardsToBottom: 0,
    phase: PHASES.UNDEALT,
  });
}

/* ------------------------------------------------------------------ */
/* Analyze-mode transitions                                            */
/* ------------------------------------------------------------------ */

function takeInstanceByKey(pool, key) {
  const index = pool.findIndex((instance) => instance.key === key);
  if (index === -1) return null;
  const next = [...pool];
  const [taken] = next.splice(index, 1);
  return { taken, remaining: next };
}

/** Declare that a copy of `key` is in the real hand in front of the user. */
export function assignToHand(state, key) {
  const result = takeInstanceByKey(state.randomLibrary, key);
  if (!result) throw new Error(`No unaccounted copy of ${key} remains in the library`);
  return assertConservation({
    ...state,
    hand: [...state.hand, result.taken],
    randomLibrary: result.remaining,
    phase: state.phase === PHASES.UNDEALT ? PHASES.DEALT : state.phase,
  });
}

/** Declare that a copy of `key` is a known card on the bottom of the library. */
export function assignToKnownBottom(state, key) {
  const result = takeInstanceByKey(state.randomLibrary, key);
  if (!result) throw new Error(`No unaccounted copy of ${key} remains in the library`);
  return assertConservation({
    ...state,
    knownBottom: [...state.knownBottom, result.taken],
    randomLibrary: result.remaining,
  });
}

/**
 * Declare that a copy of `key` is known to be outside the random library
 * entirely — exiled, in the command zone, revealed to an opponent, and so on.
 */
export function assignToKnownOutside(state, key) {
  const result = takeInstanceByKey(state.randomLibrary, key);
  if (!result) throw new Error(`No unaccounted copy of ${key} remains in the library`);
  return assertConservation({
    ...state,
    knownOutsideLibrary: [...state.knownOutsideLibrary, result.taken],
    randomLibrary: result.remaining,
  });
}

/** Return a specific known card to the unknown portion of the library. */
export function returnToLibrary(state, instanceId) {
  const zones = ["hand", "knownBottom", "knownOutsideLibrary"];
  for (const zone of zones) {
    const index = state[zone].findIndex((instance) => instance.id === instanceId);
    if (index === -1) continue;
    const updated = [...state[zone]];
    const [moved] = updated.splice(index, 1);
    return assertConservation({
      ...state,
      [zone]: updated,
      randomLibrary: [...state.randomLibrary, moved],
      drawn: state.drawn.filter((instance) => instance.id !== instanceId),
    });
  }
  throw new Error(`Card ${instanceId} is not in a known zone`);
}

/* ------------------------------------------------------------------ */
/* Derived views                                                       */
/* ------------------------------------------------------------------ */

export function randomLibrarySize(state) {
  return state.randomLibrary.length;
}

/** How many cards in the unknown portion of the library match a target. */
export function countInRandomLibrary(state, target) {
  const matches = toMatcher(target);
  let count = 0;
  for (const instance of state.randomLibrary) {
    if (matches(instance.card)) count += 1;
  }
  return count;
}

export function countInHand(state, target) {
  const matches = toMatcher(target);
  let count = 0;
  for (const instance of state.hand) {
    if (matches(instance.card)) count += 1;
  }
  return count;
}

/** Can the user draw right now? Bottoming must be finished first. */
export function canDraw(state) {
  return (
    (state.phase === PHASES.KEPT || state.phase === PHASES.DRAWING) &&
    state.randomLibrary.length + state.knownBottom.length > 0
  );
}
