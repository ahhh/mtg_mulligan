# MTG Mulligan & Draw Odds Companion
## Technical Development Plan

**Status:** In development — steps 1-3 of the 17-step build order are complete (see 1.1)  
**Target:** Static GitHub Pages application  
**Runtime:** Browser-only HTML + JavaScript (no backend, no secrets, no runtime build required)  
**Prepared:** 2026-08-26  
**Implementation status last updated:** 2026-08-26

---

## 1. Executive Summary

Build a static Magic: The Gathering companion application that answers a practical question:

> **Given this exact deck and the cards I know about right now, what are my odds of drawing what I need, and how should that affect a mulligan or keep decision?**

The application should support two closely related modes:

1. **Simulate mode** — shuffle an imported deck, deal opening hands, take London mulligans, bottom cards, and continue drawing.
2. **Analyze mode** — enter the cards from a real physical hand and calculate exact odds from the remaining library without simulating the actual draw.

The probability engine should be deterministic and explainable. Exact probability calculations should use hypergeometric / combinatorial math where the problem permits exact calculation. Monte Carlo simulation should only be used for higher-level questions such as "how often will a new mulligan produce a hand that passes my keep rules?" and should always be labeled as simulation rather than exact probability.

The application should import deck lists from deck-building sites when technically possible, especially Archidekt and Moxfield, but **must not depend on those integrations for core usability**. Both are third-party services with APIs that are not guaranteed contracts for a browser-only GitHub Pages application. Reliable fallbacks should include pasted deck lists and local file import.

Card metadata, Oracle text, mana values, produced mana, and card imagery should come from Scryfall. Imported deck-site categories/tags should be retained when available. Users must be able to add, remove, and override tags locally.

The core product principle is:

> **Exact math first; configurable heuristics second; never hide the assumptions.**

### 1.1 Implementation Status

This section is the live status board. Every other section of this document
remains the design intent; this one records what actually exists.

**Summary:** the app is live and usable end to end. A pasted deck list is
hydrated from Scryfall, dealt, mulliganed, bottomed, and drawn from, with exact
odds updating after every known card. 118 tests pass under `node --test`, and
the whole flow has been exercised against the live Scryfall API. Not yet built:
the mana model, keep heuristics, Monte Carlo comparison, and saved combo groups.

#### Build order status (section 34)

| # | Step | Status |
| --- | --- | --- |
| 1 | `probability.js` + tests | Complete |
| 2 | `deck-model.js` + `state.js` + tests | Complete |
| 3 | Plain text importer | Complete |
| 4 | Scryfall client + cache | Complete |
| 5 | Minimal deck/hand UI | Complete |
| 6 | Deal / draw / mulligan state | Complete |
| 7 | Probability dashboard | Complete |
| 8 | Real-hand mode | Complete |
| 9 | Card tooltip | Complete |
| 10 | Tag editor | Editor, precedence, and persistence complete; inference still basic-land only |
| 11 | Combo groups | Group target complete; no saved-group UI |
| 12 | Archidekt adapter | **Not viable from a static origin** — see Phase 0 below |
| 13 | Moxfield adapter | **Not viable from a static origin** — see Phase 0 below |
| 14 | Mana model | Not started — next |
| 15 | Keep heuristics | Not started |
| 16 | Monte Carlo mulligan comparison | Not started |
| 17 | Polish / accessibility / CSP | CSP, focus, and reduced-motion done; audit outstanding |

#### What exists on disk

```text
index.html             the app shell: landing, deck, tags, and play screens
css/app.css            one stylesheet, dark/light, no framework
js/app.js              the single store, dispatch, and render
js/probability.js      hypergeometric PMF, at-least-one, at-least-N, between,
                       distribution, expected hits. Knows nothing about cards.
js/draw-odds.js        deck-aware queries: getDrawProbability, nextCardProbability,
                       hitDistribution, buildOddsTable, drawsBeforeTurn, oddsByTurn.
                       Implements the known-bottom rule from section 6.5.
js/deck-model.js       canonical Deck / DeckCard / CardInstance, zones, name
                       normalization, instance expansion, target matchers.
js/state.js            seeded shuffle, mulligan state machine, analyze-mode
                       assignment, conservation assertion on every transition.
js/tags.js             effective-tag resolution, precedence, provenance, targets.
js/scryfall.js         batch collection lookup, shared scheduler, 429 backoff,
                       dedupe, cache, deck hydration with degraded mode.
js/storage.js          IndexedDB card cache and deck snapshots, localStorage
                       settings and tag overrides, portable profile export.
js/importers/text.js   plain deck-list parser and importer.
js/ui/                 dom, hand, odds, deck, tooltip.
tests/                 probability, deck-state, mulligan, draw-odds, tags,
                       importers, scryfall, storage, ui-wiring — 118 tests.
fixtures/              sample-deck.txt, scryfall-collection.json (captured live).
```

#### Deviations from this plan

- **`js/draw-odds.js` was added** to the layout in section 5.1. The plan put the
  deck-aware wrapper (`probabilityForGroup`) inside `probability.js`; splitting
  it keeps the pure math free of any deck or game-state knowledge and lets the
  math be tested without constructing decks.
- **`js/ui/dom.js` was added.** A dozen lines of element helpers shared by the
  four UI modules, and the single place `textContent` is enforced.
- **`js/mulligan.js` does not exist yet.** The state machine lives in
  `state.js`; the file is reserved for keep policies (step 15).
- **Probability cross-checks use an exact BigInt rational reference**
  implemented in the test file, not StatTrek. The classic 60-card / 4-copies /
  7-cards case matches the published 39.95% figure.
- **Tests run on `node --test`** with a `package.json` (`"type": "module"`).
  This adds no runtime dependency — the shipped app is still dependency-free
  native ES modules. Browser-DOM testing remains manual (section 23.9); a
  `tests/ui-wiring.test.mjs` suite catches the mechanical failures statically
  (missing element ids, unresolvable imports, `innerHTML`, CSP drift).

#### Phase 0 answers, verified against the live APIs

Answered by request, not by assumption. Captured 2026-08-26.

**Scryfall — works.**

- `POST /cards/collection` returns `access-control-allow-origin: *`, so it works
  from any static origin including GitHub Pages.
- A batch of 75 identifiers is accepted; the 80-card sample deck hydrates fully
  in exactly two requests with zero unresolved cards.
- Name matching is case- and punctuation-insensitive (`urzas mine` resolves), but
  **the joined name of a split card is rejected**: `{"name":"Wear // Tear"}`
  returns `not_found` while `{"name":"Wear"}` resolves it. `lookupName()` sends
  the front face for this reason.
- Double-faced cards carry no top-level `mana_cost` or `image_uris`; both must
  come from `card_faces[0]`.
- Scryfall rejects HTTP-library default User-Agents with HTTP 400
  `generic_user_agent`. Browsers always send their own and forbid scripts from
  changing it, so the app is unaffected — but Node scripts must pass one.
- Image URLs on `cards.scryfall.io` are usable directly. Card records are cached
  for 30 days.

**Archidekt — not viable from a static origin.**

- `GET https://archidekt.com/api/decks/{id}/` returns 200 with full JSON, and
  the payload does contain quantity, card name, Scryfall/Oracle ids, and
  per-card categories.
- But the response carries `access-control-allow-origin: http://localhost:3000`
  — their own development origin, hardcoded, not `*`. A browser on any other
  origin blocks the response. This is not a header the client can work around.
- Direct browser import is therefore impossible without a proxy, which would
  break the browser-only principle in section 3.3.

**Moxfield — not viable from a static origin.**

- `GET https://api2.moxfield.com/v3/decks/all/{id}` returns HTTP 403 from
  Cloudflare with an HTML challenge body. No CORS headers are reached at all.
- Moxfield's terms direct integrators to request API access rather than call the
  endpoint directly.

**Consequence:** steps 12 and 13 should be closed as won't-do for the static
app, not left as pending work. The plain-text importer is the supported path,
exactly as section 3.4 anticipated, and the landing screen says so plainly. If
provider import is ever wanted, it needs a proxy and a decision to give up
browser-only operation.

#### Critical path

Nothing gates the app any more — it is usable. The next most valuable work is
the mana model (step 14), because "can I actually cast this hand" is the
question the hand check still cannot answer, followed by keep heuristics
(step 15) which depend on it.

