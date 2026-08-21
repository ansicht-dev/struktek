/**
 * The DOM helpers both frames build their markup with.
 *
 * They were written twice, once per frame, and were already identical - which
 * is the point at which a helper belongs in one file rather than in two. The
 * rule they exist to keep is the same in both: everything on screen is text
 * the user wrote, so nodes are built with `textContent` and never `innerHTML`.
 */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (globalThis.Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function on<T extends HTMLElement>(node: T, event: string, handler: (e: Event) => void): T {
  node.addEventListener(event, handler);
  return node;
}

/** A codicon, the workbench's own icon font — not a lookalike glyph. */
export function icon(name: string, extra = ''): HTMLElement {
  return el('span', { class: ('codicon codicon-' + name + ' ' + extra).trim(), 'aria-hidden': 'true' });
}
