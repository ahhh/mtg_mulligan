import { ZONES, createDeck, createDeckCard } from "../../js/deck-model.js";

/** A tiny synthetic deck: `size` cards, `hits` of which are Forests. */
export function syntheticDeck({ size = 10, hits = 2, name = "Synthetic" } = {}) {
  return createDeck({
    name,
    format: "constructed",
    cards: [
      createDeckCard({
        name: "Forest",
        quantity: hits,
        typeLine: "Basic Land — Forest",
        manaValue: 0,
        resolved: true,
      }),
      createDeckCard({
        name: "Grizzly Bears",
        quantity: size - hits,
        typeLine: "Creature — Bear",
        manaCost: "{1}{G}",
        manaValue: 2,
        resolved: true,
      }),
    ],
  });
}

/** A 99-card commander deck with a commander, lands, removal, and filler. */
export function commanderDeck() {
  return createDeck({
    name: "Test Commander",
    format: "commander",
    cards: [
      createDeckCard({
        name: "Sidisi, Brood Tyrant",
        quantity: 1,
        zone: ZONES.COMMANDER,
        typeLine: "Legendary Creature — Naga Wizard",
        manaCost: "{1}{B}{G}{U}",
        manaValue: 4,
        resolved: true,
      }),
      createDeckCard({
        name: "Forest",
        quantity: 36,
        typeLine: "Basic Land — Forest",
        manaValue: 0,
        resolved: true,
      }),
      createDeckCard({
        name: "Command Tower",
        quantity: 2,
        typeLine: "Land",
        manaValue: 0,
        resolved: true,
      }),
      createDeckCard({
        name: "Fatal Push",
        quantity: 4,
        typeLine: "Instant",
        manaCost: "{B}",
        manaValue: 1,
        userTags: ["Removal"],
        resolved: true,
      }),
      createDeckCard({
        name: "Grizzly Bears",
        quantity: 57,
        typeLine: "Creature — Bear",
        manaCost: "{1}{G}",
        manaValue: 2,
        resolved: true,
      }),
      createDeckCard({
        name: "Pithing Needle",
        quantity: 1,
        zone: ZONES.SIDEBOARD,
        typeLine: "Artifact",
        manaCost: "{1}",
        manaValue: 1,
        resolved: true,
      }),
    ],
  });
}