---

## 2. Product Definition

### 2.1 Primary user jobs

A player should be able to:

- Import a complete Magic deck.
- See the deck's composition and mana curve.
- Deal a random opening hand or enter a real opening hand.
- Hover or focus any card to see its image and useful card details.
- See which cards in hand are castable under a stated mana model.
- See exact probabilities for drawing:
  - a land,
  - a creature,
  - removal,
  - card draw,
  - ramp,
  - a custom tag,
  - one specific card,
  - any card in a user-defined group,
  - at least one hit in the next `N` cards.
- Receive explainable risk notes such as:
  - "You have 2 lands and three 3-mana spells."
  - "You need at least one additional mana source in your next 2 draws to curve into these spells."
  - "Your current probability is 62.4%; your configured keep threshold is 70%."
- Mulligan and repeat.
- Keep a hand, select cards to put on the bottom, then continue drawing.
- Build combo groups:
  - Group A = pieces already held / first half of a combo.
  - Group B = cards that complete or enable the combo.
  - Calculate the probability of drawing any B card in the next `N` draws.
- Retag cards when the imported or automatically suggested classification does not match how the player uses the card.

### 2.2 Product goal

The tool should feel less like a generic statistics calculator and more like a **deck-aware opening-hand assistant**.

The user should not need to translate "37 lands in a 99-card library" into generic hypergeometric fields. The application already knows:

- the deck size,
- what is in the hand,
- what was bottomed,
- what has been drawn,
- what is outside the library,
- what cards match the requested category.

The app should translate that state into readable advice and exact probabilities.

### 2.3 Non-goals for v1

Do **not** attempt in the initial release to:

- Fully solve Magic rules.
- Determine whether arbitrary spells can always be cast through every conditional mana ability.
- Model opponents, interaction, combat, or game outcomes.
- Predict win percentage.
- Automatically decide whether a user "must" mulligan.
- Synchronize private Moxfield or Archidekt accounts.
- Store account credentials.
- Depend on a server or database.
- Use an LLM for card classification or mulligan decisions.
- Claim imported third-party tags are authoritative.
- Treat heuristic classifications such as "removal" as objective facts.

---

## 3. Product Principles

### 3.1 Exact math and heuristics are different layers

The UI should visibly separate:

**Exact**
- "Chance of drawing at least one card tagged Land in the next 2 random cards: 63.7%."

from:

**Heuristic**
- "Your keep rules prefer at least a 70% chance to hit your third mana source by turn 3, so this hand is flagged as risky."

That distinction is essential.

### 3.2 User-defined semantics win

If the user considers a card:

- ramp,
- removal,
- draw,
- a combo piece,
- a virtual land,
- or anything else,

the user's override should take precedence over imported or automatically inferred data.

### 3.3 Browser-only by design

Production requirements:

- GitHub Pages compatible.
- No backend.
- No API keys.
- No secret tokens.
- No authenticated API dependency.
- No runtime Node.js requirement.
- No framework required.
- No build system required for production.

Development-only tests may run in Node.

### 3.4 Third-party deck imports are adapters, not foundations

The internal app should operate on one canonical deck format.

Archidekt, Moxfield, pasted text, and local JSON are merely different ways to create that format.

If one importer breaks, the probability engine and the rest of the application should continue to work.

---

## 4. Recommended User Experience

## 4.1 Landing screen

Primary controls:

```text
MTG Hand Lab

Load a deck:
[ Paste Archidekt or Moxfield URL                         ] [Import]
[ Paste deck list ] [Open]
[ Load saved deck ]

Recent decks:
- Shadow the Hedgehog
- Yuriko
- Modern Burn
```

After a successful import:

```text
Shadow the Hedgehog
99-card drawable library • Commander excluded
36 lands • 12 ramp • 9 removal • 11 draw

[Deal Opening Hand]   [Analyze My Real Hand]
[Edit Tags]           [Deck Details]
```

### 4.2 Opening hand screen

Suggested hierarchy:

```text
OPENING HAND

[Card] [Card] [Card] [Card] [Card] [Card] [Card]

Mana
2 lands in hand
Known colors: U B
Guaranteed under current model:
✓ Card A
✓ Card B
△ Card C — needs one more mana source
! Card D — missing red source

DRAW ODDS
Next card            Next 2 cards       Next 3 cards
Land       34.8%      58.2%              72.9%
Removal     9.8%      18.8%              27.0%
Draw       12.0%      22.6%              32.0%
Ramp        8.7%      16.7%              24.0%

HAND CHECK
You have three spells with mana value 3 and only two known mana sources.
Chance to hit another Land in your next 2 draws: 58.2%
Configured threshold: 70%
Risk: HIGH

[Keep] [Mulligan]
```

### 4.3 Keep flow

When the player keeps after one or more London mulligans:

```text
You have mulliganed 2 times.
Choose 2 cards to put on the bottom.

[card] [card] [card] [card] [card] [card] [card]

2 selected
[Confirm Keep]
```

Known bottom cards matter to future probability and must be tracked separately from the random portion of the library.

### 4.4 Continue-drawing flow

After keep:

```text
TURN / DRAW TRACKER

Hand: 5 cards
Known random library: 92 cards
Known bottom: 2 cards

[Draw Next Card]

Odds before draw:
Land in next card: 35.9%
Land in next 2 random cards: 59.0%

Drawn:
Island

Updated odds:
Land in next card: 35.2%
...
```

### 4.5 Real-hand analysis mode

This is important enough to include early.

The user may be sitting at a table with a physical deck. They should be able to:

1. Import the deck.
2. Click **Analyze My Real Hand**.
3. Search/select the seven cards actually in their hand.
4. Tell the app whether any cards were already bottomed, exiled, revealed, or otherwise known.
5. Receive exact probabilities from the remaining unknown library.

No random shuffle is required in this mode.

### 4.6 Card hover / tooltip behavior

Desktop:
- `pointerenter` opens a tooltip beside the card.
- Include Scryfall image, name, mana cost, type, Oracle text, and current app tags.

Keyboard:
- Focusing the card should expose the same content.

Mobile:
- Tap card to open a modal / bottom sheet.

Example:

```text
Fatal Push                  {B}
Instant

Destroy target creature...

Tags
[Removal] [Interaction]

Imported: #Removal
User override: none

[Edit tags]
```

---

## 5. Architecture

## 5.1 Static repository layout

Recommended production layout:

Recommended layout, annotated with what exists today:

```text
/
├─ index.html                     DONE
├─ css/
│  └─ app.css                     DONE
├─ js/
│  ├─ app.js                      DONE   store, dispatch, render
│  ├─ state.js                    DONE
│  ├─ deck-model.js               DONE
│  ├─ probability.js              DONE   pure math only
│  ├─ draw-odds.js                DONE   added; deck-aware query layer
│  ├─ mulligan.js                 TODO   state machine lives in state.js;
│  │                                     this file is for keep policies
│  ├─ mana.js                     TODO   next
│  ├─ tags.js                     DONE   inference still basic-land only
│  ├─ storage.js                  DONE   IndexedDB + localStorage
│  ├─ scryfall.js                 DONE   batching, backoff, hydration
│  ├─ importers/
│  │  ├─ text.js                  DONE
│  │  ├─ archidekt.js             WON'T DO  CORS pinned to their origin
│  │  └─ moxfield.js              WON'T DO  Cloudflare 403
│  └─ ui/
│     ├─ hand.js                  DONE   hand row, analyze controls
│     ├─ odds.js                  DONE   table, hand check, planner
│     ├─ deck.js                  DONE   import, summary, tag editor
│     ├─ tooltip.js               DONE   hover, focus, mobile sheet
│     └─ dom.js                   DONE   added; textContent-only helpers
├─ tests/
│  ├─ probability.test.mjs        DONE
│  ├─ deck-state.test.mjs         DONE
│  ├─ draw-odds.test.mjs          DONE   added
│  ├─ tags.test.mjs               DONE
│  ├─ importers.test.mjs          DONE
│  ├─ mulligan.test.mjs           DONE
│  ├─ scryfall.test.mjs           DONE   added
│  ├─ storage.test.mjs            DONE   added
│  ├─ ui-wiring.test.mjs          DONE   added; static wiring guards
│  └─ helpers/decks.mjs           DONE   added; shared test decks
├─ fixtures/
│  ├─ sample-deck.txt             DONE
│  └─ scryfall-collection.json    DONE   added; captured from the live API
├─ package.json                   DONE   added; test script only, no deps
├─ .nojekyll                      DONE   added
└─ README.md                      DONE
```

