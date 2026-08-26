/**
 * Static wiring checks.
 *
 * The plan puts real browser testing in the manual column (section 23.9), but
 * the failures that actually break a static site are mechanical: an element id
 * the JS reaches for that the HTML does not have, an import path that 404s, or
 * an `innerHTML` assignment that turns an imported deck name into markup. Those
 * are all checkable without a DOM.
 */

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(root, "index.html"), "utf8");

async function jsFiles(dir = resolve(root, "js")) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await jsFiles(path)));
    else if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

const sources = await Promise.all(
  (await jsFiles()).map(async (path) => ({ path, text: await readFile(path, "utf8") })),
);

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

test("every element id the JS looks up exists in index.html", () => {
  const missing = [];
  for (const { path, text } of sources) {
    for (const match of text.matchAll(/\$\("#([\w-]+)"\)|querySelector\("#([\w-]+)"\)/g)) {
      const id = match[1] ?? match[2];
      // The tooltip creates its own root at runtime rather than expecting one.
      if (id === "card-tooltip") continue;
      if (!htmlIds.has(id)) missing.push(`${path.replace(root, ".")} → #${id}`);
    }
  }
  assert.deepEqual(missing, [], "these lookups would return null in the browser");
});

test("every screen the app can switch to exists in index.html", () => {
  const screens = new Set([...html.matchAll(/data-screen="([^"]+)"/g)].map((match) => match[1]));
  const app = sources.find(({ path }) => path.endsWith("app.js")).text;

  const requested = new Set([
    ...[...app.matchAll(/screen:\s*"([\w-]+)"/g)].map((match) => match[1]),
    ...[...app.matchAll(/screen === "([\w-]+)"/g)].map((match) => match[1]),
  ]);
  for (const screen of requested) {
    assert.ok(screens.has(screen), `index.html has no section for screen "${screen}"`);
  }

  for (const target of [...html.matchAll(/data-goto="([^"]+)"/g)].map((match) => match[1])) {
    assert.ok(screens.has(target), `nav button points at missing screen "${target}"`);
  }
});

test("every relative import resolves to a file that exists", async () => {
  for (const { path, text } of sources) {
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = resolve(dirname(path), match[1]);
      const info = await stat(target).catch(() => null);
      assert.ok(info?.isFile(), `${path.replace(root, ".")} imports missing ${match[1]}`);
    }
  }
});

test("index.html only references assets that exist", async () => {
  for (const match of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) {
    const info = await stat(resolve(root, match[1])).catch(() => null);
    assert.ok(info?.isFile(), `index.html references missing ${match[1]}`);
  }
});

test("no module ever assigns innerHTML", () => {
  // Deck names, card names, and imported tags are untrusted external text
  // (plan section 20.2). textContent is the only way they reach the page.
  const offenders = sources
    .filter(({ text }) => /\.innerHTML\s*=|insertAdjacentHTML/.test(text))
    .map(({ path }) => path.replace(root, "."));
  assert.deepEqual(offenders, []);
});

test("the Content-Security-Policy allows exactly the hosts the app uses", () => {
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  assert.ok(csp, "index.html must ship a CSP");

  assert.match(csp, /connect-src [^;]*https:\/\/api\.scryfall\.com/, "Scryfall API must be reachable");
  assert.match(csp, /img-src [^;]*https:\/\/cards\.scryfall\.io/, "card images must be loadable");
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, "no inline script or style is used");
  assert.match(csp, /default-src 'none'/, "everything not listed is denied");
});

test("the UI never imports the raw probability module", () => {
  // Section 5.2: no UI component performs probability math directly. The odds
  // dashboard must go through draw-odds.js, which owns the known-bottom rule.
  const uiModules = sources.filter(({ path }) => path.includes(`${"/"}ui${"/"}`));
  assert.ok(uiModules.length > 0, "there should be UI modules to check");
  for (const { path, text } of uiModules) {
    assert.doesNotMatch(text, /from\s+"[^"]*probability\.js"/, `${path.replace(root, ".")} bypasses draw-odds.js`);
  }
});
