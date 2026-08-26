/**
 * The draw-odds dashboard (plan sections 4.2, 4.4, 10, 15).
 *
 * This module renders numbers; it never computes them. Every value comes from
 * `draw-odds.js`, which is the only place hypergeometric math meets the deck.
 */

import { el, replace, formatPercent, formatCount } from "./dom.js";
import { buildOddsTable, drawsBeforeTurn, getDrawProbability } from "../draw-odds.js";
import { hasTag } from "../tags.js";

/**
 * The odds table: one row per target, one column per draw horizon.
 *
 * Targets overlap on purpose — a card can be both Ramp and Artifact — so these
 * are independent hit rates and must never be presented as a pie.
 */
export function renderOddsTable(container, { game, targets, horizons, unresolvedCount = 0 }) {
  if (targets.length === 0) {
    // Distinguish "you turned every category off" from "there are no categories
    // because Scryfall never resolved the deck" — the fixes are different.
    replace(
      container,
      unresolvedCount > 0
        ? el("p", { class: "warn" }, [
            el("strong", { text: "No categories yet. " }),
            `${unresolvedCount} cards have no type line, so nothing was tagged automatically. Retry Scryfall from the deck screen, or add tags by hand.`,
          ])
        : el("p", { class: "muted", text: "No categories selected. Pick some above." }),
    );
    return;
  }

  const rows = buildOddsTable({ gameState: game, targets, horizons });

  const head = el("thead", {}, [
    el("tr", {}, [
      el("th", { scope: "col", text: "Category" }),
      el("th", { scope: "col", class: "num", text: "In hand" }),
      el("th", { scope: "col", class: "num", text: "In library" }),
      ...horizons.map((draws) =>
        el("th", { scope: "col", class: "num", text: draws === 1 ? "Next card" : `Next ${draws}` }),
      ),
    ]),
  ]);

  const body = el(
    "tbody",
    {},
    rows.map((row) =>
      el("tr", {}, [
        el("th", { scope: "row", text: row.label }),
        el("td", { class: "num", text: String(row.inHand) }),
        el("td", { class: "num", text: String(row.inLibrary) }),
        ...row.horizons.map((cell) =>
          el("td", {
            class: `num${cell.method === "deterministic" ? " num--certain" : ""}`,
            // Screen readers read the label, not just the digits.
            "aria-label": `${row.label}, ${formatCount(cell.draws, "card")}: ${formatPercent(cell.probability)}`,
            title: cell.reachesKnownBottom
              ? "This horizon runs past the unknown library into known bottom cards, so the result is deterministic."
              : `${cell.successes} hits in ${cell.population} unknown cards`,
            text: formatPercent(cell.probability),
          }),
        ),
      ]),
    ),
  );

  replace(container, [
    el("table", { class: "odds" }, [head, body]),
    el("p", {
      class: "muted footnote",
      text: "Exact hypergeometric probabilities from the unknown portion of the library. Categories overlap, so these rates are independent.",
    }),
  ]);
}

/**
 * The hand check (section 4.2): a plain-language read on whether this hand is
 * short on lands, and what the odds are of fixing that in time.
 */
export function renderHandCheck(container, { game, settings, landTarget }) {
  if (game.hand.length === 0) {
    replace(container, el("p", { class: "muted", text: "Deal a hand to see the hand check." }));
    return;
  }

  // Without type lines there is no Land tag, and "0 lands in hand" would be a
  // confident lie. Say what is actually wrong instead.
  const unresolvedInHand = game.hand.filter((instance) => !instance.card.resolved).length;
  if (unresolvedInHand === game.hand.length) {
    replace(
      container,
      el("p", { class: "warn" }, [
        el("strong", { text: "Cards in this hand are not resolved. " }),
        "Land counts and risk need a type line. Retry Scryfall from the deck screen, or tag the cards yourself.",
      ]),
    );
    return;
  }

  const landsInHand = game.hand.filter((instance) => hasTag(instance.card, "Land")).length;
  const spells = game.hand.filter((instance) => !hasTag(instance.card, "Land"));
  const costs = spells.map((instance) => instance.card.manaValue).filter((mv) => Number.isFinite(mv));
  const averageCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;

  // "By turn 3" is the classic keep question: can this hand make its third land
  // drop on curve? The horizon is the number of real draw steps until then.
  const targetTurn = 3;
  const draws = drawsBeforeTurn(targetTurn, { onPlay: settings.onPlay, drawOnTurnOne: settings.drawOnTurnOne });
  const landsNeeded = Math.max(0, targetTurn - landsInHand);
  const odds =
    landsNeeded > 0
      ? getDrawProbability({ gameState: game, target: landTarget, draws, minimumHits: landsNeeded })
      : null;

  const risk = riskLevel({ landsInHand, odds, threshold: settings.landThreshold });

  const lines = [
    el("p", {}, [
      el("strong", { text: formatCount(landsInHand, "land") }),
      ` in hand · ${formatCount(spells.length, "spell")}`,
      averageCost === null ? "" : ` averaging mana value ${averageCost.toFixed(1)}`,
      ".",
    ]),
    odds
      ? el("p", {}, [
          `Chance to hit ${formatCount(landsNeeded, "more land")} in your next ${formatCount(draws, "draw")} `,
          `(${settings.onPlay ? "on the play" : "on the draw"}, through turn ${targetTurn}): `,
          el("strong", { text: formatPercent(odds.probability) }),
          ` · your threshold is ${formatPercent(settings.landThreshold)}.`,
        ])
      : el("p", { text: `Three land drops through turn ${targetTurn} are already in hand.` }),
    unresolvedInHand
      ? el("p", { class: "warn footnote" }, [
          `${unresolvedInHand} of these cards have no type line, so this count may be low.`,
        ])
      : null,
    el("p", { class: `risk risk--${risk.level}` }, [
      // Never status by color alone: the word and the icon both carry it.
      el("span", { class: "risk__icon", "aria-hidden": "true", text: risk.icon }),
      el("span", { text: `Risk: ${risk.label}` }),
      el("span", { class: "muted", text: ` — ${risk.reason}` }),
    ]),
  ].filter(Boolean);

  replace(container, lines);
}