This remains a pure static application. Native browser ES modules work on GitHub Pages without bundling.

A one-file `index.html` version is possible, but this application has enough independent concerns that separate static modules will be easier to test and maintain.

### 5.2 Logical dependency direction

```text
Importers ───────┐
Scryfall ────────┼──> Canonical Deck Model
User overrides ──┘           │
                              v
                        Game / Hand State
                              │
                ┌─────────────┼─────────────┐
                v             v             v
          Probability       Mana        Mulligan
             Engine         Model       Heuristics
                └─────────────┼─────────────┘
                              v
                              UI
```

No UI component should perform probability math directly.

No importer should emit UI-specific objects.

---

## 6. Canonical Data Model

### 6.1 Canonical deck

```js
Deck = {
  id: "local-generated-id",
  name: "Shadow the Hedgehog",
  format: "commander",
  source: {
    type: "moxfield",
    url: "...",
    sourceDeckId: "FjygASBrv3OD0Iz6EUh17A"
  },
  commanders: ["..."],
  cards: [DeckCard],
  importedAt: "2026-08-26T..."
}
```

### 6.2 Card record

```js
DeckCard = {
  key: "oracle-id-or-normalized-name",
  name: "Fatal Push",
  quantity: 1,

  scryfallId: "...",
  oracleId: "...",
  set: "aer",
  collectorNumber: "57",

  manaCost: "{B}",
  manaValue: 1,
  typeLine: "Instant",
  oracleText: "...",
  producedMana: [],

  imageUris: {
    small: "...",
    normal: "..."
  },

  sourceTags: {
    archidekt: [],
    moxfield: []
  },

  inferredTags: [],
  userTags: [],
  removedTags: []
}
```

### 6.3 Effective tags

Effective tags should be computed rather than copied into storage.

Precedence:

```text
user explicit removal
    >
user explicit addition
    >
imported deck-specific tags/categories
    >
automatic inferred tags
    >
basic type-derived tags
```

Recommended helper:

```js
getEffectiveTags(card)
```

Each visible tag should be able to report provenance:

```js
{
  tag: "Removal",
  source: "moxfield"
}
```

or:

```js
{
  tag: "Removal",
  source: "user"
}
```

### 6.4 Game state

```js
GameState = {
  deckId: "...",

  mode: "simulate", // or "analyze"

  mulligansTaken: 0,
  freeMulligansUsed: 0,

  hand: [CardInstance],
  randomLibrary: [CardInstance],  // simulated mode may keep real order
  knownBottom: [CardInstance],
  drawn: [CardInstance],
  knownOutsideLibrary: [CardInstance],

  onPlay: true,
  drawOnTurnOne: false,

  keepProfileId: "default"
}
```

For exact probability, the engine should also be able to operate from **counts** rather than requiring a literal randomized order.

### 6.5 Why "known bottom" must be separate

After London mulligans, cards placed on the bottom are not just ordinary unknown cards in the library.

If:

- 90 cards are randomly ordered,
- 2 specific known cards are on the bottom,

then the probability of drawing one of those two cards in the next two draws is **0%**, not `2 / 92`.

Therefore:

```text
random population = cards in unknown/randomized portion
known bottom      = deterministic tail
```

For a horizon shorter than the random portion, exact odds use only the random portion.

If the user asks for a horizon that reaches the known bottom, calculations should combine:

1. probability over the remaining random portion, and
2. the deterministic bottom sequence.

This is a critical correctness detail.

---

## 7. Deck Import Strategy

## 7.1 Import source priority

Support:

1. **Paste plain deck list** — must always work.
2. **Local `.txt` / `.csv` / `.json` file**.
3. **Archidekt URL** — best effort.
4. **Moxfield URL** — best effort.
5. Later: additional adapters.

The first two are the reliability baseline.

### 7.2 URL recognition

Examples:

```js
parseDeckSource(input)
```

returns:

```js
{ provider: "archidekt", deckId: "123456" }
```

or:

```js
{ provider: "moxfield", deckId: "FjygASBrv3OD0Iz6EUh17A" }
```

Do not mix URL parsing with network fetching.

### 7.3 Archidekt adapter

Current third-party integrations and Archidekt community information indicate a deck-detail endpoint shaped like:

```text
GET https://archidekt.com/api/decks/{deckId}/
```

Archidekt deck data can include:

- cards,
- quantities,
- categories,
- categories that are or are not included in the actual deck,
- card identifiers.

This is particularly useful because Archidekt custom categories can map naturally to the app's functional tags.

However, treat the endpoint as an external, non-guaranteed contract.

**P0 validation requirement:** test this request from an actual GitHub Pages origin, not only from curl, Node, or a browser extension. Browser CORS behavior is what matters.

If direct fetch fails:
- explain that URL import is currently unavailable,
- offer paste/export import immediately,
- never block the rest of the app.

### 7.4 Moxfield adapter

Moxfield has historically exposed deck JSON through endpoints shaped like:

```text
https://api2.moxfield.com/v3/decks/all/{publicId}
```

Older variants also exist in third-party clients.

However, this integration should be considered **fragile in 2026**. Recent community reports indicate Cloudflare/session restrictions can block direct unauthenticated API usage, and the API is undocumented / unsupported for general third-party use.

Therefore:

- Implement Moxfield import behind an adapter.
- Attempt it only as a convenience feature.
- Never make the MVP dependent on it.
- Do not attempt to bypass Cloudflare.
- Do not collect cookies or session tokens.
- Do not ask users to paste authentication tokens.
- If Moxfield offers a supported non-commercial API arrangement later, use that instead.

Fallback UX:

```text
Could not import this Moxfield URL directly.

Moxfield currently blocks this browser request.
Export/copy the deck list from Moxfield and paste it here:

[ textarea ]

[Import Deck]
```

### 7.5 Imported tags / categories

Imported per-card categories are valuable.

Examples:

```text
Removal
Card Draw
Ramp
Combo
Protection
Tutor
```

The adapter should return generic source-tag data:

```js
sourceTags: [
  { name: "Removal", provider: "archidekt" }
]
```

The core model should not care how Archidekt or Moxfield represents those tags internally.

### 7.6 Do not confuse deck tags with card categories

A deck-level tag such as:

```text
Aristocrats
Spellslinger
Vampires
```

describes the deck as a whole.

A card-level tag such as:

```text
Removal
Ramp
Draw
```

describes a card's role.

Store these separately.

### 7.7 Plain deck-list parser

Support common lines:

```text
1 Sol Ring
1x Sol Ring
4 Lightning Bolt
1 Sol Ring (CMM) 396
1x Sol Ring [CMM:396]
```

Ignore or detect common section headings:

```text
Commander
Mainboard
Sideboard
Maybeboard
Companion
```

For Commander calculations, commanders should normally be removed from the drawable library.

Importer output should retain unresolved card names, then the Scryfall client resolves metadata.

---

## 8. Scryfall Integration

### 8.1 Responsibilities

Use Scryfall for:

- canonical card identity,
- card names,
- mana costs,
- mana value,
- type line,
- Oracle text,
- card faces,
- produced mana where available,
- card images,
- legalities if needed later.

### 8.2 Request discipline

Scryfall asks clients to stay below approximately 10 requests per second and recommends appropriate request headers and caching.

Do not perform one network request per card if a deck contains 100 cards.

Use batch collection lookup when possible:

```text
POST /cards/collection
```

which supports batches of up to 75 identifiers.

A 100-card singleton Commander deck can therefore usually be hydrated in two collection requests if identifiers are already known.

For name-only lists, use collection identifiers by name in batches where practical.

### 8.3 Request scheduler

Create one scheduler shared by every Scryfall request:

```js
ScryfallClient = {
  queue,
  cache,
  minDelayMs: 100
}
```

Requirements:

- avoid bursts,
- cache completed card records,
- deduplicate concurrent requests,
- back off on HTTP 429,
- do not continuously retry blocked requests.

