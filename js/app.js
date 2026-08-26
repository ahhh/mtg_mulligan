/**
 * Application shell.
 *
 * One store, one dispatch, one render (plan section 17.1). Nothing derived is
 * ever stored: land probability, tag counts, and risk levels are all recomputed
 * from the deck and the game state on every render, so they can never go stale.
 *
 * This module is the only place that knows about screens and wiring. It does no
 * probability math and no parsing of its own.
 */

import { ZONES } from "./deck-model.js";
import { importText, textImporter } from "./importers/text.js";
import { archidektImporter } from "./importers/archidekt.js";
import { createScryfallClient, hydrateDeck } from "./scryfall.js";
import { tagTarget, normalizeTag, getEffectiveTags } from "./tags.js";
import {
  MODES,
  PHASES,
  assignToHand,
  assignToKnownBottom,
  assignToKnownOutside,
  bottomCard,
  canDraw,
  createGameState,
  dealOpeningHand,
  drawCard,
  keepHand,
  mulligan,
  resetGame,
  returnToLibrary,
  unbottomCard,
} from "./state.js";
import {
  applyOverrides,
  collectOverrides,
  createCardCache,
  createStore,
  exportProfile,
  importProfile,
  listDecks,
  loadDeck,
  loadOverrides,
  loadSettings,
  saveDeck,
  saveOverrides,
  saveSettings,
} from "./storage.js";
import { $, el, replace, formatCount } from "./ui/dom.js";
import { renderDeckSummary, renderImport, renderTagEditor, renderTargetPicker } from "./ui/deck.js";
import { renderAnalyzeControls, renderDrawLog, renderHand } from "./ui/hand.js";
import { renderHandCheck, renderOddsTable, renderTurnPlanner } from "./ui/odds.js";
import { hideTooltip } from "./ui/tooltip.js";

const SAMPLE_DECK_URL = "./fixtures/sample-deck.txt";

/** Categories worth showing by default when the deck actually has them. */
const DEFAULT_CATEGORIES = ["Land", "Creature", "Removal", "Ramp", "Card Draw"];

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const state = {
  deck: null,
  game: null,
  settings: loadSettings(),
  ui: {
    screen: "landing",
    selectedTags: new Set(),
    selectedBottom: new Set(),
    planner: { targetId: null, turn: 3, minimumHits: 1 },
    tagQuery: "",
    analyzeQuery: "",
    hydration: { pending: false, message: "", error: null },
    message: null,
    recents: [],
  },
};

let store = null;
let scryfall = null;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function setUi(patch) {
  Object.assign(state.ui, patch);
  render();
}

/** Every user action funnels through here, so every action re-renders once. */
async function dispatch(action) {
  try {
    await handle(action);
  } catch (error) {
    console.error(action.type, error);
    setUi({ message: { kind: "error", text: error.message } });
  }
}

