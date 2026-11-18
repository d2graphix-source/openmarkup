/**
 * The review layer that runs inside the reviewed page: hover outline, comment
 * composer, pins and thread popovers.
 *
 * It owns no data. It tells the host what the reviewer did and renders
 * whatever threads the host sends back. All UI lives in a shadow root
 * so the client's CSS cannot restyle it and ours cannot leak into the page.
 *
 * No framework: the surface is small, and a dependency-free file keeps the
 * script that runs on client sites light.
 *
 * Built to a single IIFE file by scripts/build-review.mjs.
 */

import {
  MAX_IMAGES,
  MAX_IMAGE_CHARS,
  PROTOCOL_VERSION,
  isEnvelope,
  wrap,
  type Anchor,
  type FrameBootConfig,
  type FrameMessage,
  type HostMessage,
  type ReviewComment,
  type ReviewMode,
  type ReviewThread,
  type ReviewUser,
} from '../shared/protocol.ts';
import { pageKey, toProxyUrl, toTargetUrl } from '../shared/urlmap.ts';
import { buildAnchor, detachedPoint, pinPoint, resolveAnchor, type Confidence } from './anchor.ts';

const HOST_TAG = 'openmarkup-layer';
const PENDING_FOCUS_KEY = 'openmarkup:focus';
const RERESOLVE_DEBOUNCE_MS = 200;

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
.layer { position: fixed; inset: 0; pointer-events: none; }
.outline { position: fixed; border: 2px solid #10a094; background: rgba(16,160,148,.08); border-radius: 2px; display: none; }
.outline span { position: absolute; left: -2px; top: -20px; background: #10a094; color: #fff; font-size: 11px; line-height: 18px; padding: 0 6px; border-radius: 2px 2px 0 0; white-space: nowrap; }
.pin { position: fixed; left: 0; top: 0; width: 28px; height: 28px; margin: -28px 0 0 0; border: 2px solid #fff; border-radius: 50% 50% 50% 0; background: #10a094; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; pointer-events: auto; box-shadow: 0 1px 4px rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; padding: 0; will-change: transform; }
.pin.resolved { background: #10a094; }
.pin.pending { background: #71888f; }
.pin.approx { border-style: dashed; }
.pin.detached { background: #c9842e; border-style: dashed; }
.panel { position: fixed; width: min(320px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 16px)); overflow: auto; background: #fff; color: #0d1a1f; border: 1px solid rgba(23,72,82,.26); border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.22); pointer-events: auto; font-size: 14px; line-height: 1.4; }
.panel header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(23,72,82,.13); font-weight: 600; }
.panel .note { padding: 6px 12px; background: #fffbeb; color: #92400e; font-size: 12px; border-bottom: 1px solid #fde68a; }
.comment { padding: 8px 12px; border-bottom: 1px solid #eaeff1; }
.comment .who { font-size: 12px; color: #71888f; margin-bottom: 2px; }
.comment .body { white-space: pre-wrap; overflow-wrap: anywhere; }
form { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; margin: 0; }
textarea { width: 100%; min-height: 64px; resize: vertical; border: 1px solid rgba(23,72,82,.26); border-radius: 6px; padding: 8px; font-size: 14px; color: #0d1a1f; background: #fff; }
textarea:focus { outline: 2px solid #10a094; outline-offset: 0; }
.row { display: flex; justify-content: flex-end; gap: 8px; }
button.btn { border: 1px solid rgba(23,72,82,.26); background: #fff; color: #0d1a1f; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
button.btn.primary { background: #10a094; border-color: #10a094; color: #fff; }
button.btn:disabled { opacity: .5; cursor: default; }
.comment .edited { color: #71888f; }
.comment .acts { display: flex; gap: 10px; margin-top: 4px; }
button.link { border: 0; background: none; padding: 0; font-size: 12px; color: #71888f; cursor: pointer; text-decoration: underline; }
button.link.danger { color: #e0656f; }
.pics { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.pics a, .pics .thumb { position: relative; display: block; width: 64px; height: 64px; border-radius: 6px; overflow: hidden; border: 1px solid rgba(23,72,82,.13); background: #f7fafb; }
.pics img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pics .thumb button { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; border: 0; border-radius: 50%; background: rgba(13,26,31,.75); color: #fff; font-size: 12px; line-height: 20px; padding: 0; cursor: pointer; }
.row.split { justify-content: space-between; align-items: center; }
.row .end { display: flex; gap: 8px; }
.hint { font-size: 12px; color: #71888f; }
.comment form { padding: 6px 0 0; }
`;

interface PinState {
  thread: ReviewThread;
  el: Element | null;
  confidence: Confidence;
  node: HTMLButtonElement;
  x: number;
  y: number;
}

interface PendingPin {
  tempId: string;
  anchor: Anchor;
  el: Element;
  node: HTMLButtonElement;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent only: comment bodies are untrusted
  return node;
}

/** snap.js sits next to this script wherever it was served from (the app). */
const SNAP_SRC = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  return src && /widget\.js(\?.*)?$/.test(src) ? src.replace(/widget\.js(\?.*)?$/, 'snap.js') : null;
})();

class ReviewLayer {
  private mode: ReviewMode = 'browse';
  private readOnly = true;
  private user: ReviewUser | null = null;
  /** True while an edit box is open or a reply has been typed in the open panel. */
  private drafting = false;
  private threads: ReviewThread[] = [];
  private pins = new Map<string, PinState>();
  private pending = new Map<string, PendingPin>();
  private openThreadId: string | null = null;
  private composer: { anchor: Anchor; el: Element; panel: HTMLElement } | null = null;
  private threadPanel: HTMLElement | null = null;
  private lastMissing = '';
  private lastReportedUrl = '';
  private frameHandle = 0;
  private reresolveTimer = 0;

  private readonly host: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly outline: HTMLElement;
  private readonly outlineLabel: HTMLElement;

  constructor(private readonly cfg: FrameBootConfig) {
    this.host = document.createElement(HOST_TAG);
    this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:none;';
    // Open rather than closed: a closed root would not stop a hostile page (it can
    // patch attachShadow before we run), and open lets end-to-end tests see the UI.
    // The security boundary is that this layer holds no credentials, not the shadow mode.
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.layer = h('div', 'layer');
    this.outline = h('div', 'outline');
    this.outlineLabel = h('span');
    this.outline.append(this.outlineLabel);
    this.layer.append(this.outline);
    root.append(style, this.layer);
  }

  start(): void {
    this.mount();
    window.addEventListener('message', (event) => this.onMessage(event));

    // Capture phase on window: we see events before any handler on the page does.
    const capture = { capture: true } as const;
    window.addEventListener('click', (e) => this.onClick(e), capture);
    window.addEventListener('mousemove', (e) => this.onMove(e), { capture: true, passive: true });
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'auxclick', 'contextmenu', 'submit']) {
      window.addEventListener(type, (e) => this.swallow(e), capture);
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (this.composer || this.threadPanel)) {
        this.closeComposer();
        this.closeThread();
      }
    }, capture);

    this.watchUrl();
    this.watchDom();
    this.post({ type: 'frame:ready', v: PROTOCOL_VERSION });
    if (this.cfg.hostFrame) {
      // On-site mode: the dock may still be loading and miss the first hello, so repeat it until the dock answers.
      let tries = 0;
      this.helloTimer = setInterval(() => {
        if (++tries > 60) return clearInterval(this.helloTimer);
        this.post({ type: 'frame:ready', v: PROTOCOL_VERSION });
        this.reportUrl();
      }, 500);
    }
    this.reportUrl();
  }

  // --- wiring ---------------------------------------------------------------

  /** (Re)attach our host element. Sites sometimes replace <body> wholesale. */
  private mount(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  /** Who we report to: the review screen around us, or (on-site mode) the dock frame inside this page. */
  private hostWindow(): Window | null {
    return this.cfg.hostFrame ? this.cfg.hostFrame.contentWindow : window.parent;
  }

  private helloTimer: ReturnType<typeof setInterval> | undefined;

  private post(message: FrameMessage): void {
    this.hostWindow()?.postMessage(wrap(message), this.cfg.appOrigin);
  }

  private onMessage(event: MessageEvent): void {
    if (event.origin !== this.cfg.appOrigin || !event.source || event.source !== this.hostWindow()) return;
    if (!isEnvelope(event.data)) return;
    const msg = event.data as unknown as HostMessage;
    switch (msg.type) {
      case 'host:init':
        clearInterval(this.helloTimer);
        this.user = msg.user;
        this.readOnly = msg.readOnly;
        this.setThreads(msg.threads);
        this.setMode(msg.mode);
        this.resumeFocus();
        break;
      case 'host:ping':
        this.post({ type: 'frame:ready', v: PROTOCOL_VERSION });
        this.reportUrl();
        break;
      case 'host:mode':
        this.setMode(msg.mode);
        break;
      case 'host:readonly':
        this.readOnly = msg.readOnly;
        if (this.readOnly) this.closeComposer();
        if (this.openThreadId && this.pins.has(this.openThreadId)) this.openThread(this.openThreadId); // show or hide its Reply and Edit
        break;
      case 'host:threads':
        if (msg.settledTempId) this.dropPending(msg.settledTempId);
        this.setThreads(msg.threads);
        break;
      case 'host:focus':
        this.focusThread(msg.threadId, msg.pageUrl);
        break;
    }
  }

  private isOurs(event: Event): boolean {
    const path = event.composedPath();
    // On-site mode: the review dock (and its drag bar) is ours too, never part of the page under review.
    const dock = this.cfg.hostFrame?.parentElement ?? this.cfg.hostFrame;
    return path.includes(this.host) || (!!dock && path.includes(dock));
  }

  private get commenting(): boolean {
    return this.mode === 'comment';
  }

  // --- URL tracking ---------------------------------------------------------

  private currentPageUrl(): string {
    return toTargetUrl(location.href, this.cfg);
  }

  private reportUrl(): void {
    const pageUrl = this.currentPageUrl();
    if (pageUrl === this.lastReportedUrl) return;
    const changedPage = pageKey(pageUrl) !== pageKey(this.lastReportedUrl || pageUrl);
    this.lastReportedUrl = pageUrl;
    this.post({ type: 'frame:url', pageUrl, pageKey: pageKey(pageUrl), title: document.title });
    if (changedPage) {
      this.closeComposer();
      this.closeThread();
      this.rebuildPins();
    }
  }

  /** Single-page apps change the URL without loading a document. */
  private watchUrl(): void {
    const notify = () => queueMicrotask(() => this.reportUrl());
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }
    window.addEventListener('popstate', notify);
    window.addEventListener('hashchange', notify);
  }

  // --- mode -----------------------------------------------------------------

  private setMode(mode: ReviewMode): void {
    this.mode = mode;
    this.host.style.display = mode === 'comment' ? 'block' : 'none';
    if (mode === 'browse') {
      this.closeComposer();
      this.closeThread();
      this.outline.style.display = 'none';
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    } else {
      this.mount();
      this.rebuildPins();
      this.loop();
    }
  }

  // --- page interaction -----------------------------------------------------

  /** In comment mode the page must not react to the reviewer's pointer. */
  private swallow(event: Event): void {
    if (!this.commenting || this.isOurs(event)) return;
    event.stopImmediatePropagation();
    if (event.type === 'submit' || event.type === 'contextmenu' || event.type === 'auxclick') event.preventDefault();
  }

  private onMove(event: MouseEvent): void {
    if (!this.commenting || this.readOnly || this.composer || this.isOurs(event)) {
      this.outline.style.display = 'none';
      return;
    }
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === this.host) {
      this.outline.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    const s = this.outline.style;
    s.display = 'block';
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.outlineLabel.textContent = el.localName;
  }

  private onClick(event: MouseEvent): void {
    if (!this.commenting || this.isOurs(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.composer || this.threadPanel) {
      // A click on the page while something is open just dismisses it.
      this.closeComposer();
      this.closeThread();
      return;
    }
    if (this.readOnly) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === this.host) return;
    this.openComposer(el, event.clientX, event.clientY);
  }

  // --- composer -------------------------------------------------------------

  private openComposer(el: Element, clientX: number, clientY: number): void {
    const anchor = buildAnchor(el, clientX, clientY);
    const panel = h('div', 'panel');
    const form = h('form');
    const input = h('textarea');
    input.placeholder = 'Add a comment';
    input.setAttribute('aria-label', 'Comment');
    const row = h('div', 'row split');
    const end = h('div', 'end');
    const cancel = h('button', 'btn', 'Cancel');
    cancel.type = 'button';
    const submit = h('button', 'btn primary', 'Post');
    submit.type = 'submit';
    submit.disabled = true;
    const pics = this.attacher(input, () => (submit.disabled = !input.value.trim() && !pics.images.length));
    end.append(cancel, submit);
    row.append(pics.button, end);
    form.append(input, pics.tray, row);
    panel.append(form);
    this.layer.append(panel);
    this.place(panel, clientX, clientY);
    this.outline.style.display = 'none';

    input.addEventListener('input', () => (submit.disabled = !input.value.trim() && !pics.images.length));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !submit.disabled) form.requestSubmit();
    });
    cancel.addEventListener('click', () => this.closeComposer());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = input.value.trim();
      const images = pics.images.slice();
      if (!body && !images.length) return;
      const tempId = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const pageUrl = this.currentPageUrl();
      this.addPending(tempId, anchor, el);
      this.closeComposer();
      // No automatic screenshot: redrawing a big page builder in the browser lags and often comes out blank.
      // People paste or attach their own picture instead (Win+Shift+S, then Ctrl+V into the box).
      this.post({ type: 'thread:create', draft: { tempId, pageUrl, pageKey: pageKey(pageUrl), anchor, body, images } });
    });

    this.composer = { anchor, el, panel };
    this.post({ type: 'frame:composing', active: true });
    input.focus({ preventScroll: true });
  }

  /**
   * A picture of the screen around the click (480x300 CSS px, click centred, red ring), drawn from the page itself. Loads the
   * drawing code from the app only when needed. Gives up quietly after 6 seconds or on any error: the comment still saves.
   */
  private snapshot(clientX: number, clientY: number): Promise<string | undefined> {
    const W = 480, H = 300;
    const work = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      const g = window as unknown as { __OPENMARKUP_SNAP__?: (n: Node, o: object) => Promise<HTMLCanvasElement> };
      if (!g.__OPENMARKUP_SNAP__) {
        await new Promise<void>((ok, bad) => {
          const s = document.createElement('script');
          s.src = SNAP_SRC ?? this.cfg.appOrigin + '/review-assets/snap.js';
          s.onload = () => ok();
          s.onerror = () => bad(new Error('snap'));
          document.head.append(s);
        });
      }
      const vw = window.innerWidth, vh = window.innerHeight;
      // Big page builders can have thousands of elements: copying them all freezes the page. Only copy what is on screen,
      // skip embedded media, and don't download web fonts (the picture is a rough guide, not a pixel-perfect copy).
      const skip = new Set(['SCRIPT', 'NOSCRIPT', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'TEMPLATE']);
      const keep = (n: Node): boolean => {
        if (n === this.host) return false;
        if (!(n instanceof Element)) return true;
        if (skip.has(n.tagName)) return false;
        const r = n.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return true;
        return !(r.bottom < -40 || r.top > vh + 40 || r.right < -40 || r.left > vw + 40);
      };
      const full = await g.__OPENMARKUP_SNAP__!(document.documentElement, {
        width: vw, height: vh, scale: 1, backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff',
        filter: keep, font: false, timeout: 3000,
        // The copy restarts CSS animations from their first frame, so fade-in sections would come out invisible
        // (a blank, dark picture). Freeze them at the state copied from the page.
        onCreateForeignObjectSvg: (svg: SVGSVGElement) => {
          const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
          st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
          svg.prepend(st);
        },
        style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)` },
      });
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const ctx = out.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      const sx = Math.max(0, Math.min(clientX - W / 2, vw - W)), sy = Math.max(0, Math.min(clientY - H / 2, vh - H));
      ctx.drawImage(full, sx, sy, W, H, 0, 0, W, H);
      ctx.strokeStyle = '#e5322d'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(clientX - sx, clientY - sy, 18, 0, Math.PI * 2); ctx.stroke();
      return out.toDataURL('image/jpeg', 0.72);
    })().catch(() => undefined);
    return Promise.race([work, new Promise<undefined>((r) => setTimeout(() => r(undefined), 6000))]);
  }

  private closeComposer(): void {
    if (!this.composer) return;
    this.composer.panel.remove();
    this.composer = null;
    this.post({ type: 'frame:composing', active: false });
  }

  /** Keep a floating panel fully inside the viewport, next to the point it belongs to. */
  private place(panel: HTMLElement, x: number, y: number): void {
    const margin = 8;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    let left = x + 14;
    if (left + width > window.innerWidth - margin) left = x - width - 14;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - height - margin));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  // --- pins -----------------------------------------------------------------

  private setThreads(threads: ReviewThread[]): void {
    this.threads = threads;
    this.rebuildPins();
    if (this.openThreadId) {
      // Someone is typing in the open panel: keep it as it is so the 15-second refresh doesn't throw their words away.
      if (this.pins.has(this.openThreadId)) { if (!this.drafting) this.openThread(this.openThreadId); }
      else this.closeThread();
    }
  }

  private addPending(tempId: string, anchor: Anchor, el: Element): void {
    const node = h('button', 'pin pending', '…');
    node.type = 'button';
    node.title = 'Saving';
    this.layer.append(node);
    this.pending.set(tempId, { tempId, anchor, el, node });
  }

  private dropPending(tempId: string): void {
    this.pending.get(tempId)?.node.remove();
    this.pending.delete(tempId);
  }

  /** Recreate pin elements for the threads that belong to the current page. */
  private rebuildPins(): void {
    for (const pin of this.pins.values()) pin.node.remove();
    this.pins.clear();
    const key = pageKey(this.currentPageUrl());
    let number = 0;
    for (const thread of this.threads) {
      number++;
      if (thread.pageKey !== key) continue;
      const node = h('button', 'pin', String(number));
      node.type = 'button';
      node.dataset.threadId = thread.id;
      node.addEventListener('click', () => (this.openThreadId === thread.id ? this.closeThread() : this.openThread(thread.id)));
      this.layer.append(node);
      this.pins.set(thread.id, { thread, el: null, confidence: 'none', node, x: NaN, y: NaN });
    }
    this.resolveAll();
  }

  /** The expensive step: find each pin's element. Run on load and after DOM changes, not per frame. */
  private resolveAll(): void {
    const missing: string[] = [];
    for (const pin of this.pins.values()) {
      const result = resolveAnchor(pin.thread.anchor, document);
      pin.el = result.el;
      pin.confidence = result.confidence;
      if (!result.el) missing.push(pin.thread.id);
      const label = pin.thread.comments[0]?.body.slice(0, 80) ?? '';
      pin.node.className =
        'pin' +
        (pin.thread.resolved ? ' resolved' : '') +
        (result.confidence === 'none' ? ' detached' : result.confidence === 'exact' ? '' : ' approx');
      pin.node.title = result.el ? label : `${label}\n(The element this was pinned to is no longer on the page.)`;
    }
    const signature = missing.join(',');
    if (signature !== this.lastMissing) {
      this.lastMissing = signature;
      this.post({ type: 'anchors:missing', threadIds: missing });
    }
    this.positionPins();
  }

  /**
   * The cheap step, run every animation frame while commenting: read each
   * pinned element's box and move the pin if it changed. Polling per frame is
   * what keeps pins glued to elements that move for reasons no observer
   * reports: CSS animations, transforms, sticky headers, carousels.
   */
  private positionPins(): void {
    const move = (node: HTMLElement, point: { x: number; y: number } | null, prev: { x: number; y: number }) => {
      if (!point) {
        if (node.style.visibility !== 'hidden') node.style.visibility = 'hidden';
        return prev;
      }
      if (point.x !== prev.x || point.y !== prev.y) {
        node.style.transform = `translate(${point.x}px, ${point.y}px)`;
        if (node.style.visibility) node.style.visibility = '';
      }
      return point;
    };
    for (const pin of this.pins.values()) {
      if (pin.el && !pin.el.isConnected) pin.el = null; // re-resolved on the next DOM pass
      const point = pin.el ? pinPoint(pin.thread.anchor, pin.el) : detachedPoint(pin.thread.anchor, document);
      const next = move(pin.node, point, pin);
      pin.x = next.x;
      pin.y = next.y;
    }
    for (const pending of this.pending.values()) {
      const point = pending.el.isConnected ? pinPoint(pending.anchor, pending.el) : null;
      move(pending.node, point, { x: NaN, y: NaN });
    }
  }

  private loop(): void {
    cancelAnimationFrame(this.frameHandle);
    const tick = () => {
      if (!this.commenting) return;
      if (this.pins.size || this.pending.size) this.positionPins();
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  /** Structure changes can break or repair anchors, so re-resolve, but not on every keystroke of a mutation storm. */
  private watchDom(): void {
    const observer = new MutationObserver((records) => {
      if (records.every((r) => this.host.contains(r.target) || r.target === this.host)) return;
      this.mount();
      if (!this.commenting) return;
      clearTimeout(this.reresolveTimer);
      this.reresolveTimer = window.setTimeout(() => this.resolveAll(), RERESOLVE_DEBOUNCE_MS);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });
  }

  /**
   * "Add picture" for a comment box: pick files, or paste or drop a picture into the box. Each picture is shrunk in the
   * browser (longest side 1600px, JPEG) so it uploads fast and fits the server's limit.
   */
  private attacher(input: HTMLTextAreaElement, changed: () => void): { button: HTMLElement; tray: HTMLElement; images: string[] } {
    const images: string[] = [];
    const tray = h('div', 'pics');
    tray.style.display = 'none';
    const button = h('button', 'link', 'Add picture');
    button.type = 'button';
    button.title = 'Attach a picture. You can also paste or drop one into the box.';
    const file = h('input');
    file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.style.display = 'none';
    button.append(file);
    const draw = () => {
      tray.replaceChildren();
      images.forEach((src, i) => {
        const t = h('div', 'thumb');
        const img = h('img'); img.src = src; img.alt = `Picture ${i + 1}`;
        const x = h('button', undefined, '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove picture');
        x.addEventListener('click', () => { images.splice(i, 1); draw(); });
        t.append(img, x); tray.append(t);
      });
      tray.style.display = images.length ? 'flex' : 'none';
      button.style.display = images.length >= MAX_IMAGES ? 'none' : '';
      changed();
    };
    const add = async (files: Iterable<File>) => {
      for (const f of files) {
        if (images.length >= MAX_IMAGES) break;
        if (!f.type.startsWith('image/')) continue;
        const src = await shrinkImage(f).catch(() => null);
        if (src) { images.push(src); draw(); }
      }
    };
    button.addEventListener('click', (e) => { if (e.target !== file) file.click(); });
    file.addEventListener('change', () => { void add(Array.from(file.files ?? [])); file.value = ''; });
    input.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); void add(files); }
    });
    input.addEventListener('dragover', (e) => e.preventDefault());
    input.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); void add(files); }
    });
    return { button, tray, images };
  }

  // --- thread popover -------------------------------------------------------

  private openThread(threadId: string): void {
    const pin = this.pins.get(threadId);
    if (!pin) return;
    this.closeComposer();
    this.closeThread();
    this.openThreadId = threadId;
    const { thread } = pin;

    const panel = h('div', 'panel');
    const header = h('header');
    header.append(h('span', undefined, thread.resolved ? 'Resolved' : 'Comment'));
    if (!this.readOnly) {
      const toggle = h('button', 'btn', thread.resolved ? 'Reopen' : 'Resolve');
      toggle.type = 'button';
      toggle.addEventListener('click', () => this.post({ type: 'thread:resolve', threadId, resolved: !thread.resolved }));
      header.append(toggle);
    }
    panel.append(header);
    if (pin.confidence === 'none') panel.append(h('div', 'note', 'The element this was pinned to is no longer on the page.'));
    else if (pin.confidence !== 'exact') panel.append(h('div', 'note', 'The page has changed since this was pinned. Position is approximate.'));

    thread.comments.forEach((comment, i) => panel.append(this.commentItem(threadId, comment, i === 0)));

    if (!this.readOnly) {
      const form = h('form');
      const input = h('textarea');
      input.placeholder = 'Reply';
      input.setAttribute('aria-label', 'Reply');
      const row = h('div', 'row split');
      const send = h('button', 'btn primary', 'Reply');
      send.type = 'submit';
      send.disabled = true;
      const sync = () => { const has = Boolean(input.value.trim()) || pics.images.length > 0; send.disabled = !has; this.drafting = has; };
      const pics = this.attacher(input, sync);
      row.append(pics.button, send);
      form.append(input, pics.tray, row);
      input.addEventListener('input', sync);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const body = input.value.trim();
        const images = pics.images.slice();
        if (!body && !images.length) return;
        send.disabled = true;
        this.drafting = false;
        this.post({ type: 'comment:create', threadId, body, images });
      });
      panel.append(form);
    }

    this.layer.append(panel);
    this.place(panel, Number.isFinite(pin.x) ? pin.x : 40, Number.isFinite(pin.y) ? pin.y : 40);
    this.threadPanel = panel;
  }

  /** One comment, with Edit for its author and Delete for a team member who wrote it. */
  private commentItem(threadId: string, comment: ReviewComment, first: boolean): HTMLElement {
    const item = h('div', 'comment');
    const who = h('div', 'who', comment.authorName);
    if (comment.editedAt) who.append(h('span', 'edited', ' · edited'));
    const body = h('div', 'body', comment.body);
    item.append(who, body);
    if (comment.images?.length) {
      const pics = h('div', 'pics');
      for (const src of comment.images) {
        const a = h('a');
        a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.title = 'Open the full picture';
        const img = h('img'); img.src = src; img.alt = 'Attached picture'; img.loading = 'lazy';
        a.append(img); pics.append(a);
      }
      item.append(pics);
    }
    const canEdit = !this.readOnly && comment.canEdit;
    if (!canEdit && !comment.canDelete) return item;
    const acts = h('div', 'acts');
    if (canEdit) {
      const edit = h('button', 'link', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        const form = h('form');
        const input = h('textarea');
        input.value = comment.body;
        input.setAttribute('aria-label', 'Edit comment');
        const row = h('div', 'row');
        const cancel = h('button', 'btn', 'Cancel');
        cancel.type = 'button';
        const save = h('button', 'btn primary', 'Save');
        save.type = 'submit';
        row.append(cancel, save);
        form.append(input, row);
        input.addEventListener('input', () => (save.disabled = !input.value.trim()));
        cancel.addEventListener('click', () => { this.drafting = false; form.replaceWith(body, acts); });
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          this.drafting = false;
          if (text === comment.body) return form.replaceWith(body, acts);
          save.disabled = true;
          this.post({ type: 'comment:edit', threadId, commentId: comment.id, body: text });
        });
        this.drafting = true;
        body.replaceWith(form);
        acts.remove();
        input.focus();
      });
      acts.append(edit);
    }
    if (comment.canDelete) {
      const del = h('button', 'link danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => {
        // Two clicks, so a slip doesn't lose a comment. The first comment takes its replies with it.
        if (del.dataset.armed) return this.post({ type: 'comment:delete', threadId, commentId: comment.id });
        del.dataset.armed = '1';
        del.textContent = first ? 'Delete the pin and its replies?' : 'Click again to delete';
      });
      acts.append(del);
    }
    item.append(acts);
    return item;
  }

  private closeThread(): void {
    this.drafting = false;
    this.threadPanel?.remove();
    this.threadPanel = null;
    this.openThreadId = null;
  }

  /** Host asked to show a thread. It may live on another page of the site. */
  private focusThread(threadId: string, pageUrl: string): void {
    if (pageKey(pageUrl) !== pageKey(this.currentPageUrl())) {
      try {
        sessionStorage.setItem(PENDING_FOCUS_KEY, threadId);
      } catch {
        /* storage blocked: we still navigate, the thread just won't auto-open */
      }
      location.assign(toProxyUrl(pageUrl, this.cfg));
      return;
    }
    const pin = this.pins.get(threadId);
    if (!pin) return;
    if (pin.el) {
      pin.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else {
      const point = detachedPoint(pin.thread.anchor, document);
      window.scrollBy(0, point.y - window.innerHeight / 2);
    }
    // Wait a frame so the popover is placed from the pin's post-scroll position.
    requestAnimationFrame(() => {
      this.positionPins();
      this.openThread(threadId);
    });
  }

  /** After a cross-page focus, open the thread once the new page has its threads. */
  private resumeFocus(): void {
    let threadId: string | null = null;
    try {
      threadId = sessionStorage.getItem(PENDING_FOCUS_KEY);
      if (threadId) sessionStorage.removeItem(PENDING_FOCUS_KEY);
    } catch {
      return;
    }
    if (threadId && this.pins.has(threadId)) this.focusThread(threadId, this.currentPageUrl());
  }
}

interface BootWindow extends Window {
  __OPENMARKUP__?: FrameBootConfig;
  __OPENMARKUP_WIDGET__?: boolean;
}

const bootWindow = window as BootWindow;
// Only run when framed by the app, or on-site with the dock the on-site loader added.
if (bootWindow.__OPENMARKUP__ && !bootWindow.__OPENMARKUP_WIDGET__ && (window.parent !== window || bootWindow.__OPENMARKUP__.hostFrame)) {
  bootWindow.__OPENMARKUP_WIDGET__ = true;
  new ReviewLayer(bootWindow.__OPENMARKUP__).start();
}

/** A picked or pasted picture as a JPEG data URL, longest side at most 1600px, small enough to upload. */
async function shrinkImage(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    for (const [side, quality] of [[1600, 0.82], [1200, 0.72], [900, 0.65]] as const) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff'; // transparent PNGs get a white background
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/jpeg', quality);
      if (out.length <= MAX_IMAGE_CHARS) return out;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