### 8.4 Caching

Recommended:

**IndexedDB**
- normalized Scryfall card records,
- imported canonical deck snapshots.

**localStorage**
- UI preferences,
- user tag overrides,
- saved keep profiles,
- last-opened deck,
- lightweight app settings.

Why:
- localStorage is simple but limited and synchronous.
- IndexedDB is better for card metadata and multiple imported decks.

### 8.5 Card images

Use image URIs returned by Scryfall.

Do not prefetch every full-size card image on deck load.

Better:

- render no image in the main hand row, or use small thumbnails,
- lazy-load the larger image when tooltip opens,
- browser-cache the image naturally.

For double-faced cards:
- prefer the appropriate `card_faces[].image_uris`,
- show front face by default,
- provide a flip control if useful.

---

## 9. Tagging System

## 9.1 Core built-in tags

Suggested defaults:

```text
Land
Creature
Mana Source
Ramp
Removal
Counterspell
Board Wipe
Card Draw
Tutor
Protection
Discard
Graveyard
Recursion
Combo Piece
Win Condition
Early Play
Other
```

Tags are **multi-valued**. A card may be both:

```text
Creature + Removal
```

or:

```text
Land + Combo Piece
```

### 9.2 User custom tags

Users should be able to create:

```text
Ninja
Shadow payoff
Needs 3 mana
Combo A
Combo B
Keep if seen
Bad opener
```

Any tag can become a probability target.

That means the probability engine does not need special functions for every category.

Instead:

```js
probabilityOfTag("Removal", nextCards = 2)
```

is logically the same as:

```js
probabilityOfGroup(card => card.tags.has("Removal"), 2)
```

### 9.3 Automatic inference

Automatic tagging should be conservative and labeled **Suggested**.

Safe type-derived tags:

```text
type line contains "Land"      -> Land
type line contains "Creature"  -> Creature
```

Possible Oracle heuristics:

```text
"destroy target..."
"exile target..."
"counter target spell"
"draw a card"
"draw two cards"
"search your library for a ... land"
"add {"
```

These should never silently override user intent.

Use this provenance:

```text
Removal • Suggested
```

not:

```text
Removal
```

unless promoted by the user or imported as a deck category.

### 9.4 Tag editor UX

Deck-level tag editor:

```text
Filter: [ all cards ] [untagged] [Removal]

Card                   Imported          Suggested       My tags
Fatal Push             Removal           —               —
Baleful Strix          Draw              Creature        +Removal
Mystic Remora          Card Draw         Draw            —
...
```

Bulk operations:

- Add tag to selected.
- Remove tag from selected.
- Replace source tag.
- Reset user overrides.
- Save.

### 9.5 Override persistence

Key local overrides by stable card identity:

Preferred:
```text
oracle_id
```

Fallback:
```text
normalized English card name
```

Optionally support:
- global override for a card,
- deck-specific override.

Example:

```js
TagOverride = {
  scope: "deck",
  deckId: "...",
  cardKey: "...",
  added: ["Combo Piece"],
  removed: ["Ramp"]
}
```

---

## 10. Probability Engine

## 10.1 Hypergeometric model

For a random library with:

- `N` cards remaining,
- `K` cards that qualify as a "hit",
- `n` cards drawn,

the probability of exactly `x` hits is:

```text
P(X = x) =
C(K, x) * C(N - K, n - x)
---------------------------
          C(N, n)
```

The most common app calculation is:

> Probability of drawing **at least one** hit in the next `n` cards.

Use:

```text
P(X >= 1) = 1 - C(N-K, n) / C(N, n)
```

### 10.2 Examples of "hits"

A hit predicate might mean:

```text
card has tag Land
card has tag Removal
card name is "Demonic Consultation"
card belongs to Combo Group B
card is a blue mana source
card has mana value <= 2
```

The probability engine should accept generic predicates / sets.

### 10.3 API design

Recommended pure functions:

```js
hypergeomPMF({ population, successes, draws, hits })
probabilityAtLeast({ population, successes, draws, minHits })
probabilityAtLeastOne({ population, successes, draws })
probabilityBetween({ population, successes, draws, minHits, maxHits })
distribution({ population, successes, draws })
```

Deck-aware wrapper:

```js
probabilityForGroup(gameState, cardPredicate, drawCount)
```

### 10.4 Numerical implementation

Do not implement factorials directly.

`100!` and intermediate combination arithmetic are unnecessary and can create numerical issues.

Use one of:

- log-combination sums,
- stable multiplicative combination ratios,
- recurrence between adjacent hypergeometric probabilities.

For this app's typical deck sizes, ordinary JavaScript `Number` is sufficient if formulas avoid naive factorial arithmetic.

### 10.5 Update after every known card

If a land is drawn:

```text
N decreases by 1
K for Land decreases by 1
```

If a nonland is drawn:

```text
N decreases by 1
K for Land is unchanged
```

All visible odds should recompute from canonical game state after each action.

### 10.6 Known cards outside the random library

The probability denominator should exclude:

- current hand,
- commanders in the command zone,
- sideboard,
- companions outside the deck,
- already drawn cards,
- known bottom cards when the requested horizon does not reach them,
- other cards the user marks as known outside the random library.

### 10.7 Next-card probability

The exact probability the **next random card** is a hit is simply:

```text
K / N
```

but call the same generic probability API for consistency.

### 10.8 Multiple categories can overlap

A creature can also be removal.

Therefore percentages across categories need not sum to 100%.

The UI should explicitly say:

> Categories overlap; these percentages are independent hit rates, not slices of a pie chart.

---

## 11. Combo Probability

## 11.1 Basic A -> B question

User selects one or more cards already represented by **Group A**.

They define **Group B** as completion pieces.

If A is already known to be in hand, the relevant question is simply:

> What is the probability of drawing at least one B card in the next `n` draws?

Use the same hypergeometric engine with `B` as the hit set.

### 11.2 A and B both need to be found

For:

> What is the probability the next `n` cards contain at least one A and at least one B?

Use inclusion-exclusion.

Let:

- `A` = number of cards matching A,
- `B` = number matching B,
- `A∪B` = number matching either group,
- `N` = random cards remaining.

Then:

```text
P(A>=1 and B>=1)
  = 1
    - P(no A)
    - P(no B)
    + P(no A and no B)
```

where:

```text
P(no A) = C(N-A, n) / C(N, n)

P(no B) = C(N-B, n) / C(N, n)

P(no A and no B)
  = C(N-|A∪B|, n) / C(N, n)
```

This formula correctly handles cards that belong to both groups.

### 11.3 Combo panel UX

```text
COMBO CALCULATOR

I currently have:
Group A
[x] Thassa's Oracle
[ ] Demonic Consultation
[ ] Tainted Pact

I need any:
Group B
[x] Demonic Consultation
[x] Tainted Pact

Chance to draw a Group B card:
Next card:   2.3%
Next 3:      6.8%
Next 5:     11.2%

[Save as "Oracle Finishers"]
```

### 11.4 Generic named groups

Do not hard-code only two combo boxes.

Internally use:

```js
CardGroup = {
  id,
  name,
  members,
  tagQuery
}
```

The v1 UI may show A and B, but the model should allow future extensions such as:

```text
Engine + Outlet + Payoff
```

---

## 12. Mulligan Model

## 12.1 London mulligan

The standard London mulligan procedure is:

1. Shuffle the current hand back into the library.
2. Draw seven.
3. Once a hand is kept, put a number of cards equal to the number of mulligans taken on the bottom of the library.

Implement this explicitly as state transitions.

### 12.2 Configurable free mulligan

Multiplayer / house-rule contexts can vary.

Do not bake one assumption into the probability engine.

Setting:

```text
Free mulligans: [0] [1] [custom]
```

A free mulligan changes how many cards must be bottomed after keeping, but not how the new seven-card sample is generated.

### 12.3 Mulligan state machine

Recommended:

```text
UNDEALT
  -> DEALT
     -> MULLIGAN
        -> DEALT
     -> KEEP_PENDING_BOTTOM
        -> KEPT
           -> DRAWING
```

Do not permit "Draw next card" before all required bottom cards have been chosen.

### 12.4 Mulligan recommendations are policies

The app should not have one universal "correct mulligan algorithm."

