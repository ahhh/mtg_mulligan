# MTG Mulligan & Draw Odds Companion

A static, browser-only Magic: The Gathering companion that answers:

> Given this exact deck and the cards I know about right now, what are my odds of
> drawing what I need, and how should that affect a mulligan or keep decision?

Exact probabilities come from hypergeometric math. Simulation is only used for
higher-level questions, and is always labeled as simulation.

Live at <https://mulligan.mtg.lockboxx.org>. See
[`MTG_Mulligan_Draw_Odds_Dev_Plan.md`](MTG_Mulligan_Draw_Odds_Dev_Plan.md) for
the full technical plan.

## What works today

Paste a deck list, and the app resolves every card against Scryfall, then lets
you:

- **Deal an opening hand**, mulligan under the London rule, and choose which
  cards go to the bottom.
- **Draw cards one at a time** and watch every probability update.
- **Read exact draw odds** per category across several draw horizons, with a
  turn planner for "I need two lands by turn four".
- **Analyze a real hand** — no shuffle, just name the cards you can actually see
  and get exact odds from what remains unknown.
- **Edit tags** to decide what counts as a hit. Your edits beat imported
  categories, which beat automatic ones, and every change updates the odds with
  no network request.
- **Export a portable profile** so hours of tagging survive a cleared browser.

Everything stays in your browser. The only network requests are to Scryfall for
public card data.

## Status

Following the plan's recommended build order.

| Step | Status |
| --- | --- |
| 1. `probability.js` + tests | done |
| 2. `deck-model.js` + `state.js` + tests | done |
| 3. plain text importer | done |
| 4. Scryfall client + cache | done |
| 5. minimal deck/hand UI | done |
| 6. deal / draw / mulligan state | done |
| 7. probability dashboard | done |
| 8. real-hand mode | done |
| 9. card tooltip | done |
| 10. tag editor | done, except automatic inference |
| 11. combo groups | targets done, saved-group UI not started |
| 12-13. Archidekt / Moxfield import | won't do — see below |
| 14. mana model | next |
| 15. keep heuristics | not started |
| 16. Monte Carlo mulligan comparison | not started |
| 17. polish / accessibility audit | partly done |

## Layout

```text
index.html           app shell: landing, deck, tags, and play screens
css/app.css          one stylesheet, no framework, dark and light
js/
  app.js             the single store, dispatch, and render
  probability.js     pure hypergeometric math — knows nothing about cards
  draw-odds.js       deck-aware queries; the known-bottom correctness case
  deck-model.js      canonical Deck / DeckCard / CardInstance, targets, matchers
  state.js           game state + transitions (deal, mulligan, keep, bottom, draw)
  tags.js            effective-tag resolution and precedence
  scryfall.js        batched card lookup, scheduler, backoff, deck hydration
  storage.js         IndexedDB card cache and decks, localStorage settings
  importers/text.js  plain deck-list parser (the always-works import path)
  ui/                dom, hand, odds, deck, tooltip
tests/               node:test suites, one per module
fixtures/            sanitized importer and Scryfall fixtures
```

`draw-odds.js` and `ui/dom.js` are the two additions to the layout in the plan.
The first keeps the pure math in `probability.js` free of deck or game-state
knowledge; the second is the one place `textContent` is enforced.

Dependency direction is one-way — importers and Scryfall feed the deck model,
the deck model feeds game state, and only then do probability, mana, and
mulligan logic run. No UI module computes odds itself, and a test enforces it.

## Development

```sh
npm test           # run every suite (118 tests)
npm run serve      # serve the static app at http://localhost:8080
```

No build step and no dependencies: the app ships as native ES modules, which
GitHub Pages serves as-is.

## Correctness notes

Three details the tests guard closely:

- **Known bottom is not the library.** Cards bottomed after a London mulligan
  are a deterministic tail, not part of the random population. If the draw
  horizon does not reach them, their draw probability is exactly 0 — not
  `count / librarySize`.
- **Conservation.** Every state transition asserts that
  `hand + randomLibrary + knownBottom + knownOutsideLibrary` still equals the
  drawable deck, so no transition can quietly lose or duplicate a card.
- **Unresolved cards are never dropped.** A card Scryfall cannot find keeps its
  quantity and stays in the library; it just has no type line. The UI says so
  rather than reporting a confident "0 lands in hand".

## Notes on external APIs

All verified by real requests, not assumed. Full details in section 1.1 of the
plan.

- **Scryfall works from a static origin.** `POST /cards/collection` sends
  `access-control-allow-origin: *`; an 80-card deck hydrates in two requests.
  Two traps: the joined name of a split card (`Wear // Tear`) is rejected and
  must be looked up by its front face, and Scryfall refuses HTTP-library default
  User-Agents — which only affects Node scripts, since browsers set their own.
- **Archidekt import works through a proxy.** The API returns the data, but its
  CORS header is pinned to `http://localhost:3000`, so a browser on any other
  origin is refused the read. That header is Archidekt's, not ours, so no
  client-side change reaches it — the deck id is relayed through an import
  proxy instead. `DEFAULT_PROXY` in `js/importers/archidekt.js` is the only
  place that names the provider, and a test asserts it matches the CSP's
  `connect-src`.
- **Moxfield import is not possible from a browser.** Cloudflare answers with
  HTTP 403 before any CORS header is reached.

Pasting an exported deck list remains the path that always works, which is what
the plan anticipated when it called third-party imports adapters rather than
foundations. Archidekt import is the one adapter built on top of it, and it
degrades to paste whenever the proxy is unavailable.
