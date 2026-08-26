# MTG Mulligan & Draw Odds Companion

A static, browser-only Magic: The Gathering companion that answers:

> Given this exact deck and the cards I know about right now, what are my odds of
> drawing what I need, and how should that affect a mulligan or keep decision?

Exact probabilities come from hypergeometric math. Simulation is only used for
higher-level questions, and is always labeled as simulation.

See [`MTG_Mulligan_Draw_Odds_Dev_Plan.md`](MTG_Mulligan_Draw_Odds_Dev_Plan.md)
for the full technical plan.

## Status

Following the plan's recommended build order.

| Step | Status |
| --- | --- |
| 1. `probability.js` + tests | done |
| 2. `deck-model.js` + `state.js` + tests | done |
| 3. plain text importer | done |
| 4. Scryfall client + cache | next |
| 5. minimal deck/hand UI | not started |

Everything above the line is pure logic with no DOM and no network, so it runs
under `node --test` directly.

## Layout

```text
js/
  probability.js     pure hypergeometric math — knows nothing about cards
  draw-odds.js       deck-aware queries; handles the known-bottom correctness case
  deck-model.js      canonical Deck / DeckCard / CardInstance, targets and matchers
  state.js           game state + transitions (deal, mulligan, keep, bottom, draw)
  tags.js            effective-tag resolution and precedence
  importers/text.js  plain deck-list parser (the always-works import path)
tests/               node:test suites, one per module
fixtures/            sanitized importer fixtures
```

`draw-odds.js` is the one addition to the layout in the plan: it keeps the pure
math in `probability.js` free of any deck or game-state knowledge.

Dependency direction is one-way — importers and Scryfall feed the deck model,
the deck model feeds game state, and only then do probability, mana, and
mulligan logic run. No UI module computes odds itself.

## Development

```sh
npm test           # run every suite
npm run serve      # serve the static app at http://localhost:8080
```

No build step and no dependencies: the app ships as native ES modules, which
GitHub Pages serves as-is.

## Correctness notes

Two details the tests guard closely:

- **Known bottom is not the library.** Cards bottomed after a London mulligan
  are a deterministic tail, not part of the random population. If the draw
  horizon does not reach them, their draw probability is exactly 0 — not
  `count / librarySize`.
- **Conservation.** Every state transition asserts that
  `hand + randomLibrary + knownBottom + knownOutsideLibrary` still equals the
  drawable deck, so no transition can quietly lose or duplicate a card.