Instead:

```js
KeepProfile = {
  name: "Default Commander",
  minLands: 2,
  maxLands: 5,
  desiredTurn: 3,
  hitThreshold: 0.70,
  requireEarlyPlay: false,
  requiredTags: [],
  preferredTags: [],
  comboRules: []
}
```

### 12.5 Explain the recommendation

Bad:

```text
MULLIGAN
```

Better:

```text
RISKY KEEP

Why:
- 2 lands in hand.
- 4 spells cost 3 or more mana.
- You need one additional Land by your second draw step.
- Exact chance: 58.2%.
- Your keep profile requires at least 70%.

Other positives:
- You already have Removal.
- You already have Card Draw.
```

### 12.6 Recommendation levels

Prefer:

```text
Strong Keep
Keep
Risky
Mulligan Candidate
```

rather than pretending the application has solved match-specific mulligan theory.

---

## 13. "Can I Cast This?" Mana Model

## 13.1 Scope problem

"Can cast" can become extremely complicated in Magic because of:

- colors,
- tapped lands,
- fetch lands,
- conditional lands,
- treasures,
- mana rocks,
- mana creatures,
- alternate costs,
- X spells,
- Phyrexian mana,
- hybrid mana,
- cost reducers,
- commanders,
- rituals,
- effects that change land types.

Therefore define confidence levels rather than overclaim.

### 13.2 v1 deterministic mana model

Model:

- lands in the hand,
- Scryfall `produced_mana` where available,
- basic color production,
- simple unrestricted mana rocks / dorks only if explicitly tagged by the user as `Mana Source`,
- one land play per turn,
- current known hand.

Ignore initially:

- conditional mana requirements,
- sacrifice costs,
- opponent-dependent mana,
- cost reduction,
- rituals unless explicitly modeled,
- unusual alternate casting costs.

### 13.3 Output language

Instead of:

```text
You can 100% cast this.
```

use:

```text
Guaranteed under current mana-source model.
```

That tells the truth without weakening the usefulness.

### 13.4 Mana requirement parsing

Parse mana costs into:

```js
ManaRequirement = {
  generic: 2,
  colored: {
    W: 0,
    U: 1,
    B: 0,
    R: 1,
    G: 0
  },
  hybrid: [],
  phyrexian: [],
  x: 0
}
```

For v1:
- support generic + ordinary colored symbols first,
- mark complex costs as "partial model."

### 13.5 Turn-aware castability

Useful question:

> If I make one land drop per turn using only the cards currently in hand, which spells are guaranteed castable by turn 2 / 3 / 4?

Example:

```text
Turn 1:
✓ Ponder

Turn 2:
✓ Arcane Signet
△ Terminate — missing red source

Turn 3:
✓ Rhystic Study if a third land is drawn
```

### 13.6 Land-hit recommendation

This is the bridge between castability and probability:

```text
Known lands: 2
Target spell: mana value 3
Cards drawn before desired turn: 2
Required additional lands: 1

P(at least 1 Land in next 2) = 58.2%
```

This is more actionable than merely saying "your deck has many 3-drops."

---

## 14. Mana Curve Analysis

### 14.1 Deck metrics

Display:

- land count,
- land percentage,
- average nonland mana value,
- median nonland mana value,
- count by mana value,
- cumulative count at or below 1 / 2 / 3 / 4,
- early-play count,
- ramp count.

Example:

```text
Mana curve
1:  8
2: 16
3: 22
4: 13
5:  7
6+: 4
```

### 14.2 Hand-vs-curve insight

Prefer hand-specific statements:

```text
4 of your 5 nonlands cost 3 or more.
```

over vague deck-level claims.

Deck curve can add context:

```text
42% of your nonland deck costs 3 mana or more.
```

### 14.3 Threshold configuration

Settings:

```text
"Flag a hand if chance to hit required mana on curve is below: 70%"
```

Potential later presets:

```text
Conservative: 80%
Default:      70%
Greedy:       60%
```

These are user preferences, not Magic rules.

---

## 15. Draw-Horizon Model

Probability depends on how many cards will actually be seen.

Add settings:

```text
On the play / on the draw
Draw on turn one? yes/no
Additional draw effects already guaranteed?
```

A helper can compute:

```js
drawsBeforeTurn(targetTurn, gameSettings)
```

Example:

```text
Need third land by turn 3.
You have 2 lands.
You will see 2 normal draw steps before then.
Chance to hit = ...
```

Later, tagged cantrips / draw spells may modify "cards seen," but that should not be assumed unless the user explicitly enables a deeper model.

---

## 16. Simulation Engine

## 16.1 Why simulation is still useful

Exact hypergeometric math is ideal for:

- next card,
- next N cards,
- category hits,
- land distributions.

Simulation is useful for:

> If I mulligan this hand, how often will the next seven-card hand pass my keep profile?

because the keep profile may combine:

- land ranges,
- multiple tags,
- color requirements,
- curve conditions,
- combo pieces,
- user-defined rules.

### 16.2 Monte Carlo API

```js
simulateMulligan({
  deck,
  keepProfile,
  mulligansAlreadyTaken,
  iterations: 20000,
  seed
})
```

Output:

```js
{
  iterations: 20000,
  passRate: 0.734,
  averageLandCount: 2.81,
  tagHitRates: {...},
  seed: "..."
}
```

### 16.3 Reproducibility

Use a seeded PRNG for Monte Carlo so bug reports can be reproduced.

For a new run:
- generate the seed using `crypto.getRandomValues`,
- store/display it optionally.

For interactive "deal next card," a shuffled simulated library can also use the seeded generator.

Do not use `Math.random()` as the only random source.

### 16.4 Label approximation

UI:

```text
Estimated chance a new 7-card hand passes this keep profile:
73.4% (20,000 simulated hands)
```

Do not label it "exact."

---

## 17. State Management

### 17.1 One source of truth

Use a small explicit store:

```js
const state = {
  deck,
  game,
  settings,
  ui
};
```

Actions:

```js
dispatch({ type: "DECK_IMPORTED", deck })
dispatch({ type: "DEAL_OPENING_HAND" })
dispatch({ type: "MULLIGAN" })
dispatch({ type: "KEEP" })
dispatch({ type: "BOTTOM_CARD", cardId })
dispatch({ type: "DRAW_CARD" })
dispatch({ type: "TAG_OVERRIDE", ... })
```

### 17.2 Derived data, not duplicated data

Do not store:

```text
landProbability = 0.348
```

in state.

Calculate it from:
- current random library,
- effective tags,
- draw horizon.

This avoids stale values.

---

## 18. Persistence and Portability

### 18.1 Save locally

Persist:

- imported canonical deck,
- latest source URL,
- tag overrides,
- custom groups,
- combo groups,
- keep profiles,
- app preferences.

### 18.2 Export app profile

Support a portable JSON export:

```json
{
  "version": 1,
  "deck": {...},
  "overrides": {...},
  "groups": {...},
  "keepProfiles": [...]
}
```

This prevents users from losing hours of custom tagging if browser storage is cleared.

### 18.3 Refresh imported deck

Button:

```text
Refresh from source
```

Process:

1. Re-import source deck.
2. Reconcile cards by `oracle_id`.
3. Preserve user overrides.
4. Remove overrides only for cards no longer in the deck after confirmation.
5. Retain custom groups where possible.

---

## 19. Error Handling and Degraded Modes

### 19.1 Deck provider unavailable

```text
Archidekt import is unavailable right now.
You can still paste the exported deck list.
```

### 19.2 Scryfall unavailable

If deck metadata was cached:
- use cached data.

If only names are known:
- probabilities based on user/imported tags may still work,
- hover image and automatic type classification may be unavailable.

### 19.3 Unresolved cards

Show:

```text
3 cards could not be resolved:
- Custom Card Name
- Typo Card
- ...

[Fix]
```

Never silently drop them from deck size.

### 19.4 Probability invariant failure

During development, assert:

```text
0 <= probability <= 1
successes <= population
draws <= population
no negative card quantities
hand + random library + bottom + outside == expected deck
```

---

## 20. Security and Privacy

### 20.1 No secrets

The application should never contain:

- Moxfield credentials,
- Archidekt credentials,
- API keys,
- OAuth secrets.

### 20.2 External text is untrusted

