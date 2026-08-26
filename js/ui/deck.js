/**
 * Deck-facing panels: import, summary, unresolved cards, tag editor, and the
 * category picker that feeds the odds dashboard.
 */

import { el, replace, formatCount } from "./dom.js";
import { attachTooltip } from "./tooltip.js";
import { ZONES, drawableSize, getCommanders, getUnresolvedCards } from "../deck-model.js";
import { getEffectiveTags, getTagProvenance, normalizeTag } from "../tags.js";

/** How many drawable cards carry each effective tag, most common first. */
export function deckTagCounts(deck) {
  const counts = new Map();
  for (const card of deck.cards) {
    if (card.zone !== ZONES.MAIN) continue;
    for (const tag of getEffectiveTags(card)) {
      counts.set(tag, (counts.get(tag) || 0) + card.quantity);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export function renderImport(container, handlers) {
  const { onImportText, onImportUrl, onLoadSample, recents = [], onOpenRecent, onImportProfile } = handlers;

  const textarea = el("textarea", {
    id: "deck-input",
    rows: "10",
    spellcheck: "false",
    placeholder: [
      "1 Sol Ring",
      "1 Arcane Signet",
      "36 Forest",
      "",
      "Commander",
      "1 Sidisi, Brood Tyrant",
    ].join("\n"),
  });

  const nameInput = el("input", { id: "deck-name", type: "text", placeholder: "Deck name (optional)" });

  const form = el(
    "form",
    {
      class: "import",
      onsubmit: (event) => {
        event.preventDefault();
        onImportText(textarea.value, nameInput.value.trim());
      },
    },
    [
      el("label", { for: "deck-input", text: "Paste a deck list" }),
      textarea,
      el("div", { class: "row" }, [
        el("label", { for: "deck-name", class: "visually-hidden", text: "Deck name" }),
        nameInput,
        el("button", { type: "submit", class: "primary", text: "Import deck" }),
      ]),
    ],
  );

  const urlInput = el("input", {
    id: "deck-url",
    type: "url",
    placeholder: "https://archidekt.com/decks/365563/...",
    spellcheck: "false",
  });

  const urlForm = el(
    "form",
    {
      class: "import import--url",
      onsubmit: (event) => {
        event.preventDefault();
        onImportUrl(urlInput.value.trim());
      },
    },
    [
      el("label", { for: "deck-url", text: "Or import from an Archidekt link" }),
      el("div", { class: "row" }, [urlInput, el("button", { type: "submit", class: "secondary", text: "Import" })]),
      el("p", {
        class: "muted",
        // Section 1.1: Archidekt pins access-control-allow-origin to their own
        // dev origin, so the browser cannot read the response directly. Saying
        // so here is honest about the one request that leaves the machine.
        text: "Archidekt blocks direct browser reads, so the deck id is relayed through an import proxy. Your deck stays in the browser otherwise.",
      }),
    ],
  );

  const alternatives = el("div", { class: "row wrap" }, [
    el("button", { type: "button", class: "secondary", text: "Load sample deck", onclick: onLoadSample }),
    el("label", { class: "file-button" }, [
      "Import app profile",
      el("input", {
        type: "file",
        accept: "application/json,.json",
        class: "visually-hidden",
        onchange: (event) => {
          const [file] = event.target.files || [];
          if (file) onImportProfile(file);
          event.target.value = "";
        },
      }),
    ]),
  ]);

  const recentList = recents.length
    ? el("div", { class: "subpanel" }, [
        el("h3", { text: "Recent decks" }),
        el(
          "ul",
          { class: "recents" },
          recents.map((entry) =>
            el("li", {}, [
              el("button", {
                type: "button",
                class: "link",
                text: entry.name,
                onclick: () => onOpenRecent(entry.id),
              }),
            ]),
          ),
        ),
      ])
    : null;

  replace(container, [
    el("p", {
      class: "lede",
      text: "Paste a deck list and get exact draw odds. Archidekt links import directly; for Moxfield, export the list and paste it here.",
    }),
    form,
    urlForm,
    alternatives,
    recentList,
  ]);
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export function renderDeckSummary(container, { deck, hydration, settings, handlers }) {
  const commanders = getCommanders(deck);
  const counts = deckTagCounts(deck);
  const headline = counts
    .filter(({ tag }) => ["Land", "Creature", "Instant", "Sorcery", "Artifact", "Enchantment"].includes(tag))
    .slice(0, 5)
    .map(({ tag, count }) => `${count} ${tag.toLowerCase()}`)
    .join(" · ");

  const status = hydration.pending
    ? el("p", { class: "status", role: "status", text: hydration.message })
    : hydration.error
      ? el("p", { class: "warn", role: "status" }, [
          el("strong", { text: "Scryfall is unavailable. " }),
          "Card types and images are missing, so automatic tags are limited. Your own tags still work.",
        ])
      : null;

  replace(container, [
    el("div", { class: "panel__head" }, [
      el("h2", { text: deck.name }),
      el("span", {
        class: "muted",
        text: `${formatCount(drawableSize(deck), "card")} drawable${
          commanders.length ? ` · ${formatCount(commanders.length, "commander")} excluded` : ""
        }`,
      }),
    ]),
    headline ? el("p", { class: "muted", text: headline }) : null,
    status,
    commanders.length
      ? el("p", { class: "muted" }, [
          "Command zone: ",
          ...commanders.map((card) => el("span", { class: "chip", text: card.name })),
        ])
      : null,
    el("div", { class: "row wrap" }, [
      el("button", { type: "button", class: "primary", text: "Deal opening hand", onclick: handlers.onDeal }),
      el("button", {
        type: "button",
        class: "secondary",
        text: "Analyze my real hand",
        onclick: handlers.onAnalyze,
      }),
      el("button", { type: "button", class: "secondary", text: "Export profile", onclick: handlers.onExport }),
      el("button", { type: "button", class: "ghost", text: "Load a different deck", onclick: handlers.onNewDeck }),
    ]),
    renderUnresolved(deck, handlers),
    renderSettings(settings, handlers),
  ]);
}

/**
 * Unresolved cards are never dropped from the deck size — they still count as
 * cards in the library, they just have no type line (plan section 19.3).
 */
function renderUnresolved(deck, handlers) {
  const unresolved = getUnresolvedCards(deck).filter((card) => card.zone !== ZONES.SIDEBOARD);
  if (unresolved.length === 0) return null;

  return el("details", { class: "subpanel warn-panel" }, [
    el("summary", { text: `${formatCount(unresolved.length, "card")} could not be resolved` }),
    el("p", {
      class: "muted",
      text: "They still count toward deck size and draw odds. Without a type line their automatic tags are missing — tag them by hand or fix the spelling and re-import.",
    }),
    el(
      "ul",
      { class: "plain" },
      unresolved.map((card) => el("li", { text: `${card.quantity}× ${card.name}` })),
    ),
    handlers.onRetryHydrate
      ? el("button", { type: "button", class: "secondary", text: "Retry Scryfall", onclick: handlers.onRetryHydrate })
      : null,
  ]);
}

function renderSettings(settings, handlers) {
  const change = (patch) => handlers.onSettings(patch);

  return el("details", { class: "subpanel" }, [
    el("summary", { text: "Settings" }),
    el("div", { class: "settings" }, [
      el("label", {}, [
        el("input", {
          type: "checkbox",
          checked: settings.onPlay,
          onchange: (event) => change({ onPlay: event.target.checked }),
        }),
        " On the play",
      ]),
      el("label", {}, [
        el("input", {
          type: "checkbox",
          checked: settings.drawOnTurnOne,
          onchange: (event) => change({ drawOnTurnOne: event.target.checked }),
        }),
        " Draw on turn one",
      ]),
      el("label", {}, [
        el("input", {
          type: "checkbox",
          checked: settings.showImages,
          onchange: (event) => change({ showImages: event.target.checked }),
        }),
        " Show card images in tooltips",
      ]),
      el("label", { for: "free-mulligans" }, [
        "Free mulligans ",
        el("input", {
          id: "free-mulligans",
          type: "number",
          min: "0",
          max: "7",
          value: String(settings.freeMulligans),
          onchange: (event) => change({ freeMulligans: Math.max(0, Number(event.target.value) || 0) }),
        }),
      ]),
      el("label", { for: "land-threshold" }, [
        "Land risk threshold ",
        el("input", {
          id: "land-threshold",
          type: "number",
          min: "0",
          max: "100",
          step: "5",
          value: String(Math.round(settings.landThreshold * 100)),
          onchange: (event) =>
            change({ landThreshold: Math.min(1, Math.max(0, (Number(event.target.value) || 0) / 100)) }),
        }),
        "%",
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* Category picker                                                     */
/* ------------------------------------------------------------------ */

/** Toggles which tags appear as rows in the odds table. */
export function renderTargetPicker(container, { deck, selectedTags, onToggle }) {
  const counts = deckTagCounts(deck);
  if (counts.length === 0) {
    replace(container, el("p", { class: "muted", text: "No tags on this deck yet." }));
    return;
  }

  replace(
    container,
    el(
      "div",
      { class: "chips", role: "group", "aria-label": "Categories shown in the odds table" },
      counts.map(({ tag, count }) => {
        const active = selectedTags.has(tag.toLowerCase());
        return el("button", {
          type: "button",
          class: `chip chip--toggle${active ? " chip--on" : ""}`,
          "aria-pressed": String(active),
          text: `${tag} (${count})`,
          onclick: () => onToggle(tag),
        });
      }),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Tag editor                                                          */
/* ------------------------------------------------------------------ */

/**
 * The tag editor (plan section 9.4). Edits are stored as user additions and
 * removals, never as a rewritten tag list, so precedence keeps working and
 * every downstream probability updates immediately.
 */
export function renderTagEditor(container, { deck, query, onQuery, onAddTag, onRemoveTag, showImages }) {
  const needle = query.trim().toLowerCase();
  const matches = deck.cards
    .filter((card) => !needle || card.name.toLowerCase().includes(needle))
    .slice(0, 40);

  const search = el("input", {
    id: "tag-search",
    type: "search",
    value: query,
    placeholder: "Filter cards by name",
    oninput: (event) => onQuery(event.target.value),
  });

  const rows = matches.map((card) => {
    const provenance = getTagProvenance(card);
    const input = el("input", {
      type: "text",
      class: "tag-input",
      placeholder: "Add tag",
      "aria-label": `Add a tag to ${card.name}`,
      onkeydown: (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const tag = normalizeTag(event.target.value);
        if (tag) onAddTag(card.key, tag);
        event.target.value = "";
      },
    });

    const name = el("button", {
      type: "button",
      class: "link tag-editor__name",
      text: `${card.quantity}× ${card.name}`,
    });
    attachTooltip(name, card, { showImages });

    return el("li", { class: "tag-editor__row" }, [
      name,
      el(
        "span",
        { class: "chips" },
        provenance.map(({ tag, source }) =>
          el("button", {
            type: "button",
            class: `chip chip--${source} chip--removable`,
            text: `${tag} ×`,
            "aria-label": `Remove tag ${tag} from ${card.name} (from ${source})`,
            onclick: () => onRemoveTag(card.key, tag),
          }),
        ),
      ),
      input,
    ]);
  });

  replace(container, [
    el("label", { for: "tag-search", class: "visually-hidden", text: "Filter cards by name" }),
    search,
    el("p", {
      class: "muted footnote",
      text: "Type a tag and press Enter to add it. Removing a tag overrides every other source, including the type line.",
    }),
    el("ul", { class: "tag-editor" }, rows),
    matches.length === 0 ? el("p", { class: "muted", text: "No cards match that filter." }) : null,
  ]);
}
