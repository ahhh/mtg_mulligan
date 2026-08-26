import test from "node:test";
import assert from "node:assert/strict";

import {
  choose,
  distribution,
  expectedHits,
  hypergeomPMF,
  logChoose,
  probabilityAtLeast,
  probabilityAtLeastOne,
  probabilityBetween,
} from "../js/probability.js";

/** Exact rational reference, used to cross-check the floating-point engine. */
function bigChoose(n, k) {
  if (k < 0 || k > n) return 0n;
  const kk = BigInt(Math.min(k, n - k));
  const N = BigInt(n);
  let num = 1n;
  let den = 1n;
  for (let i = 1n; i <= kk; i += 1n) {
    num *= N - kk + i;
    den *= i;
  }
  return num / den;
}

function exactPMF(population, successes, draws, hits) {
  const numerator = bigChoose(successes, hits) * bigChoose(population - successes, draws - hits);
  const denominator = bigChoose(population, draws);
  if (denominator === 0n) return 0;
  return Number(numerator) / Number(denominator);
}

const CLOSE = 1e-12;

test("choose matches an exact BigInt reference", () => {
  // Exact while the result fits in a safe integer...
  for (const [n, k] of [[0, 0], [5, 0], [5, 5], [10, 3], [52, 5], [99, 7]]) {
    assert.equal(choose(n, k), Number(bigChoose(n, k)), `C(${n},${k})`);
  }
  // ...and within floating-point tolerance beyond it.
  for (const [n, k] of [[100, 50], [200, 7], [300, 150]]) {
    const expected = Number(bigChoose(n, k));
    assert.ok(Math.abs(choose(n, k) - expected) / expected < 1e-12, `C(${n},${k})`);
  }
  assert.equal(choose(5, 6), 0);
  assert.equal(choose(5, -1), 0);
});

test("logChoose is -Infinity outside the support", () => {
  assert.equal(logChoose(5, 6), -Infinity);
  assert.equal(logChoose(5, -1), -Infinity);
  assert.ok(Math.abs(Math.exp(logChoose(52, 5)) - 2598960) < 1e-6);
});

test("pmf matches the exact rational value", () => {
  const cases = [
    [99, 38, 7, 0],
    [99, 38, 7, 3],
    [99, 38, 7, 7],
    [60, 24, 7, 2],
    [40, 17, 7, 4],
    [10, 2, 2, 1],
    [100, 1, 1, 1],
  ];
  for (const [population, successes, draws, hits] of cases) {
    const actual = hypergeomPMF({ population, successes, draws, hits });
    const expected = exactPMF(population, successes, draws, hits);
    assert.ok(
      Math.abs(actual - expected) < CLOSE,
      `pmf(N=${population},K=${successes},n=${draws},x=${hits}): ${actual} vs ${expected}`,
    );
  }
});

test("pmf is zero outside the support", () => {
  // More hits than draws, or more hits than successes.
  assert.equal(hypergeomPMF({ population: 10, successes: 2, draws: 2, hits: 3 }), 0);
  assert.equal(hypergeomPMF({ population: 10, successes: 2, draws: 5, hits: 3 }), 0);
  // Too few non-successes left to fill the rest of the draw.
  assert.equal(hypergeomPMF({ population: 10, successes: 8, draws: 5, hits: 2 }), 0);
});

test("exactly zero successes in the population", () => {
  assert.equal(hypergeomPMF({ population: 40, successes: 0, draws: 7, hits: 0 }), 1);
  assert.equal(probabilityAtLeastOne({ population: 40, successes: 0, draws: 7 }), 0);
  assert.equal(probabilityAtLeast({ population: 40, successes: 0, draws: 7, minHits: 1 }), 0);
});

test("every card in the population is a success", () => {
  assert.equal(hypergeomPMF({ population: 7, successes: 7, draws: 7, hits: 7 }), 1);
  assert.equal(probabilityAtLeastOne({ population: 7, successes: 7, draws: 1 }), 1);
  assert.equal(probabilityAtLeast({ population: 40, successes: 40, draws: 7, minHits: 7 }), 1);
});

test("one-card horizon is K / N", () => {
  const p = probabilityAtLeastOne({ population: 92, successes: 37, draws: 1 });
  assert.ok(Math.abs(p - 37 / 92) < CLOSE);
  assert.ok(Math.abs(hypergeomPMF({ population: 92, successes: 37, draws: 1, hits: 1 }) - 37 / 92) < CLOSE);
});

test("zero draws draws nothing", () => {
  assert.equal(probabilityAtLeastOne({ population: 99, successes: 38, draws: 0 }), 0);
  assert.equal(hypergeomPMF({ population: 99, successes: 38, draws: 0, hits: 0 }), 1);
});

test("drawing the entire population is deterministic", () => {
  assert.equal(hypergeomPMF({ population: 10, successes: 3, draws: 10, hits: 3 }), 1);
  assert.equal(hypergeomPMF({ population: 10, successes: 3, draws: 10, hits: 2 }), 0);
  assert.equal(probabilityAtLeast({ population: 10, successes: 3, draws: 10, minHits: 3 }), 1);
  assert.equal(probabilityAtLeast({ population: 10, successes: 3, draws: 10, minHits: 4 }), 0);
});