/** Risk is a heuristic, deliberately kept separate from the exact math. */
function riskLevel({ landsInHand, odds, threshold }) {
  if (landsInHand === 0) {
    return { level: "high", icon: "!", label: "HIGH", reason: "no lands in hand" };
  }
  if (landsInHand === 1) {
    return { level: "high", icon: "!", label: "HIGH", reason: "a one-land hand needs an early hit" };
  }
  if (!odds) {
    return { level: "low", icon: "✓", label: "LOW", reason: "land count is comfortable" };
  }
  if (odds.probability >= threshold) {
    return { level: "low", icon: "✓", label: "LOW", reason: "you are above your configured threshold" };
  }
  if (odds.probability >= threshold * 0.7) {
    return { level: "medium", icon: "△", label: "MEDIUM", reason: "below your threshold, but close" };
  }
  return { level: "high", icon: "!", label: "HIGH", reason: "well below your configured threshold" };
}

/**
 * The turn planner: pick a turn and a category, get the exact odds of having
 * what you need by then.
 */
export function renderTurnPlanner(container, { game, settings, targets, selection, onChange }) {
  const target = targets.find((candidate) => candidate.id === selection.targetId) ?? targets[0];
  if (!target) {
    replace(container, el("p", { class: "muted", text: "Select a category to plan a turn." }));
    return;
  }

  const draws = drawsBeforeTurn(selection.turn, {
    onPlay: settings.onPlay,
    drawOnTurnOne: settings.drawOnTurnOne,
  });
  const result = getDrawProbability({
    gameState: game,
    target,
    draws,
    minimumHits: selection.minimumHits,
  });

  const categorySelect = el(
    "select",
    {
      id: "planner-target",
      onchange: (event) => onChange({ ...selection, targetId: event.target.value }),
    },
    targets.map((candidate) =>
      el("option", { value: candidate.id, selected: candidate.id === target.id, text: candidate.label }),
    ),
  );

  replace(container, [
    el("div", { class: "planner__controls" }, [
      el("label", { for: "planner-count", text: "I need" }),
      el("input", {
        id: "planner-count",
        type: "number",
        min: "1",
        max: "10",
        value: String(selection.minimumHits),
        oninput: (event) =>
          onChange({ ...selection, minimumHits: Math.max(1, Number(event.target.value) || 1) }),
      }),
      el("label", { for: "planner-target", class: "visually-hidden", text: "Category" }),
      categorySelect,
      el("label", { for: "planner-turn", text: "by turn" }),
      el("input", {
        id: "planner-turn",
        type: "number",
        min: "1",
        max: "20",
        value: String(selection.turn),
        oninput: (event) => onChange({ ...selection, turn: Math.max(1, Number(event.target.value) || 1) }),
      }),
    ]),
    el("p", { class: "planner__result", role: "status" }, [
      `You will see ${formatCount(draws, "draw step")} before then. Chance: `,
      el("strong", { text: formatPercent(result.probability) }),
      result.truncated ? " (horizon clamped to the remaining library)" : "",
    ]),
    el("p", {
      class: "muted footnote",
      text: "Only ordinary draw steps are counted. Cantrips and draw spells are not assumed.",
    }),
  ]);
}