Deck names, card tags, descriptions, and imported strings must be inserted with:

```js
element.textContent = value
```

not raw `innerHTML`.

### 20.3 Content Security Policy

Once endpoints are validated, add a CSP that limits connections and images to required hosts.

Expected connect targets may include:

```text
api.scryfall.com
archidekt.com
api2.moxfield.com
```

Only add providers that the production app actually uses.

Image target:

```text
cards.scryfall.io
```

or the current Scryfall image hosts returned by the API.

### 20.4 Privacy

All:
- deck analysis,
- hand state,
- tag overrides,
- simulations

should remain in the user's browser except for the minimal requests needed to import public decks and resolve public card metadata.

---

## 21. Accessibility

Requirements:

- All cards keyboard-focusable.
- Tooltips available by focus, not hover only.
- Buttons have visible labels.
- Do not encode status using color alone.
- Probability values remain readable by screen readers.
- Modals trap focus correctly.
- Escape closes dialogs.
- Mobile targets at least ~44px.
- Respect reduced-motion preference.

---

## 22. Performance Targets

Suggested:

- Initial shell interactive under 1 second on ordinary broadband after caching.
- Imported 100-card deck usable while card metadata hydrates progressively.
- Probability recomputation effectively instantaneous (< 20 ms for ordinary groups).
- Tag changes update odds without a network request.
- Tooltip opens immediately if cached.
- Monte Carlo 20k-hand simulation ideally < 500 ms on a typical desktop; if slower, move simulation into a Web Worker.

Exact math for a 100-card deck is tiny and should never need a worker.

---

## 23. Testing Strategy

## 23.1 Probability unit tests

Test known values:

- exactly zero successes,
- all successes,
- one-card horizon,
- draw count equals population,
- `P(at least one)`,
- distribution sums approximately to 1,
- invalid inputs.

Compare several cases against a trusted hypergeometric calculator during development.

### 23.2 Deck-state tests

Verify conservation:

```text
starting drawable deck
=
hand
+ random library
+ known bottom
+ drawn / known removed
```

Test:
- deal,
- mulligan,
- keep,
- bottom,
- draw,
- real-hand entry.

### 23.3 London mulligan tests

Example:

```text
Start: 99 drawable cards
Deal: 7 hand / 92 random
Mulligan:
  hand returned -> 99 random
  shuffle
  draw 7
Keep after 2 paid mulligans:
  choose 2 bottom
  final hand = 5
  random top portion = 92
  known bottom = 2
```

Adjust exact counts for configurable free mulligans.

### 23.4 Known-bottom probability tests

Create a tiny synthetic deck:

```text
10 cards
2 hits
draw 2
```

Then bottom both hit cards.

Verify:

```text
P(hit in next 2 random cards) = 0
```

This catches a subtle but serious bug.

### 23.5 Combo-set tests

Test:

- A and B disjoint.
- A and B overlap.
- A already known in hand.
- No B cards remain.
- One B card remains.
- Horizon equals library.

### 23.6 Tag tests

Verify precedence:

```text
Suggested Removal
Imported Removal
User removes Removal
=> not Removal
```

and:

```text
No imported tag
User adds Removal
=> Removal
```

### 23.7 Importer fixtures

Commit sanitized example payloads for:

- Archidekt.
- Moxfield.
- plain text.

Network APIs change. Fixtures let the parser be tested independently from live service availability.

### 23.8 Mana tests

Test ordinary costs:

```text
{1}{U}
{B}{B}
{2}{R}{G}
```

Mark complex costs as unsupported/partial until implemented.

### 23.9 Browser tests

At minimum manually test:

- Chrome,
- Firefox,
- Safari,
- mobile Safari,
- Android Chrome.

Most importantly, validate provider CORS behavior from the deployed GitHub Pages origin.

---

## 24. Development Phases

# Phase 0 — Integration Feasibility Spike

**Status: NOT STARTED.** The Scryfall half should be folded into Phase 2 rather than built as a separate spike page. The Archidekt/Moxfield half is still outstanding and still gates Phase 6.

**Goal:** eliminate risky external assumptions before building UI around them.

Tasks:

- Deploy a minimal GitHub Pages test page.
- Test Scryfall:
  - named card lookup,
  - collection POST,
  - card image loading.
- Test Archidekt public deck fetch from GitHub Pages.
- Test Moxfield public deck fetch from GitHub Pages.
- Capture response shape fixtures.
- Verify whether per-card tags/categories are present.
- Record CORS headers / failure modes.
- Decide exact fallback copy for failed URL import.

Exit criteria:

- Scryfall browser integration works.
- Plain text import path defined.
- Archidekt labeled either supported or best-effort.
- Moxfield labeled either supported or best-effort.
- No MVP requirement depends on an unverified provider API.

# Phase 1 — Exact Probability Core

**Status: COMPLETE.** `js/probability.js`, `js/draw-odds.js`, `js/deck-model.js`, `js/state.js`, `js/tags.js`. Acceptance met: next-card, next-N, tag-based, and arbitrary-predicate group probabilities are exact and tested, including the known-bottom case.

Build without any fancy UI.

Implement:

- canonical deck model,
- hypergeometric PMF,
- at-least-one probability,
- group predicate API,
- deck state,
- known bottom model,
- unit tests.

Acceptance:

```text
Given any test deck + known hand, code returns correct:
- next-card land %
- next-2 land %
- removal %
- arbitrary group %
```

# Phase 2 — Plain Deck Import + Scryfall Hydration

**Status: PARTIAL.** Deck text parser, commander/sideboard handling, and merge-by-key are complete (`js/importers/text.js`, fixture parses to a clean 99). Scryfall batch hydration, the IndexedDB cache, and the unresolved-card workflow are not started — cards import with `resolved: false` and an empty type line, so type-derived tags are inert until this lands.

Implement:

- deck text parser,
- commander / sideboard handling,
- Scryfall batch hydration,
- IndexedDB cache,
- unresolved-card workflow.

Acceptance:

- Paste a normal Commander deck list.
- Correct drawable deck size.
- All normal cards resolve.
- Card image tooltip works.
- Probability targets based on card type work.

# Phase 3 — Hand Simulator

**Status: ENGINE COMPLETE, NO UI.** Seeded shuffle, deal, mulligan, keep, bottom, un-bottom, draw, and reset all exist in `js/state.js` with conservation asserted on every transition. Nothing is wired to the DOM.

Implement:

- seeded shuffle,
- deal seven,
- mulligan,
- keep,
- choose bottom,
- draw next,
- reset.

Acceptance:

- State never loses or duplicates cards.
- Probabilities update after every transition.
- Bottomed cards are treated correctly.

# Phase 4 — Real Hand Analyzer

**Status: ENGINE COMPLETE, NO UI.** `assignToHand`, `assignToKnownBottom`, `assignToKnownOutside`, and `returnToLibrary` cover analyze mode, and refuse to over-assign a card. Autocomplete and the analyze view are not started.

Implement:

- select real hand cards,
- autocomplete from imported deck only,
- optional known-bottom cards,
- live draw probabilities.

Acceptance:

- User can analyze a physical opening hand with no simulated shuffle.

# Phase 5 — Tagging

**Status: PARTIAL.** Effective-tag resolution, the full precedence chain, and provenance reporting are complete and tested (`js/tags.js`). Outstanding: inference beyond basic lands (Removal / Ramp / Card Draw heuristics), imported source tags from real providers, local persistence of overrides, and the bulk tag editor.

Implement:

- built-in tags,
- safe type inference,
- imported source tags,
- custom tags,
- user overrides,
- local persistence,
- bulk tag editor.

Acceptance:

- User can redefine what "Removal" means for this deck.
- Draw odds update immediately.

# Phase 6 — Archidekt / Moxfield Adapters

**Status: NOT STARTED.** Blocked on Phase 0. The importer interface a provider adapter must satisfy is established by `js/importers/text.js`.

Implement only the paths that passed Phase 0.

Requirements:

- adapter interface,
- failure isolation,
- fallback to pasted text,
- no credentials,
- parser fixtures.

Acceptance:

- Supported provider URL imports to same canonical deck structure as text import.
- Provider failure does not break the app.

# Phase 7 — Mana / Curve Assistant

**Status: NOT STARTED.**

