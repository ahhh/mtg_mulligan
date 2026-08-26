/**
 * Scryfall client.
 *
 * Responsibilities (plan section 8): canonical card identity, mana cost, mana
 * value, type line, Oracle text, faces, produced mana, and image URIs. Nothing
 * in here knows about probability or game state — it only hydrates the
 * canonical deck model.
 *
 * Three rules shape the design:
 *
 *   1. Never one request per card. `POST /cards/collection` takes 75
 *      identifiers, so a 100-card deck is two requests.
 *   2. One shared scheduler. Scryfall asks for well under 10 requests/second;
 *      requests are serialized with a minimum delay and back off on HTTP 429.
 *   3. Everything is injectable. `fetch`, `cache`, and `sleep` are parameters,
 *      so the whole client is testable under `node --test` with no network.
 */

import { ZONES, normalizeName } from "./deck-model.js";

export const SCRYFALL_API = "https://api.scryfall.com";

/** Scryfall's documented maximum identifiers per collection request. */
export const COLLECTION_BATCH_SIZE = 75;

/** Scryfall asks for ~10 req/s; 100ms between request starts is well inside. */
export const DEFAULT_MIN_DELAY_MS = 100;

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/** Front face of a multi-faced card, or the card itself when single-faced. */
function faces(raw) {
  return Array.isArray(raw.card_faces) && raw.card_faces.length > 0 ? raw.card_faces : [raw];
}

/**
 * Image URIs, preferring the top-level set and falling back to the front face.
 * Transforming and modal double-faced cards only carry images per face.
 */
function pickImageUris(raw) {
  if (raw.image_uris) return raw.image_uris;
  const [front] = faces(raw);
  return front?.image_uris ?? null;
}

/**
 * Converts a raw Scryfall card into the flat subset the deck model stores.
 * Keeping this narrow means an API change touches exactly one function.
 */