async function handle(action) {
  switch (action.type) {
    case "DECK_IMPORTED":
      return openDeck(action.deck, { hydrate: true });

    case "DECK_OPENED":
      return openDeck(action.deck, { hydrate: false });

    case "DEAL_OPENING_HAND":
      requireDeck();
      state.game = dealOpeningHand(freshGame());
      return setUi({ screen: "play", selectedBottom: new Set(), message: null });

    case "MULLIGAN":
      state.game = mulligan(state.game);
      return setUi({ selectedBottom: new Set() });

    case "KEEP":
      state.game = keepHand(state.game);
      return render();

    case "TOGGLE_BOTTOM": {
      // Selection is staged in the UI, then committed on Confirm — bottoming is
      // a single decision about a set of cards, not seven separate ones.
      const selected = new Set(state.ui.selectedBottom);
      if (selected.has(action.instanceId)) selected.delete(action.instanceId);
      else if (selected.size < state.game.cardsToBottom) selected.add(action.instanceId);
      return setUi({ selectedBottom: selected });
    }

    case "CONFIRM_BOTTOM": {
      let next = state.game;
      for (const instanceId of state.ui.selectedBottom) next = bottomCard(next, instanceId);
      state.game = next;
      return setUi({ selectedBottom: new Set() });
    }

    case "UNBOTTOM":
      state.game = unbottomCard(state.game, action.instanceId);
      return render();

    case "DRAW_CARD":
      state.game = drawCard(state.game);
      return render();

    case "RESET":
      state.game = resetGame(state.game);
      return setUi({ selectedBottom: new Set() });

    case "SET_MODE":
      requireDeck();
      state.game = createGameState(state.deck, { ...gameOptions(), mode: action.mode });
      return setUi({
        screen: "play",
        selectedBottom: new Set(),
        analyzeQuery: "",
        message: null,
      });

    case "ASSIGN": {
      const { zone, key } = action;
      if (zone === "hand") state.game = assignToHand(state.game, key);
      else if (zone === "bottom") state.game = assignToKnownBottom(state.game, key);
      else state.game = assignToKnownOutside(state.game, key);
      return setUi({ analyzeQuery: "" });
    }

    case "RETURN_TO_LIBRARY":
      state.game = returnToLibrary(state.game, action.instanceId);
      return render();

    case "TAG_ADD":
      return updateCard(action.key, (card) => ({
        ...card,
        userTags: [...new Set([...(card.userTags || []), normalizeTag(action.tag)])],
        removedTags: (card.removedTags || []).filter(
          (tag) => tag.toLowerCase() !== normalizeTag(action.tag).toLowerCase(),
        ),
      }));

    case "TAG_REMOVE":
      return updateCard(action.key, (card) => ({
        ...card,
        userTags: (card.userTags || []).filter(
          (tag) => tag.toLowerCase() !== normalizeTag(action.tag).toLowerCase(),
        ),
        removedTags: [...new Set([...(card.removedTags || []), normalizeTag(action.tag)])],
      }));

    case "TOGGLE_CATEGORY": {
      const selected = new Set(state.ui.selectedTags);
      const key = action.tag.toLowerCase();
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      return setUi({ selectedTags: selected });
    }

    case "SETTINGS": {
      const settings = { ...state.settings, ...action.patch };
      saveSettings(settings);
      // Free mulligans and play/draw change the rules mid-game; the engine
      // reads them from game state, so push them through.
      if (state.game) {
        state.game = {
          ...state.game,
          freeMulligans: settings.freeMulligans,
          onPlay: settings.onPlay,
          drawOnTurnOne: settings.drawOnTurnOne,
        };
      }
      return setState({ settings });
    }

    case "SCREEN":
      hideTooltip({ immediate: true });
      return setUi({ screen: action.screen, message: null });

    case "EXPORT_PROFILE":
      return exportProfileFile();

    case "IMPORT_PROFILE":
      return importProfileFile(action.file);

    default:
      throw new Error(`Unknown action ${action.type}`);
  }
}

function requireDeck() {
  if (!state.deck) throw new Error("Load a deck first");
}

function gameOptions() {
  return {
    freeMulligans: state.settings.freeMulligans,
    onPlay: state.settings.onPlay,
    drawOnTurnOne: state.settings.drawOnTurnOne,
  };
}

/** A game state rebuilt from the current deck, picking up any tag edits. */
function freshGame() {
  return createGameState(state.deck, { ...gameOptions(), mode: MODES.SIMULATE });
}

/**
 * Tag edits rebuild the deck and the game state. That looks heavy, but a game
 * state is a few hundred object references and rebuilding it is the only way to
 * guarantee no card instance still points at a stale tag list.
 */
async function updateCard(key, updater) {
  const deck = {
    ...state.deck,
    cards: state.deck.cards.map((card) => (card.key === key ? updater(card) : card)),
  };
  state.deck = deck;
  saveOverrides(deck.id, collectOverrides(deck));
  await saveDeck(store, deck);
  if (state.game) state.game = rebindGame(deck, state.game);
  render();
}

/**
 * Re-points a live game state at a rebuilt deck without disturbing any zone.
 * Instance ids are stable (`key#copy`), so every card stays exactly where the
 * player put it — only the DeckCard reference behind it is refreshed.
 */
function rebindGame(deck, game) {
  const byKey = new Map(deck.cards.map((card) => [card.key, card]));
  const rebind = (instances) =>
    instances.map((instance) => ({ ...instance, card: byKey.get(instance.key) ?? instance.card }));
  return {
    ...game,
    hand: rebind(game.hand),
    randomLibrary: rebind(game.randomLibrary),
    knownBottom: rebind(game.knownBottom),
    knownOutsideLibrary: rebind(game.knownOutsideLibrary),
    drawn: rebind(game.drawn),
    allInstances: rebind(game.allInstances),
  };
}