Implement:

- mana curve,
- ordinary colored mana requirement parser,
- basic produced-mana model,
- turn-aware land requirement,
- threshold-based risk messages.

Acceptance:

```text
Hand with 2 lands + 3-drops:
App explains exactly how many additional sources are required,
how many cards will be seen before the target turn,
and exact probability of hitting them.
```

# Phase 8 — Combo A/B Calculator

**Status: PARTIAL.** `createGroupTarget` in `js/draw-odds.js` answers the basic 'A known, need one of Group B' question over any horizon, and overlapping groups are tested. Outstanding: saved per-deck groups, the A-and-B-both-needed case from section 11.2, and the panel.

Implement:

- saved groups,
- A-known / B-needed,
- A-and-B future probability,
- overlapping groups,
- next 1 / 2 / 3 / 5 card horizons.

Acceptance:

- User can create and save "combo completion" groups for a deck.

# Phase 9 — Mulligan Policy Simulation

**Status: NOT STARTED.**

Implement:

- keep profiles,
- Monte Carlo new-hand simulation,
- seeded results,
- estimated pass rate,
- explicit "simulation" label.

Acceptance:

```text
"If I mulligan, estimated 74% chance the new seven satisfies my keep profile."
```

# Phase 10 — Polish

**Status: NOT STARTED.** `README.md` exists.

Implement:

- responsive layout,
- keyboard support,
- mobile card modal,
- data export,
- refresh source deck,
- CSP,
- README,
- error states.

---

## 25. MVP Recommendation

A genuinely useful MVP should include:

### Required

- Static GitHub Pages deployment.
- Plain deck-list import.
- Scryfall metadata + hover images.
- Commander exclusion from drawable library.
- Deal opening hand.
- Analyze real hand.
- Exact land / creature / removal / custom-group odds.
- Next 1 / 2 / 3 card horizons.
- London mulligan and bottoming.
- User tag overrides.
- Local persistence.
- Basic combo Group B probability.
- Strong test coverage of probability and deck-state logic.

### Best-effort MVP

- Archidekt direct URL import.
- Moxfield direct URL import.

### Defer

- Advanced mana solving.
- Monte Carlo keep optimization.
- Multiple complex combo groups.
- Automatic semantic card-role classifier beyond conservative rules.
- Account sync.
- Private deck imports.

This ordering ensures the application is valuable even if every deck-site API changes tomorrow.

---

## 26. Recommended Internal Interfaces

### Importer

```js
class DeckImporter {
  canHandle(input) {}
  async import(input) {}
}
```

Return:

```js
{
  provider,
  sourceId,
  name,
  format,
  commanders,
  cards: [
    {
      name,
      quantity,
      set,
      collectorNumber,
      sourceTags
    }
  ]
}
```

### Probability target

```js
const target = {
  id: "land",
  label: "Land",
  matches(card) {
    return getEffectiveTags(card).has("Land");
  }
};
```

### Exact query

```js
getDrawProbability({
  gameState,
  target,
  draws: 2,
  minimumHits: 1
});
```

### Combo group

```js
const groupB = {
  id: "oracle-finisher",
  label: "Oracle finisher",
  cardKeys: new Set([...])
};
```

### Mana insight

```js
analyzeManaNeed({
  hand,
  targetTurn: 3,
  drawsBeforeTarget: 2,
  manaModel
});
```

Return an explanation object, not formatted HTML:

```js
{
  status: "risky",
  currentSources: 2,
  requiredSources: 3,
  additionalNeeded: 1,
  drawHorizon: 2,
  exactHitProbability: 0.582,
  reasons: [...]
}
```

The UI renders this object.

---

## 27. Example Explanation Engine

A small deterministic rule engine can create human-readable statements.

Input:

```js
{
  landsInHand: 2,
  spellsByManaValue: {1: 1, 2: 1, 3: 3, 4: 1},
  targetTurn: 3,
  neededAdditionalLands: 1,
  landHitProbability: 0.582,
  threshold: 0.70
}
```

Output:

```text
You have 2 lands and 3 cards that cost 3 mana.

To cast your 3-mana cards on curve, you need at least 1 additional
land in your next 2 normal draws.

Exact probability: 58.2%.

Your current keep profile flags probabilities below 70% as risky.
```

No AI is needed.

This explanation layer should be built from facts produced by the exact engine so that every sentence is inspectable and testable.

---

## 28. Example Probability Dashboard

```text
Remaining random library: 92

Category           Hits left    Next    Next 2    Next 3
---------------------------------------------------------
Land                 33         35.9%    59.0%     72.8%
Creature             25         27.2%    47.2%     61.9%
Removal               8          8.7%    16.7%     24.0%
Card Draw            10         10.9%    20.7%     29.4%
Ramp                   7          7.6%    14.7%     21.3%
Combo B                2          2.2%     4.3%      6.5%

[+ Add probability group]
```

Use exact counts and recompute after every draw.

---

## 29. Useful Future Features

After the core is trustworthy:

### 29.1 Turn plans

Let the user select:

```text
I want to cast Commander by turn 4.
```

Then calculate:
- required colored sources,
- current sources,
- odds of reaching them.

### 29.2 Virtual lands

User-defined groups:

```text
"Counts as third land by turn 3"
```

could include:
- actual lands,
- one-mana mana creatures,
- cheap rocks,
- land tutors.

This avoids forcing a universal definition of "effective land."

### 29.3 Multiple probability plans

Saved goals:

```text
Hit third land by T3
Find interaction by T2
Find Combo B by T5
Find blue source by T2
```

The opening hand screen can show each goal simultaneously.

### 29.4 Deck comparison

Compare:
- 34 vs 36 vs 38 lands,
- how that changes opening hand distribution,
- chance to hit third / fourth land.

This would make the tool useful during deck construction, not only mulligans.

### 29.5 Opening-hand distribution explorer

Exact graph:

```text
P(0 lands)
P(1 land)
P(2 lands)
...
P(7 lands)
```

### 29.6 Mulligan strategy lab

Given a keep rule:
- simulate many games,
- calculate how often the rule keeps 7 / 6 / 5,
- show average opening card count,
- show frequency of desired tags.

This is a natural long-term extension.

---

## 30. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Moxfield changes / blocks API | URL import breaks | Treat as best-effort adapter; paste import always works |
| Archidekt changes endpoint / CORS | URL import breaks | P0 browser test; adapter isolation; paste fallback |
| Scryfall rate limits | metadata delays | batch requests, 100ms scheduler, IndexedDB cache |
| Automatic tags are wrong | misleading probabilities | provenance + user override + conservative inference |
| Bottomed cards counted as random | incorrect mulligan probabilities | separate `knownBottom` state + tests |
| Mana model overclaims castability | user distrust | explicitly state model assumptions and confidence |
| App state gets inconsistent | wrong probabilities | immutable-ish actions + conservation assertions |
| Category percentages look like pie slices | misunderstanding | explain overlap; avoid pie chart |
| Monte Carlo shown as exact | false precision | label simulation count and seed |
| Browser storage cleared | lost custom tagging | export/import profile JSON |

---

## 31. Phase-0 Questions — Answered

These were open questions. They have now been answered by real requests against
the live APIs; the full findings are in section 1.1 under "Phase 0 answers".

| Question | Answer |
| --- | --- |
| Does Scryfall's batch collection POST work from a static page? | Yes. `access-control-allow-origin: *`, 75 identifiers per request, 80-card deck in two requests. |
| Are Scryfall's required headers compatible with browser restrictions? | Yes. The only header trap is User-Agent, which browsers set themselves and scripts cannot change. |
| Are Scryfall image URLs usable directly? | Yes, from `cards.scryfall.io`. Cached 30 days. |
| Does Archidekt's deck API succeed from GitHub Pages? | The request succeeds but the **browser blocks the response**: their CORS header is pinned to `http://localhost:3000`. |
| Which Archidekt fields hold quantity, name, ids, categories? | All present in the payload — but unreachable from a browser, so moot. |
| Does Moxfield's public endpoint work without authentication? | No. Cloudflare returns HTTP 403 with a challenge page. |
| Does Cloudflare block Moxfield requests? | Yes. |

**Decision:** provider import is closed as won't-do for the browser-only app.
Plain-text paste is the supported path, per section 3.4.

