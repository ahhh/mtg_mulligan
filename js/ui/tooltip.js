/**
 * Card tooltip (plan sections 4.6 and 21).
 *
 * Opens on pointer hover AND on keyboard focus — hover-only tooltips are
 * unreachable by keyboard, so focus is a first-class trigger, not a fallback.
 * On narrow screens the same content renders as a bottom sheet.
 *
 * Images are lazy: the URL is only assigned when the tooltip actually opens, so
 * loading a 100-card deck never prefetches 100 card images (section 8.5).
 */

import { el, replace, manaPips } from "./dom.js";
import { getTagProvenance } from "../tags.js";

const MOBILE_BREAKPOINT = 720;

let root = null;
let currentCard = null;
let hideTimer = null;

function ensureRoot() {
  if (root) return root;
  root = el("div", {
    id: "card-tooltip",
    class: "tooltip",
    role: "dialog",
    "aria-live": "polite",
    hidden: true,
  });
  document.body.append(root);
  return root;
}

function isMobile() {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

function renderBody(card, { showImages = true } = {}) {
  const provenance = getTagProvenance(card);

  const header = el("div", { class: "tooltip__header" }, [
    el("span", { class: "tooltip__name", text: card.name }),
    el(
      "span",
      { class: "tooltip__cost", "aria-label": card.manaCost ? `Mana cost ${card.manaCost}` : null },
      manaPips(card.manaCost).map((pip) => el("span", { class: "pip", text: pip })),
    ),
  ]);

  const image =
    showImages && card.imageUris?.normal
      ? el("img", {
          class: "tooltip__image",
          src: card.imageUris.normal,
          alt: `${card.name} card image`,
          loading: "lazy",
        })
      : null;

  const tags = provenance.length
    ? el("div", { class: "tooltip__tags" }, [
        el("h4", { text: "Tags" }),
        el(
          "ul",
          { class: "tag-list" },
          provenance.map(({ tag, source }) =>
            el("li", { class: `tag tag--${source}` }, [
              el("span", { text: tag }),
              el("span", { class: "tag__source", text: source }),
            ]),
          ),
        ),
      ])
    : el("p", { class: "muted", text: "No tags yet." });

  return [
    header,
    image,
    el("p", { class: "tooltip__type", text: card.typeLine || "Type unknown — not resolved yet" }),
    card.oracleText ? el("p", { class: "tooltip__oracle", text: card.oracleText }) : null,
    tags,
    card.resolved ? null : el("p", { class: "warn", text: "Not resolved against Scryfall." }),
  ].filter(Boolean);
}

/** Positions the tooltip beside an anchor, kept inside the viewport. */
function position(anchor) {
  if (isMobile()) {
    root.classList.add("tooltip--sheet");
    root.style.left = "";
    root.style.top = "";
    return;
  }
  root.classList.remove("tooltip--sheet");
  const rect = anchor.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  const gap = 12;
  let left = rect.right + gap;
  if (left + box.width > window.innerWidth - 8) left = Math.max(8, rect.left - box.width - gap);
  let top = rect.top;
  if (top + box.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - box.height - 8);
  root.style.left = `${left + window.scrollX}px`;
  root.style.top = `${top + window.scrollY}px`;
}

export function showTooltip(card, anchor, options = {}) {
  clearTimeout(hideTimer);
  ensureRoot();
  currentCard = card;
  replace(root, renderBody(card, options));
  root.hidden = false;
  position(anchor);
}

export function hideTooltip({ immediate = false } = {}) {
  if (!root) return;
  clearTimeout(hideTimer);
  const run = () => {
    root.hidden = true;
    root.classList.remove("tooltip--sheet");
    currentCard = null;
  };
  if (immediate) run();
  else hideTimer = setTimeout(run, 80);
}

export function tooltipCard() {
  return currentCard;
}

/**
 * Wires an element to the tooltip. Returns a cleanup function.
 * Escape closes it, per the accessibility requirements.
 */
export function attachTooltip(node, card, options = {}) {
  const open = () => showTooltip(card, node, options);
  const close = () => hideTooltip();

  node.addEventListener("pointerenter", open);
  node.addEventListener("pointerleave", close);
  node.addEventListener("focus", open);
  node.addEventListener("blur", close);
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTooltip({ immediate: true });
  });
  // Touch: a tap opens the sheet without also triggering the card's action.
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    open();
  });

  return () => {
    node.removeEventListener("pointerenter", open);
    node.removeEventListener("pointerleave", close);
    node.removeEventListener("focus", open);
    node.removeEventListener("blur", close);
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTooltip({ immediate: true });
  });
}