test("distribution sums to 1", () => {
  for (const [population, successes, draws] of [[99, 38, 7], [60, 24, 7], [99, 38, 20], [17, 9, 11]]) {
    const dist = distribution({ population, successes, draws });
    const sum = dist.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-10, `sum=${sum} for N=${population},K=${successes},n=${draws}`);
  }
});

test("probabilityAtLeastOne agrees with 1 - P(X = 0)", () => {
  for (const [population, successes, draws] of [[99, 38, 7], [60, 24, 7], [250, 3, 12], [99, 1, 99]]) {
    const viaComplement = 1 - hypergeomPMF({ population, successes, draws, hits: 0 });
    const actual = probabilityAtLeastOne({ population, successes, draws });
    assert.ok(Math.abs(actual - viaComplement) < CLOSE);
  }
});

test("known hypergeometric values", () => {
  // 60-card deck, 24 lands, opening seven: P(at least one land).
  assert.ok(Math.abs(probabilityAtLeastOne({ population: 60, successes: 24, draws: 7 }) - 0.9783855) < 1e-6);
  // 60-card deck, 4 copies, seven cards: the classic ~39.95% figure.
  assert.ok(Math.abs(probabilityAtLeastOne({ population: 60, successes: 4, draws: 7 }) - 0.3994996) < 1e-6);
  // 99-card Commander deck, 38 lands, opening seven: P(at least 3 lands).
  assert.ok(Math.abs(probabilityAtLeast({ population: 99, successes: 38, draws: 7, minHits: 3 }) - 0.5480304) < 1e-6);
  // Exactly 2 of 4 copies in the top 10 of a 60-card deck.
  assert.ok(Math.abs(hypergeomPMF({ population: 60, successes: 4, draws: 10, hits: 2 }) - 0.1130456) < 1e-6);
});

test("probabilityAtLeast agrees with a direct tail sum", () => {
  const cases = [[99, 38, 7, 2], [99, 38, 7, 5], [60, 24, 12, 4], [40, 17, 7, 1], [30, 25, 10, 8]];
  for (const [population, successes, draws, minHits] of cases) {
    let expected = 0;
    for (let hits = minHits; hits <= Math.min(draws, successes); hits += 1) {
      expected += exactPMF(population, successes, draws, hits);
    }
    const actual = probabilityAtLeast({ population, successes, draws, minHits });
    assert.ok(Math.abs(actual - expected) < 1e-10, `N=${population} K=${successes} n=${draws} m=${minHits}`);
  }
});

test("minHits of 0 is certain, impossible minHits is 0", () => {
  assert.equal(probabilityAtLeast({ population: 99, successes: 0, draws: 7, minHits: 0 }), 1);
  assert.equal(probabilityAtLeast({ population: 99, successes: 2, draws: 7, minHits: 3 }), 0);
  assert.equal(probabilityAtLeast({ population: 99, successes: 38, draws: 2, minHits: 3 }), 0);
});

test("forced hits: drawing more cards than there are misses", () => {
  // 10 cards, 8 successes, draw 5 => at least 3 hits is guaranteed.
  assert.equal(probabilityAtLeast({ population: 10, successes: 8, draws: 5, minHits: 3 }), 1);
  assert.equal(probabilityAtLeast({ population: 10, successes: 8, draws: 5, minHits: 4 }) < 1, true);
});

test("probabilityBetween", () => {
  const dist = distribution({ population: 99, successes: 38, draws: 7 });
  const expected = dist[2] + dist[3] + dist[4];
  const actual = probabilityBetween({ population: 99, successes: 38, draws: 7, minHits: 2, maxHits: 4 });
  assert.ok(Math.abs(actual - expected) < CLOSE);
  assert.ok(Math.abs(probabilityBetween({ population: 99, successes: 38, draws: 7, minHits: 0, maxHits: 7 }) - 1) < 1e-10);
});

test("expectedHits", () => {
  assert.ok(Math.abs(expectedHits({ population: 99, successes: 38, draws: 7 }) - (7 * 38) / 99) < CLOSE);
  const dist = distribution({ population: 99, successes: 38, draws: 7 });
  const mean = dist.reduce((acc, p, hits) => acc + p * hits, 0);
  assert.ok(Math.abs(mean - expectedHits({ population: 99, successes: 38, draws: 7 })) < 1e-10);
});

test("invalid inputs throw", () => {
  assert.throws(() => probabilityAtLeastOne({ population: -1, successes: 0, draws: 0 }), RangeError);
  assert.throws(() => probabilityAtLeastOne({ population: 10, successes: 11, draws: 1 }), RangeError);
  assert.throws(() => probabilityAtLeastOne({ population: 10, successes: 2, draws: 11 }), RangeError);
  assert.throws(() => probabilityAtLeastOne({ population: 10.5, successes: 2, draws: 1 }), RangeError);
  assert.throws(() => hypergeomPMF({ population: 10, successes: 2, draws: 1, hits: -1 }), RangeError);
  assert.throws(
    () => probabilityBetween({ population: 10, successes: 2, draws: 3, minHits: 2, maxHits: 1 }),
    RangeError,
  );
});