---

## 32. Suggested First Implementation Tickets

### Epic A — Math Core

1. Implement `logChoose`. **DONE**
2. Implement hypergeometric PMF. **DONE**
3. Implement at-least-one. **DONE** (plus at-least-N, between, distribution)
4. Implement arbitrary hit group. **DONE** (tag, predicate, key-set, and single-card targets)
5. Write StatTrek cross-check fixtures. **PARTIAL** — cross-checked against an exact BigInt rational reference in `tests/probability.test.mjs`; external calculator spot-check still outstanding.
6. Implement known-bottom-aware query. **DONE** (`getDrawProbability`)
7. Add invalid-input guards. **DONE**

### Epic B — Deck Core

1. Define canonical card/deck objects. **DONE**
2. Parse plain deck list. **DONE**
3. Separate commanders. **DONE** (section headings and inline `*CMDR*`)
4. Resolve cards with Scryfall. **TODO** — next
5. Store canonical deck. **TODO** — no `storage.js` yet
6. Build effective-tag function. **DONE** (`getEffectiveTags`, `getTagProvenance`)

### Epic C — Hand State — **ALL DONE** (engine only; nothing wired to the DOM)

1. Seeded shuffle. **DONE**
2. Deal 7. **DONE**
3. Mulligan. **DONE**
4. Keep. **DONE**
5. Bottom N. **DONE** (plus un-bottom before drawing starts)
6. Draw next. **DONE**
7. Reset. **DONE**
8. Enter actual hand. **DONE**

### Epic D — UI — **NOT STARTED** (no `index.html` yet)

1. Deck import view.
2. Hand cards.
3. Card tooltip.
4. Probability table.
5. Mulligan controls.
6. Tag editor.
7. Combo A/B panel.

### Epic E — Integrations — **NOT STARTED** (blocked on the Phase 0 questions in section 31)

1. Archidekt URL parser.
2. Archidekt adapter.
3. Moxfield URL parser.
4. Moxfield adapter.
5. User-friendly fallback.

### Epic F — Insights — **NOT STARTED**

1. Curve calculation.
2. Land-on-curve analysis.
3. Keep profiles.
4. Explanation messages.
5. Later: Monte Carlo mulligan comparison.

---

## 33. Definition of Done for v1

The first public version is ready when all of the following are true.

A box is checked only when the item is true end to end. Items whose logic exists
but that no user can reach yet stay unchecked, with the gap named.

- [ ] Works from GitHub Pages with no server. — *no `index.html` yet*
- [x] No API keys or private credentials.
- [ ] A pasted 100-card Commander deck imports successfully. — *parser done and fixture-tested; needs the paste UI and Scryfall hydration*
- [ ] Commander is excluded from the normal draw library. — *logic done and tested*
- [ ] User can deal a random hand. — *engine done; needs UI*
- [ ] User can enter an actual hand. — *engine done; needs UI*
- [ ] Hover/focus shows card image/details. — *needs Scryfall + UI*
- [ ] Land probability is exact. — *engine exact; needs real type lines from Scryfall*
- [ ] Arbitrary tag probability is exact. — *engine exact and tested*
- [ ] Next 1 / 2 / 3 / 5 card probabilities work. — *any horizon supported; needs UI*
- [ ] User can retag any card. — *resolution done; needs editor UI*
- [ ] Overrides survive reload. — *no persistence layer yet*
- [ ] User can take a London mulligan. — *state machine done and tested; needs UI*
- [ ] Required bottom cards are tracked. — *done and tested; drawing is locked until paid*
- [x] Known-bottom cards do not contaminate near-term draw odds.
- [ ] User can keep drawing after the opening hand. — *engine done; needs UI*
- [ ] Combo Group B probability works. — *engine done; needs saved groups and UI*
- [x] A/B overlap is tested.
- [x] Probability tests pass.
- [x] Deck conservation tests pass.
- [ ] Provider failure has a clean fallback. — *no providers wired yet*
- [ ] Mobile layout is usable.
- [ ] Keyboard-only interaction works.
- [ ] Exact probabilities and heuristic recommendations are visually distinct.

---

## 34. Recommended Build Order

If building this personally, use this order:

```text
1. probability.js + tests                    DONE
2. deck-model.js + state.js + tests          DONE
3. plain text importer                       DONE
4. Scryfall client + cache                   DONE
5. minimal deck/hand UI                      DONE
6. deal / draw / mulligan state              DONE
7. probability dashboard                     DONE
8. real-hand mode                            DONE
9. card tooltip                              DONE
10. tag editor                               DONE except automatic inference
11. combo groups                             target DONE, saved-group UI TODO
12. Archidekt adapter                        WON'T DO — CORS pinned to their origin
13. Moxfield adapter                         WON'T DO — Cloudflare 403
14. mana model                               NEXT
15. keep heuristics                          TODO
16. Monte Carlo mulligan comparison          TODO
17. polish / accessibility / CSP             TODO
```

Steps 4 and 5 were the gate, and both are done: the app is reachable and every
card carries a real type line. The remaining work is analysis depth, not access.

This maximizes the chance that each intermediate milestone is already useful.

---

## 35. External Integration Notes Verified During Planning

### Hypergeometric reference

The StatTrek calculator uses the standard hypergeometric model for sampling without replacement from a finite population. That is the correct baseline for random draws from a Magic library.

Reference:
https://stattrek.com/online-calculator/hypergeometric

### Existing `mtg_combos` architecture

The existing `ahhh/mtg_combos` project is already a useful architectural precedent:

- static hosting,
- browser-first JavaScript,
- GitHub Pages compatibility,
- Scryfall card data/images,
- explicit handling of third-party CORS constraints,
- tests against shipped logic.

Reference:
https://github.com/ahhh/mtg_combos

### Scryfall

Scryfall currently asks API users to keep traffic under roughly 10 requests/sec and recommends avoiding redundant requests and using bulk/batch approaches where appropriate. Its card collection endpoint is commonly used to hydrate up to 75 card identifiers in one request.

References:
https://scryfall.com/docs/api
https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17

### Archidekt

Archidekt supports user-created card categories and has publicly visible deck-tagging features. Current third-party integrations use deck-detail endpoints under `/api/decks/{id}/`, but this must be verified from the deployed GitHub Pages origin before treating it as supported.

References:
https://archidekt.com/faq
https://archidekt.com/forum/thread/16962481

### Moxfield

Moxfield supports custom card tags/categories in its deck-building UX. Third-party projects have used `api2.moxfield.com/v3/decks/all/{publicId}` for deck retrieval, but the endpoint is not a stable public API contract. Community reports from June 2026 indicate Cloudflare restrictions may now block direct access in some contexts. Treat it as best-effort unless Moxfield provides a supported integration arrangement.

References:
https://moxfield.com/
https://github.com/natefinch/moxtags/blob/main/DESIGN.md
https://www.reddit.com/r/Moxfield/comments/1ubbry2/deck_api_no_longer_works/

### Mulligan rules

The application should implement the London mulligan as the general baseline: redraw seven, then after choosing to keep, bottom one card for each applicable mulligan. Free mulligans should be a configurable format/house-rule setting.

Reference:
https://magic.wizards.com/en/news/announcements/london-mulligan-2019-06-03

---

## 36. Final Recommendation

Build the application around three intentionally separate engines:

```text
DECK TRUTH
What cards exist and how the user classifies them.

MATH TRUTH
Given the current unknown library, what are the exact probabilities?

DECISION POLICY
Given those facts, what does this particular user consider a keepable hand?
```

That separation solves most of the difficult product-design problems.

It means:

- Archidekt or Moxfield can disappear without breaking the math.
- Automatic tagging can be wrong without corrupting user intent.
- Mulligan thresholds can change without rewriting probability functions.
- Mana heuristics can improve over time without touching draw probabilities.
- Every recommendation can point back to exact inputs.

The strongest first version is not one that tries to solve all of Magic. It is one that is extremely trustworthy about a narrow set of questions:

> **What is left in my deck?**
>
> **What counts as a hit for me?**
>
> **What are my exact odds of seeing one soon?**
>
> **Does that meet the keep criteria I chose?**

Once those answers are correct, the mana, combo, curve, and mulligan-lab features can grow on top of the same foundation.
