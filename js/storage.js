/**
 * Browser persistence.
 *
 * Split by the rule in plan section 8.4:
 *
 *   IndexedDB  — Scryfall card records and imported deck snapshots (large,
 *                asynchronous, many rows).
 *   localStorage — preferences, tag overrides, recent decks (small, synchronous).
 *
 * Every backing store degrades to memory when unavailable, so private-mode
 * browsers and `node --test` both work without branching at the call site.
 */

const DB_NAME = "mtg-mulligan";
const DB_VERSION = 1;
const STORE_CARDS = "cards";
const STORE_DECKS = "decks";

const LS_PREFIX = "mtg-mulligan:";
const LS_SETTINGS = `${LS_PREFIX}settings`;
const LS_RECENT = `${LS_PREFIX}recent`;
const LS_OVERRIDES = `${LS_PREFIX}overrides`;

/** Card records are stable; a month is a good balance against Oracle updates. */
export const CARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Key-value backends                                                  */
/* ------------------------------------------------------------------ */

/** In-memory fallback with the same async surface as the IndexedDB store. */
export function memoryStore() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  return {
    kind: "memory",
    async get(store, key) {
      return table(store).get(key) ?? null;
    },
    async getMany(store, keys) {
      const rows = table(store);
      return keys.map((key) => rows.get(key) ?? null);
    },
    async put(store, key, value) {
      table(store).set(key, value);
    },
    async putMany(store, entries) {
      const rows = table(store);
      for (const [key, value] of entries) rows.set(key, value);
    },
    async remove(store, key) {
      table(store).delete(key);
    },
    async all(store) {
      return [...table(store).values()];
    },
    async clear(store) {
      table(store).clear();
    },
  };
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Opens the IndexedDB database, or resolves null when it is unavailable. */
export async function openDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return null;
  try {
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_CARDS)) db.createObjectStore(STORE_CARDS);
        if (!db.objectStoreNames.contains(STORE_DECKS)) db.createObjectStore(STORE_DECKS);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
    });
  } catch {
    return null;
  }
}

function indexedDbStore(db) {
  const run = (store, mode, work) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const result = work(tx.objectStore(store));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

  return {
    kind: "indexeddb",
    async get(store, key) {
      return (await run(store, "readonly", (os) => promisify(os.get(key)))) ?? null;
    },
    async getMany(store, keys) {
      const pending = await run(store, "readonly", (os) => keys.map((key) => promisify(os.get(key))));
      return (await Promise.all(pending)).map((value) => value ?? null);
    },
    async put(store, key, value) {
      await run(store, "readwrite", (os) => os.put(value, key));
    },
    async putMany(store, entries) {
      await run(store, "readwrite", (os) => {
        for (const [key, value] of entries) os.put(value, key);
      });
    },
    async remove(store, key) {
      await run(store, "readwrite", (os) => os.delete(key));
    },
    async all(store) {
      return run(store, "readonly", (os) => promisify(os.getAll()));
    },
    async clear(store) {
      await run(store, "readwrite", (os) => os.clear());
    },
  };
}

/** The app's single store handle: IndexedDB when possible, memory otherwise. */
export async function createStore(options = {}) {
  const db = options.db !== undefined ? options.db : await openDatabase(options.indexedDB);
  return db ? indexedDbStore(db) : memoryStore();
}

/* ------------------------------------------------------------------ */
/* Card cache (the shape scryfall.js expects)                          */
/* ------------------------------------------------------------------ */

/**
 * Wraps a store as the `{ getMany, setMany }` cache the Scryfall client takes.
 * Entries carry their own timestamp so expiry needs no separate index.
 */
