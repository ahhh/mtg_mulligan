/**
 * Archidekt deck importer.
 *
 * Archidekt's deck endpoint is public and unauthenticated, but it answers with
 * `access-control-allow-origin: http://localhost:3000` — their own dev origin,
 * hardcoded. A browser on any other origin sends the request, receives the
 * body, and is then refused the read. That header is theirs, not ours, so no
 * client-side change can reach the data (verified against the live API, plan
 * section 1.1). The only fix is a server in the path that re-sends the response
 * with an origin we're allowed to read.
 *
 * Hence `proxy`: a base URL that a full Archidekt API URL is appended to. It is
 * deliberately the *only* thing tying this file to a particular proxy, so
 * switching providers is a one-line change and never touches the parser:
 *
 *   ""                                 direct — works from localhost:3000 only
 *   "https://proxy.corsfix.com/?url="  hosted, requires the site domain to be
 *                                      registered in their dashboard
 *   "https://<worker>.workers.dev/?url="  your own Cloudflare Worker
 *
 * Parsing and fetching are separate on purpose: `parseArchidektDeck` is pure,
 * so the whole mapping is tested against a real captured payload with no
 * network, exactly as the Scryfall client is.
 */

import { ZONES, createDeck, createDeckCard } from "../deck-model.js";

export const ARCHIDEKT_API = "https://archidekt.com/api/decks";

/** Swap this one string to change proxy providers. */
export const DEFAULT_PROXY = "https://proxy.corsfix.com/?url=";

/** `archidekt.com/decks/365563/brago_blink`, with or without scheme or slug. */
const DECK_URL = /archidekt\.com\/decks\/(\d+)/i;

/**
 * The deck id in a URL, or null. A bare numeric string is accepted too, so a
 * pasted id works as well as a pasted link.
 */
export function parseDeckUrl(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const match = text.match(DECK_URL);
  if (match) return match[1];
  return /^\d+$/.test(text) ? text : null;
}

/** True when the input looks like something this importer should take. */
export function canHandle(input) {
  return parseDeckUrl(input) !== null;
}

/**
 * Archidekt does not mark zones on cards. It marks them on deck-level
 * *categories*, which cards then reference by name:
 *
 *   isPremier: true        -> the commander category
 *   includedInDeck: false  -> excluded from the deck proper (Maybeboard)
 *
 * A category literally named "Sideboard" is treated as one; Archidekt ships it
 * as an ordinary included category, so name is the only signal available.
 */
function categoryIndex(payload) {
  const index = new Map();
  for (const category of payload.categories || []) {
    if (!category?.name) continue;
    index.set(category.name, {
      name: category.name,
      zone: category.isPremier
        ? ZONES.COMMANDER
        : category.includedInDeck === false
          ? ZONES.MAYBEBOARD
          : /^sideboard$/i.test(category.name)
            ? ZONES.SIDEBOARD
            : null,
    });
  }
  return index;
}

/** Most specific zone wins, so `['Land', 'Maybeboard']` is a maybeboard card. */
const ZONE_PRECEDENCE = [ZONES.COMMANDER, ZONES.MAYBEBOARD, ZONES.SIDEBOARD];

function zoneForCard(categories, index) {
  const zones = new Set();
  for (const name of categories || []) {
    const zone = index.get(name)?.zone;
    if (zone) zones.add(zone);
  }
  for (const zone of ZONE_PRECEDENCE) if (zones.has(zone)) return zone;
  return ZONES.MAIN;
}

/**
 * Categories that survive as tags. The structural ones already became a zone,
 * so keeping them would double as a meaningless tag on every commander.
 */
function tagsForCard(categories, index) {
  return (categories || []).filter((name) => !index.get(name)?.zone);
}

/**
 * Maps a raw Archidekt deck payload onto the canonical deck model. Pure — no
 * network, no globals — so the mapping is testable against a saved payload.
 *
 * Field paths verified against the live API: `card.uid` is the Scryfall
 * printing id and `card.oracleCard.uid` is the oracle id. They are easy to
 * mix up and a swap would silently mis-hydrate every card.
 */