/* ------------------------------------------------------------------ */
/* Deck lifecycle                                                      */
/* ------------------------------------------------------------------ */

async function openDeck(deck, { hydrate }) {
  const withOverrides = applyOverrides(deck, loadOverrides(deck.id));
  state.deck = withOverrides;
  state.game = createGameState(withOverrides, gameOptions());
  state.ui.selectedTags = defaultCategories(withOverrides);
  state.ui.planner.targetId = null;
  setUi({ screen: "deck", message: null });

  await saveDeck(store, withOverrides);
  state.ui.recents = await listDecks(store);

  if (hydrate) await hydrate_(withOverrides);
  render();
}

/** Fills in Scryfall metadata, then re-applies tag overrides and re-saves. */
async function hydrate_(deck) {
  setUi({
    hydration: {
      pending: true,
      message: `Resolving ${formatCount(deck.cards.length, "card")} against Scryfall…`,
      error: null,
    },
  });

  const { deck: hydrated, unresolved, error } = await hydrateDeck(deck, scryfall);

  // Hydration re-keys cards by oracle id, so overrides saved under the old
  // name-based key are re-applied here rather than silently lost.
  const withOverrides = applyOverrides(hydrated, loadOverrides(deck.id));
  state.deck = withOverrides;
  state.game = state.game ? rebindGame(withOverrides, createGameState(withOverrides, gameOptions())) : null;
  state.ui.selectedTags = defaultCategories(withOverrides);
  await saveDeck(store, withOverrides);
  saveOverrides(withOverrides.id, collectOverrides(withOverrides));

  setUi({
    hydration: {
      pending: false,
      message: unresolved.length
        ? `${formatCount(unresolved.length, "card")} could not be resolved.`
        : "All cards resolved.",
      error,
    },
  });
}

function defaultCategories(deck) {
  const present = new Set();
  for (const card of deck.cards) {
    if (card.zone !== ZONES.MAIN) continue;
    for (const tag of getEffectiveTags(card)) present.add(tag);
  }
  const chosen = DEFAULT_CATEGORIES.filter((tag) => present.has(tag));
  return new Set((chosen.length ? chosen : [...present].slice(0, 4)).map((tag) => tag.toLowerCase()));
}

