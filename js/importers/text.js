/**
 * Plain deck-list importer.
 *
 * This is the fallback that must always work: no network, no third-party API,
 * no CORS. Every other importer is an adapter that ultimately produces the same
 * shape this one does.
 *
 * Supported line forms:
 *
 *   1 Sol Ring
 *   1x Sol Ring
 *   4 Lightning Bolt
 *   1 Sol Ring (CMM) 396
 *   1x Sol Ring [CMM:396]
 *   Sol Ring                    (quantity defaults to 1)
 *   1 Sol Ring *CMDR*           (Archidekt/MTGO style annotation)
 *
 * Section headings switch the destination zone.
 */

import { ZONES, createDeck, createDeckCard } from "../deck-model.js";

const SECTION_HEADINGS = new Map([
  ["commander", ZONES.COMMANDER],
  ["commanders", ZONES.COMMANDER],
  ["command zone", ZONES.COMMANDER],
  ["deck", ZONES.MAIN],
  ["mainboard", ZONES.MAIN],
  ["main", ZONES.MAIN],
  ["main deck", ZONES.MAIN],
  ["maindeck", ZONES.MAIN],
  ["creatures", ZONES.MAIN],
  ["lands", ZONES.MAIN],
  ["spells", ZONES.MAIN],
  ["sideboard", ZONES.SIDEBOARD],
  ["side", ZONES.SIDEBOARD],
  ["companion", ZONES.SIDEBOARD],
  ["maybeboard", ZONES.MAYBEBOARD],
  ["maybe", ZONES.MAYBEBOARD],
  ["considering", ZONES.MAYBEBOARD],
]);

/** `1 Sol Ring (CMM) 396`, `1x Sol Ring [CMM:396]`, `Sol Ring`. */
const LINE_PATTERN = /^\s*(?:(\d+)\s*[xX]?\s+)?(.+?)\s*$/;
const SET_SUFFIX_PATTERNS = [
  /\s*\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9-★]+)?\s*$/, //  (CMM) 396
  /\s*\[([A-Za-z0-9]{2,6}):([A-Za-z0-9-★]+)\]\s*$/, //     [CMM:396]
];
const ANNOTATION_PATTERN = /\s*[*#][^*#]+[*#]\s*$/; //     *CMDR*, #Removal#
const CATEGORY_SUFFIX = /\s*\^[^^]*\^\s*$/; //             ^Buy,#8c7ae6^ (Archidekt)

/** True when the text looks like a deck list rather than a URL or JSON. */
export function canHandle(input) {
  if (typeof input !== "string") return false;
  const text = input.trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (text.startsWith("{") || text.startsWith("[")) return false;
  return parseDeckList(text).cards.length > 0;
}

function stripAnnotations(rawName) {
  let name = rawName;
  let set = null;
  let collectorNumber = null;
  const sourceTags = [];

  name = name.replace(CATEGORY_SUFFIX, "");

  // Archidekt-style *CMDR* / category annotations, possibly repeated.
  let annotationMatch = name.match(ANNOTATION_PATTERN);
  while (annotationMatch) {
    const annotation = annotationMatch[0].trim().replace(/^[*#]|[*#]$/g, "").trim();
    if (annotation) sourceTags.push(annotation);
    name = name.slice(0, annotationMatch.index).trimEnd();
    annotationMatch = name.match(ANNOTATION_PATTERN);
  }

  for (const pattern of SET_SUFFIX_PATTERNS) {
    const match = name.match(pattern);
    if (match) {
      set = match[1].toLowerCase();
      collectorNumber = match[2] ?? null;
      name = name.slice(0, match.index).trimEnd();
      break;
    }
  }

  return { name: name.trim(), set, collectorNumber, sourceTags };
}

function headingZone(line) {
  const cleaned = line
    .replace(/[:：]/g, "")
    .replace(/\(\s*\d+\s*\)\s*$/, "") // "Sideboard (15)"
    .replace(/^\/\/\s*/, "") // "// Commander"
    .trim()
    .toLowerCase();
  return SECTION_HEADINGS.get(cleaned) ?? null;
}

/**
 * Parses a deck list into raw entries plus any lines that could not be read.
 */
export function parseDeckList(text) {
  const cards = [];
  const problems = [];
  let zone = ZONES.MAIN;
  let sawExplicitSection = false;

  const lines = String(text || "").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("//") && !headingZone(line)) continue; // comment
    if (line.startsWith("#") && !/^\s*#?\d/.test(line)) {
      const zoneFromComment = headingZone(line.replace(/^#+\s*/, ""));
      if (zoneFromComment) {
        zone = zoneFromComment;
        sawExplicitSection = true;
        continue;
      }
      continue;
    }

    const asHeading = headingZone(line);
    if (asHeading) {
      zone = asHeading;
      sawExplicitSection = true;
      continue;
    }

    const match = line.match(LINE_PATTERN);
    if (!match) {
      problems.push({ line: index + 1, text: rawLine, reason: "unrecognized" });
      continue;
    }

    const quantity = match[1] ? Number.parseInt(match[1], 10) : 1;
    const parsed = stripAnnotations(match[2]);
    if (!parsed.name) {
      problems.push({ line: index + 1, text: rawLine, reason: "no card name" });
      continue;
    }

    // An inline *CMDR* annotation overrides the current section.
    const isCommanderLine = parsed.sourceTags.some((tag) => /^cmdr$|^commander$/i.test(tag));

    cards.push({
      name: parsed.name,
      quantity,
      set: parsed.set,
      collectorNumber: parsed.collectorNumber,
      zone: isCommanderLine ? ZONES.COMMANDER : zone,
      sourceTags: parsed.sourceTags.filter((tag) => !/^cmdr$|^commander$/i.test(tag)),
    });
  }

  return { cards, problems, sawExplicitSection };
}

/**
 * Importer entry point. Returns the provider-neutral shape described in the
 * plan's importer interface; Scryfall hydration fills in metadata afterwards.
 */
export function importText(text, options = {}) {
  const { cards, problems, sawExplicitSection } = parseDeckList(text);
  if (cards.length === 0) {
    throw new Error("No cards found in that deck list");
  }

  const deckCards = cards.map((entry) =>
    createDeckCard({
      name: entry.name,
      quantity: entry.quantity,
      set: entry.set,
      collectorNumber: entry.collectorNumber,
      zone: entry.zone,
      sourceTags: entry.sourceTags.length ? { text: entry.sourceTags } : {},
    }),
  );

  const deck = createDeck({
    name: options.name || "Pasted deck",
    format: options.format || inferFormat(deckCards),
    source: { type: "text", url: null, sourceDeckId: null },
    cards: deckCards,
  });

  return { deck, problems, sawExplicitSection };
}

function inferFormat(cards) {
  const hasCommander = cards.some((card) => card.zone === ZONES.COMMANDER);
  if (hasCommander) return "commander";
  const mainCount = cards
    .filter((card) => card.zone === ZONES.MAIN)
    .reduce((total, card) => total + card.quantity, 0);
  return mainCount >= 90 ? "commander" : "constructed";
}

export const textImporter = {
  provider: "text",
  canHandle,
  import: async (input, options) => importText(input, options),
};