export function normalizeScryfallCard(raw) {
  if (!raw || typeof raw !== "object") throw new TypeError("normalizeScryfallCard requires a card");
  const cardFaces = faces(raw);
  const manaCost =
    raw.mana_cost ??
    (cardFaces.length > 1
      ? cardFaces.map((face) => face.mana_cost || "").filter(Boolean).join(" // ") || null
      : null);

  return {
    scryfallId: raw.id ?? null,
    oracleId: raw.oracle_id ?? cardFaces[0]?.oracle_id ?? null,
    name: raw.name ?? cardFaces[0]?.name ?? "",
    set: raw.set ?? null,
    collectorNumber: raw.collector_number ?? null,
    manaCost,
    manaValue: typeof raw.cmc === "number" ? raw.cmc : null,
    typeLine: raw.type_line ?? cardFaces.map((face) => face.type_line || "").join(" // "),
    oracleText: raw.oracle_text ?? cardFaces.map((face) => face.oracle_text || "").join("\n//\n"),
    producedMana: raw.produced_mana ?? [],
    imageUris: pickImageUris(raw),
    faces: cardFaces.map((face) => ({
      name: face.name ?? "",
      manaCost: face.mana_cost ?? null,
      typeLine: face.type_line ?? "",
      oracleText: face.oracle_text ?? "",
      imageUris: face.image_uris ?? null,
    })),
    scryfallUri: raw.scryfall_uri ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The front half of a `Wear // Tear` style name, with its original spelling
 * intact. Scryfall's `name` identifier is case- and punctuation-insensitive but
 * it does **not** accept the joined name of a split or double-faced card, so a
 * pasted "Wear // Tear" has to be looked up as "Wear". Verified against the
 * live API, not assumed.
 */
export function lookupName(name) {
  const [front] = String(name || "").split(/\s*\/\/\s*/);
  return front.trim() || String(name || "").trim();
}

/**
 * The identifier a deck card should be looked up by, most specific first:
 * an exact printing beats an oracle id, which beats a bare name.
 */
export function identifierFor(card) {
  if (card.scryfallId) return { id: card.scryfallId };
  if (card.oracleId) return { oracle_id: card.oracleId };
  if (card.set && card.collectorNumber) {
    return { set: String(card.set).toLowerCase(), collector_number: String(card.collectorNumber) };
  }
  return { name: lookupName(card.name) };
}

/** Stable cache key for an identifier, matching the key a hydrated card gets. */
export function cacheKeyForIdentifier(identifier) {
  if (identifier.id) return `scryfall:${identifier.id}`;
  if (identifier.oracle_id) return `oracle:${identifier.oracle_id}`;
  if (identifier.set && identifier.collector_number) {
    return `print:${identifier.set}/${identifier.collector_number}`;
  }
  return `name:${normalizeName(lookupName(identifier.name))}`;
}

/** Every key a fetched card should be filed under, so later lookups all hit. */
function cacheKeysForCard(card) {
  const keys = [`name:${normalizeName(card.name)}`];
  if (card.oracleId) keys.push(`oracle:${card.oracleId}`);
  if (card.scryfallId) keys.push(`scryfall:${card.scryfallId}`);
  if (card.set && card.collectorNumber) {
    keys.push(`print:${String(card.set).toLowerCase()}/${card.collectorNumber}`);
  }
  // Split cards are commonly listed by their front face alone.
  const [front] = normalizeName(card.name).split(" // ");
  if (front && front !== normalizeName(card.name)) keys.push(`name:${front}`);
  return keys;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class ScryfallError extends Error {
  constructor(message, { status = null, retryable = false, cause = null } = {}) {
    super(message);
    this.name = "ScryfallError";
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scryfall rejects requests whose User-Agent is an HTTP library default, with
 * HTTP 400 `generic_user_agent`. Browsers always send their own User-Agent and
 * forbid scripts from changing it, so the shipped app is unaffected — but any
 * Node script pointed at this client must pass one through `headers`.
 */
export const NODE_USER_AGENT_HINT =
  "Scryfall requires a descriptive User-Agent outside the browser; pass headers: { \"User-Agent\": ... }";

/** A cache that satisfies the interface but forgets everything. */
export function nullCache() {
  const map = new Map();
  return {
    async getMany(keys) {
      return keys.map((key) => map.get(key) ?? null);
    },
    async setMany(entries) {
      for (const [key, value] of entries) map.set(key, value);
    },
  };
}

/**
 * Creates the one client the app shares. Every request goes through a single
 * serialized queue, so concurrent hydrations cannot burst.
 */
export function createScryfallClient(options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    cache = nullCache(),
    minDelayMs = DEFAULT_MIN_DELAY_MS,
    sleep = defaultSleep,
    now = () => Date.now(),
    maxRetries = 3,
    apiBase = SCRYFALL_API,
    headers: extraHeaders = {},
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("createScryfallClient needs a fetch implementation");
  }

  let lastRequestAt = -Infinity;
  /** Tail of the request chain; every request awaits the previous one. */
  let queueTail = Promise.resolve();
  /** Concurrent identical requests share one promise. */
  const inFlight = new Map();
  /** Set when Scryfall tells us to stop; requests fail fast until it passes. */
  let blockedUntil = 0;

  const stats = { requests: 0, retries: 0, cacheHits: 0, cacheMisses: 0, notFound: 0 };

  /** Serializes a request behind the queue and the minimum delay. */
  function schedule(task) {
    const run = queueTail.then(async () => {
      const wait = Math.max(0, lastRequestAt + minDelayMs - now());
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      stats.requests += 1;
      return task();
    });
    // Keep the chain alive even when a request rejects.
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function request(path, init = {}, attempt = 0) {
    if (blockedUntil > now()) {
      throw new ScryfallError("Scryfall requests are backing off after a rate limit", {
        status: 429,
        retryable: true,
      });
    }

    const response = await schedule(() =>
      fetchImpl(`${apiBase}${path}`, {
        ...init,
        headers: {
          Accept: "application/json;q=0.9,*/*;q=0.8",
          ...extraHeaders,
          ...(init.headers || {}),
        },
      }),
    );

    if (response.ok) return response.json();

    if (response.status === 429) {
      // Respect Retry-After when present, otherwise back off exponentially.
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      blockedUntil = now() + delay;
      if (attempt >= maxRetries) {
        throw new ScryfallError("Scryfall rate limit reached", { status: 429, retryable: true });
      }
      stats.retries += 1;
      await sleep(delay);
      blockedUntil = 0;
      return request(path, init, attempt + 1);
    }

    if (response.status >= 500 && attempt < maxRetries) {
      stats.retries += 1;
      await sleep(250 * 2 ** attempt);
      return request(path, init, attempt + 1);
    }

    // Scryfall returns a JSON error object with a human-readable `details`
    // string. Passing that through is the difference between "request failed
    // (400)" and a message that says what to actually fix.
    const details = await response
      .json()
      .then((body) => body?.details ?? null)
      .catch(() => null);

    throw new ScryfallError(details || `Scryfall request failed (${response.status})`, {
      status: response.status,
      retryable: response.status >= 500,
    });
  }

  /** Deduplicates concurrent identical requests. */
  function dedupe(key, run) {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = run().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  /**
   * One `POST /cards/collection` batch. Identifiers must already be within
   * `COLLECTION_BATCH_SIZE`; `collection` below does the chunking.
   */
  async function collectionBatch(identifiers) {
    const key = `collection:${JSON.stringify(identifiers)}`;
    return dedupe(key, async () => {
      const body = await request("/cards/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers }),
      });
      const found = (body.data || []).map(normalizeScryfallCard);
      const notFound = body.not_found || [];
      stats.notFound += notFound.length;
      return { found, notFound };
    });
  }

  /**
   * Looks up any number of identifiers. Cached records are returned without a
   * request; the rest are chunked into collection batches.
   */
  async function collection(identifiers) {
    const wanted = [...identifiers];
    const keys = wanted.map(cacheKeyForIdentifier);
    const cached = await cache.getMany(keys);

    const byKey = new Map();
    const misses = [];
    for (const [index, identifier] of wanted.entries()) {
      const hit = cached[index];
      if (hit) {
        stats.cacheHits += 1;
        byKey.set(keys[index], hit);
      } else {
        stats.cacheMisses += 1;
        misses.push({ identifier, key: keys[index] });
      }
    }

    const notFound = [];
    for (let start = 0; start < misses.length; start += COLLECTION_BATCH_SIZE) {
      const chunk = misses.slice(start, start + COLLECTION_BATCH_SIZE);
      const result = await collectionBatch(chunk.map((entry) => entry.identifier));
      notFound.push(...result.notFound);

      const entries = [];
      for (const card of result.found) {
        for (const cacheKey of cacheKeysForCard(card)) entries.push([cacheKey, card]);
      }
      if (entries.length) await cache.setMany(entries);

      // Match each requested identifier back to its card. The response order
      // follows the request order for found cards, but names can normalize
      // differently (Scryfall corrects fuzzy names), so index by every key.
      const foundByKey = new Map(entries);
      for (const { identifier, key } of chunk) {
        const card =
          foundByKey.get(key) ?? foundByKey.get(`name:${normalizeName(lookupName(identifier.name || ""))}`);
        if (card) byKey.set(key, card);
      }
    }

    return {
      cards: wanted.map((identifier, index) => byKey.get(keys[index]) ?? null),
      notFound,
      stats: { ...stats },
    };
  }

  /** Convenience wrapper for a list of names. */
  async function cardsByNames(names) {
    return collection(names.map((name) => ({ name })));
  }

  /** Single-card exact-name lookup, used by the tag editor and search. */
  async function cardByName(name) {
    const [card] = (await cardsByNames([name])).cards;
    return card ?? null;
  }

  return { collection, cardsByNames, cardByName, stats: () => ({ ...stats }), normalizeScryfallCard };
}

/* ------------------------------------------------------------------ */
/* Deck hydration                                                      */
/* ------------------------------------------------------------------ */

/**
 * Merges a Scryfall record into a DeckCard without clobbering user data.
 * Imported tags, user tags, quantity, and zone all survive hydration.
 */
export function applyScryfallCard(deckCard, scryfallCard) {
  return {
    ...deckCard,
    // Prefer Scryfall's spelling; a pasted list may be lowercase or misspelled.
    name: scryfallCard.name || deckCard.name,
    key: scryfallCard.oracleId ? `oracle:${scryfallCard.oracleId}` : deckCard.key,
    scryfallId: scryfallCard.scryfallId,
    oracleId: scryfallCard.oracleId,
    set: scryfallCard.set ?? deckCard.set,
    collectorNumber: scryfallCard.collectorNumber ?? deckCard.collectorNumber,
    manaCost: scryfallCard.manaCost,
    manaValue: scryfallCard.manaValue,
    typeLine: scryfallCard.typeLine,
    oracleText: scryfallCard.oracleText,
    producedMana: scryfallCard.producedMana,
    imageUris: scryfallCard.imageUris,
    faces: scryfallCard.faces,
    scryfallUri: scryfallCard.scryfallUri,
    resolved: true,
  };
}

/**
 * Hydrates every card in a deck. Returns a new deck plus the cards Scryfall
 * could not resolve — those keep their imported name and quantity, because
 * section 19.3 is explicit that unresolved cards must never silently vanish
 * from the deck size.
 *
 * Cards are re-keyed by oracle id during hydration, which can reveal that two
 * differently-spelled entries were the same card; those are merged, and their
 * quantities summed, exactly as `createDeck` would.
 */
export async function hydrateDeck(deck, client, options = {}) {
  const { onProgress = null } = options;
  const identifiers = deck.cards.map(identifierFor);

  let result;
  try {
    result = await client.collection(identifiers);
  } catch (error) {
    // Degraded mode (section 19.2): the deck stays usable, just unresolved.
    return {
      deck,
      unresolved: deck.cards.filter((card) => !card.resolved),
      error,
      stats: client.stats ? client.stats() : null,
    };
  }

  const merged = new Map();
  const unresolved = [];

  for (const [index, deckCard] of deck.cards.entries()) {
    const scryfallCard = result.cards[index];
    const next = scryfallCard ? applyScryfallCard(deckCard, scryfallCard) : deckCard;
    if (!scryfallCard) unresolved.push(deckCard);

    const mergeKey = `${next.zone}:${next.key}`;
    const existing = merged.get(mergeKey);
    if (existing) existing.quantity += next.quantity;
    else merged.set(mergeKey, next);

    if (onProgress) onProgress({ done: index + 1, total: deck.cards.length, card: next });
  }

  const cards = [...merged.values()];
  const hydrated = {
    ...deck,
    cards,
    // Commander keys may have changed when cards were re-keyed by oracle id.
    commanders: cards.filter((card) => card.zone === ZONES.COMMANDER).map((card) => card.key),
    hydratedAt: new Date().toISOString(),
  };

  return { deck: hydrated, unresolved, error: null, stats: client.stats ? client.stats() : null };
}