function currentTargets() {
  if (!state.deck) return [];
  const wanted = state.ui.selectedTags;
  const seen = new Map();
  for (const card of state.deck.cards) {
    if (card.zone !== ZONES.MAIN) continue;
    for (const tag of getEffectiveTags(card)) {
      if (wanted.has(tag.toLowerCase()) && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
    }
  }
  return [...seen.values()].map((tag) => tagTarget(tag));
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

function exportProfileFile() {
  requireDeck();
  const profile = exportProfile({ deck: state.deck, settings: state.settings });
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", { href: url, download: `${state.deck.name.replace(/[^\w-]+/g, "-")}.json` });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setUi({ message: { kind: "ok", text: "Profile exported." } });
}

async function importProfileFile(file) {
  const { deck, settings } = importProfile(await file.text());
  if (!deck) throw new Error("That profile has no deck in it");
  saveSettings(settings);
  state.settings = settings;
  await openDeck(deck, { hydrate: false });
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

/** Screens that cannot render anything without a deck loaded. */
const DECK_SCREENS = new Set(["deck", "tags", "play"]);

function render() {
  // The nav is always visible, so a click can ask for a screen that has no data
  // behind it yet. Fall back rather than rendering against a null deck.
  if (DECK_SCREENS.has(state.ui.screen) && !state.deck) state.ui.screen = "landing";
  if (state.ui.screen === "play" && !state.game) state.ui.screen = "deck";

  const { screen } = state.ui;
  for (const section of document.querySelectorAll("[data-screen]")) {
    section.hidden = section.dataset.screen !== screen;
  }
  renderMessage();

  if (screen === "landing") renderLanding();
  if (screen === "deck") renderDeck();
  if (screen === "tags") renderTags();
  if (screen === "play") renderPlay();
}

function renderMessage() {
  const container = $("#message");
  if (!state.ui.message) {
    container.hidden = true;
    replace(container, []);
    return;
  }
  container.hidden = false;
  container.className = `message message--${state.ui.message.kind}`;
  replace(container, [
    el("span", { text: state.ui.message.text }),
    el("button", {
      type: "button",
      class: "ghost",
      text: "Dismiss",
      onclick: () => setUi({ message: null }),
    }),
  ]);
}

function renderLanding() {
  renderImport($("#import-panel"), {
    recents: state.ui.recents,
    onImportText: async (text, name) => {
      const { deck, problems } = importText(text, { name: name || undefined });
      if (problems.length) {
        setUi({
          message: {
            kind: "warn",
            text: `${formatCount(problems.length, "line")} could not be read: ${problems
              .slice(0, 3)
              .map((problem) => `line ${problem.line}`)
              .join(", ")}`,
          },
        });
      }
      await dispatch({ type: "DECK_IMPORTED", deck });
    },
    onImportUrl: async (url) => {
      if (!archidektImporter.canHandle(url)) {
        throw new Error("That is not an Archidekt deck link");
      }
      setUi({ message: { kind: "info", text: "Importing from Archidekt\u2026" } });
      const { deck, problems } = await archidektImporter.import(url);
      if (problems.length) {
        setUi({
          message: {
            kind: "warn",
            text: `${formatCount(problems.length, "card")} in that deck could not be read and were skipped`,
          },
        });
      }
      await dispatch({ type: "DECK_IMPORTED", deck });
    },
    onLoadSample: async () => {
      const response = await fetch(SAMPLE_DECK_URL);
      if (!response.ok) throw new Error("Could not load the sample deck");
      const { deck } = await textImporter.import(await response.text(), { name: "Sample Commander deck" });
      await dispatch({ type: "DECK_IMPORTED", deck });
    },
    onOpenRecent: async (deckId) => {
      const deck = await loadDeck(store, deckId);
      if (!deck) throw new Error("That deck is no longer saved");
      await dispatch({ type: "DECK_OPENED", deck });
    },
    onImportProfile: (file) => dispatch({ type: "IMPORT_PROFILE", file }),
  });
}

function renderDeck() {
  renderDeckSummary($("#deck-panel"), {
    deck: state.deck,
    hydration: state.ui.hydration,
    settings: state.settings,
    handlers: {
      onDeal: () => dispatch({ type: "DEAL_OPENING_HAND" }),
      onAnalyze: () => dispatch({ type: "SET_MODE", mode: MODES.ANALYZE }),
      onExport: () => dispatch({ type: "EXPORT_PROFILE" }),
      onNewDeck: () => dispatch({ type: "SCREEN", screen: "landing" }),
      onRetryHydrate: () => hydrate_(state.deck),
      onSettings: (patch) => dispatch({ type: "SETTINGS", patch }),
    },
  });
}

function renderTags() {
  renderTagEditor($("#tags-panel"), {
    deck: state.deck,
    query: state.ui.tagQuery,
    showImages: state.settings.showImages,
    onQuery: (value) => setUi({ tagQuery: value }),
    onAddTag: (key, tag) => dispatch({ type: "TAG_ADD", key, tag }),
    onRemoveTag: (key, tag) => dispatch({ type: "TAG_REMOVE", key, tag }),
  });
}

function renderPlay() {
  const game = state.game;
  const analyzing = game.mode === MODES.ANALYZE;
  const targets = currentTargets();
  const landTarget = tagTarget("Land");

  renderHand($("#hand-panel"), {
    game,
    selectedIds: state.ui.selectedBottom,
    showImages: state.settings.showImages,
    onSelect: (instance) =>
      game.phase === PHASES.KEEP_PENDING_BOTTOM
        ? dispatch({ type: "TOGGLE_BOTTOM", instanceId: instance.id })
        : dispatch({ type: "RETURN_TO_LIBRARY", instanceId: instance.id }),
  });

  renderControls(game, analyzing);

  const analyzePanel = $("#analyze-panel");
  analyzePanel.hidden = !analyzing;
  if (analyzing) {
    renderAnalyzeControls(analyzePanel, {
      deck: state.deck,
      game,
      query: state.ui.analyzeQuery,
      onQuery: (value) => setUi({ analyzeQuery: value }),
      onAssign: (zone, key) => dispatch({ type: "ASSIGN", zone, key }),
    });
  }

  renderTargetPicker($("#category-picker"), {
    deck: state.deck,
    selectedTags: state.ui.selectedTags,
    onToggle: (tag) => dispatch({ type: "TOGGLE_CATEGORY", tag }),
  });

  renderOddsTable($("#odds-panel"), {
    game,
    targets,
    horizons: state.settings.horizons,
    unresolvedCount: state.deck.cards.filter((card) => !card.resolved).length,
  });
  renderHandCheck($("#hand-check"), { game, settings: state.settings, landTarget });
  renderTurnPlanner($("#planner-panel"), {
    game,
    settings: state.settings,
    targets: targets.length ? targets : [landTarget],
    selection: {
      ...state.ui.planner,
      targetId: state.ui.planner.targetId ?? targets[0]?.id ?? landTarget.id,
    },
    onChange: (planner) => setUi({ planner }),
  });
  renderDrawLog($("#draw-log"), { game, showImages: state.settings.showImages });
}

function renderControls(game, analyzing) {
  const buttons = [];
  const pendingBottom = game.phase === PHASES.KEEP_PENDING_BOTTOM;

  if (!analyzing) {
    if (game.phase === PHASES.UNDEALT) {
      buttons.push(button("Deal opening hand", "primary", () => dispatch({ type: "DEAL_OPENING_HAND" })));
    }
    if (game.phase === PHASES.DEALT) {
      buttons.push(button("Keep", "primary", () => dispatch({ type: "KEEP" })));
      buttons.push(button("Mulligan", "secondary", () => dispatch({ type: "MULLIGAN" })));
    }
    if (pendingBottom) {
      const chosen = state.ui.selectedBottom.size;
      buttons.push(
        button(
          `Confirm keep (${chosen}/${game.cardsToBottom})`,
          "primary",
          () => dispatch({ type: "CONFIRM_BOTTOM" }),
          chosen !== game.cardsToBottom,
        ),
      );
    }
    if (canDraw(game)) {
      buttons.push(button("Draw next card", "primary", () => dispatch({ type: "DRAW_CARD" })));
    }
    buttons.push(button("Reset", "ghost", () => dispatch({ type: "RESET" })));
  } else {
    buttons.push(
      button("Switch to simulation", "secondary", () => dispatch({ type: "SET_MODE", mode: MODES.SIMULATE })),
    );
    buttons.push(button("Clear known cards", "ghost", () => dispatch({ type: "SET_MODE", mode: MODES.ANALYZE })));
  }

  buttons.push(button("Edit tags", "ghost", () => dispatch({ type: "SCREEN", screen: "tags" })));
  buttons.push(button("Deck", "ghost", () => dispatch({ type: "SCREEN", screen: "deck" })));

  const status = el("p", { class: "muted", role: "status" }, [
    `Mode: ${analyzing ? "real hand" : "simulation"} · phase: ${game.phase.replace(/_/g, " ")}`,
    game.mulligansTaken ? ` · ${formatCount(game.mulligansTaken, "mulligan")}` : "",
  ]);

  replace($("#controls"), [el("div", { class: "row wrap" }, buttons), status]);
}

function button(label, kind, onclick, disabled = false) {
  return el("button", { type: "button", class: kind, text: label, onclick, disabled });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

export async function start() {
  store = await createStore();
  scryfall = createScryfallClient({ cache: createCardCache(store) });
  state.ui.recents = await listDecks(store);

  for (const node of document.querySelectorAll("[data-goto]")) {
    node.addEventListener("click", () => dispatch({ type: "SCREEN", screen: node.dataset.goto }));
  }

  render();
  return { dispatch, state };
}

if (typeof document !== "undefined") {
  const boot = () => {
    start().catch((error) => {
      console.error(error);
      const target = document.querySelector("#message");
      if (target) {
        target.hidden = false;
        target.className = "message message--error";
        target.textContent = `Could not start: ${error.message}`;
      }
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