export function parseArchidektDeck(payload, options = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.cards)) {
    throw new Error("That does not look like an Archidekt deck payload");
  }

  const index = categoryIndex(payload);
  const problems = [];
  const cards = [];

  for (const [position, entry] of payload.cards.entries()) {
    const raw = entry?.card;
    const name = raw?.oracleCard?.name;
    if (!name) {
      problems.push({ line: position + 1, text: `card ${position + 1}`, reason: "no card name" });
      continue;
    }

    const quantity = Number.isInteger(entry.quantity) ? entry.quantity : 1;
    const tags = tagsForCard(entry.categories, index);

    cards.push(
      createDeckCard({
        name,
        quantity,
        zone: zoneForCard(entry.categories, index),
        scryfallId: raw.uid ?? null,
        oracleId: raw.oracleCard?.uid ?? null,
        set: raw.edition?.editioncode ? String(raw.edition.editioncode).toLowerCase() : null,
        collectorNumber: raw.collectorNumber ? String(raw.collectorNumber) : null,
        // Scryfall hydration fills in the rest; these stay unresolved so a
        // failed hydration is still visible as such rather than half-filled.
        sourceTags: tags.length ? { archidekt: tags } : {},
      }),
    );
  }

  if (cards.length === 0) throw new Error("That Archidekt deck has no cards");

  const deckId = payload.id != null ? String(payload.id) : options.deckId ?? null;

  const deck = createDeck({
    name: options.name || payload.name || "Archidekt deck",
    format: options.format || inferFormat(cards),
    source: {
      type: "archidekt",
      url: deckId ? `https://archidekt.com/decks/${deckId}` : null,
      sourceDeckId: deckId,
    },
    cards,
  });

  return { deck, problems };
}

/**
 * Derived from the cards rather than `payload.deckFormat`, whose integer enum
 * is undocumented — only `3` (Commander) was confirmed against a live deck, and
 * guessing at the rest would misreport formats silently.
 */
function inferFormat(cards) {
  if (cards.some((card) => card.zone === ZONES.COMMANDER)) return "commander";
  const mainCount = cards
    .filter((card) => card.zone === ZONES.MAIN)
    .reduce((total, card) => total + card.quantity, 0);
  return mainCount >= 90 ? "commander" : "constructed";
}

/** The URL actually requested, proxy included. Exported so tests can assert it. */
export function requestUrl(deckId, proxy = DEFAULT_PROXY) {
  const target = `${ARCHIDEKT_API}/${deckId}/`;
  return proxy ? `${proxy}${encodeURIComponent(target)}` : target;
}

/**
 * Turns a proxy/network failure into a message that says what to actually do.
 * A CORS block surfaces in the browser as an opaque `TypeError: Failed to
 * fetch` with no status, which on its own tells the user nothing.
 */
function importError(deckId, proxy, cause) {
  const reason = proxy
    ? "The import proxy did not answer. It may be rate limited, or this site's domain may not be registered with it."
    : "Archidekt blocks browser requests from this site (CORS), so an import proxy is required.";
  const error = new Error(`Could not import Archidekt deck ${deckId}. ${reason}`);
  error.cause = cause;
  error.deckId = deckId;
  return error;
}

/**
 * Fetches one deck. `fetch` and `proxy` are injected so this is exercisable
 * without a network, matching the Scryfall client's shape.
 */
export async function fetchArchidektDeck(deckId, options = {}) {
  const { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), proxy = DEFAULT_PROXY } = options;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchArchidektDeck needs a fetch implementation");

  let response;
  try {
    response = await fetchImpl(requestUrl(deckId, proxy), { headers: { Accept: "application/json" } });
  } catch (cause) {
    throw importError(deckId, proxy, cause);
  }

  if (response.status === 404) throw new Error(`No Archidekt deck found with id ${deckId}`);
  if (response.status === 403) {
    throw new Error(
      `Archidekt deck ${deckId} is private, or the import proxy rejected this site's domain.`,
    );
  }
  if (!response.ok) throw importError(deckId, proxy, new Error(`HTTP ${response.status}`));

  try {
    return await response.json();
  } catch (cause) {
    throw importError(deckId, proxy, cause);
  }
}

/**
 * Builds an importer matching the interface `textImporter` implements, so the
 * app can treat providers interchangeably.
 */
export function createArchidektImporter(options = {}) {
  return {
    provider: "archidekt",
    canHandle,
    async import(input, importOptions = {}) {
      const deckId = parseDeckUrl(input);
      if (!deckId) throw new Error("That is not an Archidekt deck URL");
      const payload = await fetchArchidektDeck(deckId, options);
      return parseArchidektDeck(payload, { ...importOptions, deckId });
    },
  };
}

export const archidektImporter = createArchidektImporter();
