/**
 * Minimal DOM helpers.
 *
 * Every string that reaches the page goes through `textContent`, never
 * `innerHTML` — deck names, card names, Oracle text, and imported tags are all
 * untrusted external text (plan section 20.2).
 */

/** Creates an element. `props` sets attributes; `text` sets textContent. */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "text") node.textContent = String(value);
    else if (name === "class") node.className = value;
    else if (name === "dataset") Object.assign(node.dataset, value);
    else if (name.startsWith("on") && typeof value === "function") {
      node.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(name, "");
    else node.setAttribute(name, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, children) {
  clear(node);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** Percentages are shown to one decimal; screen readers get the same string. */
export function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  if (value === 1) return "100%";
  if (value === 0) return "0%";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Splits `{1}{G}{G}` into pip strings for rendering. */
export function manaPips(manaCost) {
  if (!manaCost) return [];
  return [...String(manaCost).matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}
