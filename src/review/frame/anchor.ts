/**
 * Pinning a comment to an element, and finding that element again later.
 *
 * A pin stores several independent descriptions of its element (see `Anchor`
 * in protocol.ts). `resolveAnchor` tries them from most to least precise and
 * says which one worked, so the UI can show when a pin is only approximately
 * placed.
 */

import type { Anchor } from '../shared/protocol.ts';

const TEXT_LEN = 80;
/** Attributes that page builders and test tooling keep stable across edits. */
const STABLE_ATTRS = ['data-id', 'data-testid', 'data-test', 'data-block-id', 'data-section-id'];

export type Confidence = 'exact' | 'path' | 'text' | 'none';

export interface Resolved {
  el: Element | null;
  confidence: Confidence;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
}

/** Ids that look machine-generated change between builds and make poor anchors. */
function looksGenerated(id: string): boolean {
  return /\d{4,}/.test(id) || /^[a-f0-9]{8,}$/i.test(id) || /^(?::r|ember|react-|radix-|headlessui-|__)/.test(id) || id.length > 60;
}

function unique(doc: Document, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** `tag` or `tag:nth-of-type(n)` relative to the element's parent. */
function positionalStep(el: Element): string {
  const tag = cssEscape(el.localName);
  const parent = el.parentElement;
  if (!parent) return tag;
  let index = 0;
  let count = 0;
  for (const sibling of Array.from(parent.children)) {
    if (sibling.localName !== el.localName) continue;
    count++;
    if (sibling === el) index = count;
  }
  return count > 1 ? `${tag}:nth-of-type(${index})` : tag;
}

/** A step that identifies `el` by something stable, or null if it has nothing stable. */
function stableStep(el: Element): string | null {
  const id = el.getAttribute('id');
  if (id && !looksGenerated(id)) return `#${cssEscape(id)}`;
  for (const attr of STABLE_ATTRS) {
    const value = el.getAttribute(attr);
    if (value && value.length <= 80) return `${cssEscape(el.localName)}[${attr}="${value.replace(/["\\]/g, '\\$&')}"]`;
  }
  return null;
}

/** Full positional path from <body>. Always resolvable while the structure is unchanged. */
export function structuralPath(el: Element): string {
  const steps: string[] = [];
  let node: Element | null = el;
  while (node && node.localName !== 'body' && node.localName !== 'html') {
    steps.unshift(positionalStep(node));
    node = node.parentElement;
  }
  return ['body', ...steps].join(' > ');
}

/**
 * Shortest selector that is unique right now: climb from the element until an
 * ancestor has a stable id or data attribute, then descend positionally from
 * there. Falls back to the structural path.
 */
export function shortSelector(el: Element): string {
  const doc = el.ownerDocument;
  const steps: string[] = [];
  let node: Element | null = el;
  while (node && node.localName !== 'body' && node.localName !== 'html') {
    const stable = stableStep(node);
    if (stable) {
      const candidate = [stable, ...steps].join(' > ');
      if (unique(doc, candidate, el)) return candidate;
    }
    steps.unshift(positionalStep(node));
    node = node.parentElement;
  }
  return structuralPath(el);
}

/** Short, whitespace-normalised description of what the element shows. */
export function fingerprint(el: Element): string {
  const media = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title');
  let text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text && media) text = media;
  if (!text) {
    const src = el.getAttribute('src') || el.getAttribute('href') || '';
    text = src.split(/[?#]/)[0]!.split('/').pop() ?? '';
  }
  return text.slice(0, TEXT_LEN);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function buildAnchor(el: Element, clientX: number, clientY: number): Anchor {
  const doc = el.ownerDocument;
  const win = doc.defaultView!;
  const rect = el.getBoundingClientRect();
  const root = doc.documentElement;
  return {
    selector: shortSelector(el),
    path: structuralPath(el),
    tag: el.localName,
    text: fingerprint(el),
    fx: rect.width ? clamp01((clientX - rect.left) / rect.width) : 0.5,
    fy: rect.height ? clamp01((clientY - rect.top) / rect.height) : 0.5,
    page: {
      x: clientX + win.scrollX,
      y: clientY + win.scrollY,
      docW: root.scrollWidth,
      docH: root.scrollHeight,
    },
    viewport: { w: win.innerWidth, h: win.innerHeight },
  };
}

function query(doc: Document, selector: string): Element | null {
  if (!selector) return null;
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}

/** Does `el` still look like the element the anchor was made on? */
function matches(el: Element, anchor: Anchor): boolean {
  if (el.localName !== anchor.tag) return false;
  if (!anchor.text) return true;
  const now = fingerprint(el);
  if (!now) return false;
  const a = anchor.text.slice(0, 40);
  const b = now.slice(0, 40);
  return a === b || now.startsWith(a) || anchor.text.startsWith(b);
}

export function resolveAnchor(anchor: Anchor, doc: Document): Resolved {
  // 1. Preferred selector, accepted only if the element still looks right.
  const bySelector = query(doc, anchor.selector);
  if (bySelector && matches(bySelector, anchor)) return { el: bySelector, confidence: 'exact' };

  // 2. Structural path, same check.
  const byPath = anchor.path === anchor.selector ? bySelector : query(doc, anchor.path);
  if (byPath && matches(byPath, anchor)) return { el: byPath, confidence: 'path' };

  // 3. Same tag with the same text anywhere on the page; nearest to the old position wins.
  if (anchor.text.length >= 6) {
    const win = doc.defaultView!;
    let best: Element | null = null;
    let bestDistance = Infinity;
    for (const candidate of Array.from(doc.getElementsByTagName(anchor.tag))) {
      if (!matches(candidate, anchor)) continue;
      const rect = candidate.getBoundingClientRect();
      const distance = Math.abs(rect.top + win.scrollY - anchor.page.y) + Math.abs(rect.left + win.scrollX - anchor.page.x);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best) return { el: best, confidence: 'text' };
  }

  // 4. The selector still matches but the text is different. If the selector is
  //    built on a stable id or data attribute, this is the same element with
  //    edited copy (often the very change the comment asked for), so keep the pin.
  //    A purely positional selector proves nothing once the text differs: the
  //    element may be gone and a sibling may have taken its slot. Report that
  //    as missing instead of pointing at the wrong thing.
  const stableSelector = !anchor.selector.startsWith('body');
  if (stableSelector && bySelector && bySelector.localName === anchor.tag) return { el: bySelector, confidence: 'path' };

  return { el: null, confidence: 'none' };
}

/** Viewport coordinates for a pin on a resolved element. Null while the element has no box. */
export function pinPoint(anchor: Anchor, el: Element): { x: number; y: number } | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + anchor.fx * rect.width, y: rect.top + anchor.fy * rect.height };
}

/** Viewport coordinates for a pin whose element could not be found: scale the saved document position. */
export function detachedPoint(anchor: Anchor, doc: Document): { x: number; y: number } {
  const win = doc.defaultView!;
  const root = doc.documentElement;
  const sx = anchor.page.docW ? root.scrollWidth / anchor.page.docW : 1;
  const sy = anchor.page.docH ? root.scrollHeight / anchor.page.docH : 1;
  return { x: anchor.page.x * sx - win.scrollX, y: anchor.page.y * sy - win.scrollY };
}