export function createCardCache(store, options = {}) {
  const { ttlMs = CARD_TTL_MS, now = () => Date.now() } = options;
  return {
    async getMany(keys) {
      let rows;
      try {
        rows = await store.getMany(STORE_CARDS, keys);
      } catch {
        return keys.map(() => null);
      }
      return rows.map((row) => {
        if (!row || typeof row !== "object") return null;
        if (ttlMs > 0 && now() - (row.cachedAt || 0) > ttlMs) return null;
        return row.card ?? null;
      });
    },
    async setMany(entries) {
      const cachedAt = now();
      try {
        await store.putMany(
          STORE_CARDS,
          entries.map(([key, card]) => [key, { card, cachedAt }]),
        );
      } catch {
        // A full or unavailable quota must never break hydration.
      }
    },
    async clear() {
      await store.clear(STORE_CARDS);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Deck snapshots                                                      */
/* ------------------------------------------------------------------ */

export async function saveDeck(store, deck) {
  await store.put(STORE_DECKS, deck.id, { deck, savedAt: new Date().toISOString() });
  rememberRecentDeck(deck);
  return deck;
}

export async function loadDeck(store, deckId) {
  const row = await store.get(STORE_DECKS, deckId);
  return row?.deck ?? null;
}

export async function listDecks(store) {
  const rows = await store.all(STORE_DECKS);
  return rows
    .filter((row) => row?.deck)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .map((row) => ({
      id: row.deck.id,
      name: row.deck.name,
      format: row.deck.format,
      savedAt: row.savedAt,
      cardCount: row.deck.cards.reduce((total, card) => total + card.quantity, 0),
    }));
}

export async function deleteDeck(store, deckId) {
  await store.remove(STORE_DECKS, deckId);
  writeJson(LS_RECENT, readJson(LS_RECENT, []).filter((entry) => entry.id !== deckId));
}

/* ------------------------------------------------------------------ */
/* localStorage: settings, recents, tag overrides                      */
/* ------------------------------------------------------------------ */

function localStorageOrNull() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    // Safari in private mode throws on write rather than on access.
    const probe = `${LS_PREFIX}probe`;
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function readJson(key, fallback) {
  const ls = localStorageOrNull();
  if (!ls) return fallback;
  try {
    const raw = ls.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  const ls = localStorageOrNull();
  if (!ls) return false;
  try {
    ls.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  freeMulligans: 0,
  onPlay: true,
  drawOnTurnOne: false,
  horizons: [1, 2, 3],
  landThreshold: 0.7,
  showImages: true,
});

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(LS_SETTINGS, {}) };
}

export function saveSettings(settings) {
  return writeJson(LS_SETTINGS, { ...loadSettings(), ...settings });
}

export function recentDecks() {
  return readJson(LS_RECENT, []);
}

export function rememberRecentDeck(deck) {
  const entry = { id: deck.id, name: deck.name, openedAt: new Date().toISOString() };
  const rest = recentDecks().filter((row) => row.id !== deck.id);
  return writeJson(LS_RECENT, [entry, ...rest].slice(0, 10));
}

/**
 * Tag overrides live apart from the deck snapshot on purpose: re-importing a
 * deck from its source replaces the cards but must preserve hours of tagging
 * (section 18.3). Overrides are keyed by deck id, then by card key.
 */
export function loadOverrides(deckId) {
  return readJson(LS_OVERRIDES, {})[deckId] ?? {};
}

export function saveOverrides(deckId, overrides) {
  const all = readJson(LS_OVERRIDES, {});
  all[deckId] = overrides;
  return writeJson(LS_OVERRIDES, all);
}

/** Applies stored `{ userTags, removedTags }` back onto a freshly built deck. */
export function applyOverrides(deck, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return deck;
  return {
    ...deck,
    cards: deck.cards.map((card) => {
      const override = overrides[card.key];
      if (!override) return card;
      return {
        ...card,
        userTags: override.userTags ?? card.userTags,
        removedTags: override.removedTags ?? card.removedTags,
      };
    }),
  };
}

/** Extracts the overrides worth persisting from a live deck. */
export function collectOverrides(deck) {
  const overrides = {};
  for (const card of deck.cards) {
    const userTags = card.userTags ?? [];
    const removedTags = card.removedTags ?? [];
    if (userTags.length || removedTags.length) overrides[card.key] = { userTags, removedTags };
  }
  return overrides;
}

/* ------------------------------------------------------------------ */
/* Portable export / import (section 18.2)                             */
/* ------------------------------------------------------------------ */

export const PROFILE_VERSION = 1;

export function exportProfile({ deck, settings = loadSettings(), groups = {} }) {
  return {
    version: PROFILE_VERSION,
    exportedAt: new Date().toISOString(),
    deck,
    overrides: deck ? collectOverrides(deck) : {},
    groups,
    settings,
  };
}

export function importProfile(json) {
  const profile = typeof json === "string" ? JSON.parse(json) : json;
  if (!profile || typeof profile !== "object") throw new Error("That file is not an app profile");
  if (profile.version !== PROFILE_VERSION) {
    throw new Error(`Unsupported profile version ${profile.version}`);
  }
  const deck = profile.deck ? applyOverrides(profile.deck, profile.overrides) : null;
  return { deck, settings: { ...DEFAULT_SETTINGS, ...(profile.settings || {}) }, groups: profile.groups || {} };
}

export const STORES = Object.freeze({ CARDS: STORE_CARDS, DECKS: STORE_DECKS });
