/**
 * Exact hypergeometric probability engine.
 *
 * Sampling cards from a library is sampling without replacement from a finite
 * population, so the hypergeometric distribution is the exact model:
 *
 *   P(X = x) = C(K, x) * C(N - K, n - x) / C(N, n)
 *
 * where N = population, K = successes in population, n = draws, x = hits.
 *
 * Nothing here knows about decks, cards, or the UI. Deck-aware wrappers live in
 * `draw-odds.js`.
 */

/** Cumulative log-factorial table, grown on demand. */
const logFactorials = [0];

function logFactorial(n) {
  for (let i = logFactorials.length; i <= n; i += 1) {
    logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  }
  return logFactorials[n];
}

function assertCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Validates a hypergeometric parameter set and returns it normalized.
 */
export function validateParams({ population, successes, draws }) {
  assertCount(population, "population");
  assertCount(successes, "successes");
  assertCount(draws, "draws");
  if (successes > population) {
    throw new RangeError(`successes (${successes}) cannot exceed population (${population})`);
  }
  if (draws > population) {
    throw new RangeError(`draws (${draws}) cannot exceed population (${population})`);
  }
  return { population, successes, draws };
}

/**
 * log(C(n, k)). Returns -Infinity when the combination is zero, which keeps
 * downstream exp() arithmetic well behaved.
 */
export function logChoose(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k)) {
    throw new RangeError(`logChoose requires integers, got (${n}, ${k})`);
  }
  if (k < 0 || n < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * C(n, k) computed multiplicatively — exact for the deck sizes this app sees,
 * and never touches a raw factorial.
 */
export function choose(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k)) {
    throw new RangeError(`choose requires integers, got (${n}, ${k})`);
  }
  if (k < 0 || n < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) {
    result = (result * (n - kk + i)) / i;
  }
  return Math.round(result);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * P(X = hits) — probability of exactly `hits` successes in `draws` cards.
 */
export function hypergeomPMF({ population, successes, draws, hits }) {
  validateParams({ population, successes, draws });
  assertCount(hits, "hits");
  if (hits > draws || hits > successes) return 0;
  if (draws - hits > population - successes) return 0;
  const logP =
    logChoose(successes, hits) +
    logChoose(population - successes, draws - hits) -
    logChoose(population, draws);
  return clamp01(Math.exp(logP));
}

/**
 * The full distribution over hit counts, indexed 0..draws.
 */
export function distribution({ population, successes, draws }) {
  validateParams({ population, successes, draws });
  const out = new Array(draws + 1);
  for (let hits = 0; hits <= draws; hits += 1) {
    out[hits] = hypergeomPMF({ population, successes, draws, hits });
  }
  return out;
}

/**
 * P(X >= minHits). Sums whichever tail is shorter to limit rounding drift.
 */
export function probabilityAtLeast({ population, successes, draws, minHits = 1 }) {
  validateParams({ population, successes, draws });
  assertCount(minHits, "minHits");
  if (minHits === 0) return 1;
  const maxPossible = Math.min(draws, successes);
  if (minHits > maxPossible) return 0;

  const minPossible = Math.max(0, draws - (population - successes));
  if (minHits <= minPossible) return 1;

  // Lower tail is P(X <= minHits - 1), spanning minPossible..minHits-1.
  const lowerTailLength = minHits - minPossible;
  const upperTailLength = maxPossible - minHits + 1;

  if (lowerTailLength <= upperTailLength) {
    let lower = 0;
    for (let hits = minPossible; hits < minHits; hits += 1) {
      lower += hypergeomPMF({ population, successes, draws, hits });
    }
    return clamp01(1 - lower);
  }

  let upper = 0;
  for (let hits = minHits; hits <= maxPossible; hits += 1) {
    upper += hypergeomPMF({ population, successes, draws, hits });
  }
  return clamp01(upper);
}

/**
 * P(X >= 1) — the app's most common question. Uses the closed form
 * 1 - C(N-K, n) / C(N, n) rather than summing the distribution.
 */
export function probabilityAtLeastOne({ population, successes, draws }) {
  validateParams({ population, successes, draws });
  if (successes === 0 || draws === 0) return 0;
  const logMiss = logChoose(population - successes, draws) - logChoose(population, draws);
  return clamp01(1 - Math.exp(logMiss));
}

/**
 * P(minHits <= X <= maxHits).
 */
export function probabilityBetween({ population, successes, draws, minHits, maxHits }) {
  validateParams({ population, successes, draws });
  assertCount(minHits, "minHits");
  assertCount(maxHits, "maxHits");
  if (maxHits < minHits) {
    throw new RangeError(`maxHits (${maxHits}) cannot be below minHits (${minHits})`);
  }
  let total = 0;
  const upper = Math.min(maxHits, draws, successes);
  for (let hits = minHits; hits <= upper; hits += 1) {
    total += hypergeomPMF({ population, successes, draws, hits });
  }
  return clamp01(total);
}

/**
 * Expected number of hits in `draws` cards: n * K / N.
 */
export function expectedHits({ population, successes, draws }) {
  validateParams({ population, successes, draws });
  if (population === 0) return 0;
  return (draws * successes) / population;
}
