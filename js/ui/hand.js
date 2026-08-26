/**
 * The hand row and its card elements (plan sections 4.2 and 4.3).
 *
 * Cards are buttons so they are keyboard-focusable and expose the tooltip on
 * focus, not hover alone. What clicking a card does depends on the phase: while
 * bottoming after a London mulligan it toggles selection, otherwise it is a
 * pure tooltip trigger.
 */

import { el, replace, formatCount, manaPips } from "./dom.js";
import { attachTooltip } from "./tooltip.js";
import { PHASES } from "../state.js";
import { getEffectiveTags } from "../tags.js";

/** One card in a row. `instance` is a CardInstance from the game state. */
export function cardElement(instance, { selected = false, onSelect = null, showImages = true } = {}) {
  const { card } = instance;
  const tags = [...getEffectiveTags(card)];

  const node = el(
    "button",
    {
      type: "button",
      class: `card${selected ? " card--selected" : ""}${card.resolved ? "" : " card--unresolved"}`,
      dataset: { instanceId: instance.id, cardKey: card.key },
      "aria-pressed": onSelect ? String(selected) : null,
      // Screen readers get the whole card, not just its name.
      "aria-label": [
        card.name,
        card.manaCost || "no mana cost",
        card.typeLine || "type unknown",
        tags.length ? `tags: ${tags.join(", ")}` : "no tags",
        selected ? "selected to bottom" : null,
      ]
        .filter(Boolean)
        .join(". "),
    },
    [
      el("span", { class: "card__name", text: card.name }),
      el(
        "span",
        { class: "card__cost", "aria-hidden": "true" },
        manaPips(card.manaCost).map((pip) => el("span", { class: "pip", text: pip })),
      ),
      el("span", { class: "card__type", text: card.typeLine || "unresolved", "aria-hidden": "true" }),
      el(
        "span",
        { class: "card__tags", "aria-hidden": "true" },
        tags.slice(0, 3).map((tag) => el("span", { class: "chip", text: tag })),
      ),
    ],
  );

  attachTooltip(node, card, { showImages });
  if (onSelect) node.addEventListener("click", () => onSelect(instance));
  return node;
}

/** A row of cards; `emptyText` shows when there are none. */
export function cardRow(instances, options = {}) {
  const { emptyText = "No cards.", ...cardOptions } = options;
  if (instances.length === 0) {
    return el("p", { class: "muted", text: emptyText });
  }
  return el(
    "ul",
    { class: "card-row" },
    instances.map((instance) =>
      el("li", {}, [
        cardElement(instance, {
          ...cardOptions,
          selected: cardOptions.selectedIds?.has(instance.id) ?? false,
        }),
      ]),
    ),
  );
}

/**
 * Renders the hand panel: the cards, the bottoming prompt when a keep is
 * pending, and the zone counts that make the known-bottom distinction visible.
 */
export function renderHand(container, { game, selectedIds, onSelect, showImages }) {
  const pendingBottom = game.phase === PHASES.KEEP_PENDING_BOTTOM;

  const heading = el("div", { class: "panel__head" }, [
    el("h2", { text: game.phase === PHASES.UNDEALT ? "No hand yet" : "Hand" }),
    el("span", {
      class: "muted",
      text: `${formatCount(game.hand.length, "card")} in hand · ${game.randomLibrary.length} unknown in library${
        game.knownBottom.length ? ` · ${formatCount(game.knownBottom.length, "known bottom card")}` : ""
      }`,
    }),
  ]);

  const prompt = pendingBottom
    ? el("p", { class: "prompt", role: "status" }, [
        el("strong", {
          text: `You mulliganed ${formatCount(game.mulligansTaken, "time")}. `,
        }),
        `Choose ${formatCount(game.cardsToBottom, "card")} to put on the bottom.`,
      ])
    : null;

  const bottomRow = game.knownBottom.length
    ? el("div", { class: "subpanel" }, [
        el("h3", { text: "Known bottom" }),
        el("p", {
          class: "muted",
          text: "These are not random library cards. Until the draw horizon reaches them their draw probability is exactly 0.",
        }),
        cardRow(game.knownBottom, { showImages }),
      ])
    : null;

  const outside = game.knownOutsideLibrary.length
    ? el("div", { class: "subpanel" }, [
        el("h3", { text: "Known outside the library" }),
        cardRow(game.knownOutsideLibrary, { showImages }),
      ])
    : null;

  replace(container, [
    heading,
    prompt,
    cardRow(game.hand, {
      selectedIds,
      onSelect: pendingBottom || game.mode === "analyze" ? onSelect : null,
      showImages,
      emptyText: "Deal an opening hand to get started.",
    }),
    bottomRow,
    outside,
  ]);
}

/** The chronological draw log under the draw tracker (section 4.4). */
export function renderDrawLog(container, { game, showImages }) {
  if (game.drawn.length === 0) {
    replace(container, el("p", { class: "muted", text: "Nothing drawn yet." }));
    return;
  }
  replace(container, [
    el("h3", { text: `Drawn (${game.drawn.length})` }),
    cardRow(game.drawn, { showImages }),
  ]);
}

/**
 * Real-hand analysis controls (plan section 4.5).
 *
 * The user is sitting at a table with a physical deck. No shuffle happens: they
 * declare which cards they can see, and every declaration moves one copy out of
 * the unknown library into a known zone, which is exactly what the exact math
 * needs.
 */
export function renderAnalyzeControls(container, { deck, query, onQuery, onAssign, game }) {
  const needle = query.trim().toLowerCase();

  // Only offer cards that still have an unaccounted copy in the random library.
  const remaining = new Map();
  for (const instance of game.randomLibrary) {
    remaining.set(instance.key, (remaining.get(instance.key) || 0) + 1);
  }

  const matches = needle
    ? deck.cards
        .filter((card) => remaining.get(card.key) > 0 && card.name.toLowerCase().includes(needle))
        .slice(0, 8)
    : [];

  const search = el("input", {
    id: "analyze-search",
    type: "search",
    value: query,
    placeholder: "Search a card you can see",
    autocomplete: "off",
    oninput: (event) => onQuery(event.target.value),
  });

  const results = el(
    "ul",
    { class: "analyze__results" },
    matches.map((card) =>
      el("li", {}, [
        el("span", { class: "analyze__name", text: card.name }),
        el("span", { class: "muted", text: `${remaining.get(card.key)} left` }),
        el("span", { class: "row" }, [
          el("button", {
            type: "button",
            class: "secondary",
            text: "In hand",
            onclick: () => onAssign("hand", card.key),
          }),
          el("button", {
            type: "button",
            class: "ghost",
            text: "On bottom",
            onclick: () => onAssign("bottom", card.key),
          }),
          el("button", {
            type: "button",
            class: "ghost",
            text: "Outside library",
            onclick: () => onAssign("outside", card.key),
          }),
        ]),
      ]),
    ),
  );

  replace(container, [
    el("h3", { text: "Analyze my real hand" }),
    el("p", {
      class: "muted",
      text: "Name the cards you can actually see. Each one leaves the unknown library, so the odds below are exact for what remains.",
    }),
    el("label", { for: "analyze-search", class: "visually-hidden", text: "Search a card you can see" }),
    search,
    needle && matches.length === 0
      ? el("p", { class: "muted", text: "No unaccounted copies match that name." })
      : results,
  ]);
}
