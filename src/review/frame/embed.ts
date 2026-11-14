/**
 * The OpenMarkup script. A site adds one line to its <head>:
 *   <script src="https://YOUR-OPENMARKUP-APP/review-assets/openmarkup.js" async></script>
 * It does nothing for normal visitors. It wakes up in two cases:
 *  1. The page is shown inside the OpenMarkup review screen (an iframe): it loads the comment layer, which talks only to
 *     the OpenMarkup app this file came from.
 *  2. The page is opened from a review link (?openmarkup=<share code>): it keeps the code for this tab (so it survives the
 *     site's own login redirect), adds the floating review panel, and starts the comment layer on the real page. This is
 *     how pages behind a login are reviewed. No login is shared.
 */
import type { FrameBootConfig } from '../shared/protocol.ts';

const KEY = 'openmarkup-token';
const PARAM = 'openmarkup';
const TOKEN = /^[A-Za-z0-9_-]{32,100}$/;

interface W extends Window { __OPENMARKUP__?: FrameBootConfig; __OPENMARKUP_ONSITE__?: boolean }
const w = window as W;

// Where this file was served from: the app's origin, and the folder holding widget.js next to it.
const ME = (document.currentScript as HTMLScriptElement | null)?.src ?? '';
function appOrigin(): string {
  try { return new URL(ME).origin; } catch { return ''; }
}
function assetBase(): string {
  try { return new URL('.', ME).href; } catch { return ''; }
}
function loadWidget(): void {
  const s = document.createElement('script');
  s.src = assetBase() + 'widget.js';
  s.async = true;
  document.head.append(s);
}

function token(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get(PARAM);
  try {
    if (fromUrl === 'off') { sessionStorage.removeItem(KEY); }
    else if (fromUrl && TOKEN.test(fromUrl)) sessionStorage.setItem(KEY, fromUrl);
  } catch { /* storage blocked: the link still works on this page */ }
  if (fromUrl) { url.searchParams.delete(PARAM); history.replaceState(history.state, '', url.toString()); }
  if (fromUrl && TOKEN.test(fromUrl)) return fromUrl;
  // On a login page the code is usually tucked inside the return address (?next=/admin%3Fopenmarkup%3D...). Keep it, so the
  // review still opens even if the app drops that address after login.
  let nested: string | undefined;
  try { nested = decodeURIComponent(location.search).match(/[?&]openmarkup=([A-Za-z0-9_-]{32,100})/)?.[1]; } catch { /* bad encoding */ }
  if (nested) { try { sessionStorage.setItem(KEY, nested); } catch { /* ignore */ } return nested; }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

function viewportName(): string {
  const width = window.innerWidth;
  return width < 600 ? 'Phone' : width < 1000 ? 'Tablet' : 'Desktop';
}

const POS_KEY = 'openmarkup-dock-pos';

function start(app: string, code: string): void {
  if (w.__OPENMARKUP_ONSITE__ || w.parent !== w) return; // never inside another frame, never twice
  w.__OPENMARKUP_ONSITE__ = true;

  // A floating card: a grip bar to drag it by, and the OpenMarkup panel below. Starts bottom-right, clear of the site's top
  // navigation and login link; wherever it is dragged to is remembered for this tab.
  const box = document.createElement('div');
  const grip = document.createElement('div');
  const dock = document.createElement('iframe');
  dock.title = 'Review comments';
  dock.src = `${app}/live/${code}/dock?vp=${viewportName()}`;
  dock.setAttribute('allow', 'clipboard-write');
  grip.title = 'Drag to move';
  grip.setAttribute('aria-label', 'Drag to move the review panel');
  grip.innerHTML = '<svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="2" r="1.6"/><circle cx="10" cy="2" r="1.6"/><circle cx="16" cy="2" r="1.6"/><circle cx="22" cy="2" r="1.6"/><circle cx="4" cy="6" r="1.6"/><circle cx="10" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/><circle cx="22" cy="6" r="1.6"/></g></svg>';
  grip.style.cssText = 'height:22px;display:flex;align-items:center;justify-content:center;cursor:grab;color:#71888f;background:#eaeff1;touch-action:none;user-select:none;';
  dock.style.cssText = 'display:block;width:100%;border:0;flex:1;background:#f4f7f8;';
  box.append(grip, dock);

  let collapsed = false;
  let pos: { x: number; y: number } | null = null;
  try { pos = JSON.parse(sessionStorage.getItem(POS_KEY) ?? 'null'); } catch { pos = null; }
  const size = () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (collapsed) return { w: 240, h: 22 + 56 };
    const w0 = vw < 600 ? vw - 16 : 380;
    return { w: w0, h: Math.min(720, Math.max(320, vh - 120)) };
  };
  const place = () => {
    const { w: bw, h: bh } = size();
    const vw = window.innerWidth, vh = window.innerHeight;
    const x = Math.min(Math.max(8, pos ? pos.x : vw - bw - 16), Math.max(8, vw - bw - 8));
    const y = Math.min(Math.max(8, pos ? pos.y : vh - bh - 16), Math.max(8, vh - bh - 8));
    box.style.cssText = `position:fixed;z-index:2147483646;left:${x}px;top:${y}px;width:${bw}px;height:${bh}px;display:flex;flex-direction:column;border-radius:11px;overflow:hidden;background:#f4f7f8;box-shadow:0 0 0 1px rgba(23,72,82,.13),0 12px 36px rgba(0,0,0,.28);`;
  };
  place();
  window.addEventListener('resize', place);

  // Drag by the grip. The iframe would swallow pointer moves, so it stops listening while dragging.
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    grip.setPointerCapture(e.pointerId);
    grip.style.cursor = 'grabbing';
    dock.style.pointerEvents = 'none';
    const move = (m: PointerEvent) => { pos = { x: m.clientX - dx, y: m.clientY - dy }; place(); };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.style.cursor = 'grab';
      dock.style.pointerEvents = '';
      try { sessionStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });

  // The dock asks to shrink or grow, or to stop; nothing else is accepted from it here.
  window.addEventListener('message', (e) => {
    if (e.origin !== app || e.source !== dock.contentWindow) return;
    const d = e.data as { channel?: string; type?: string; collapsed?: boolean };
    if (d?.channel !== 'openmarkup-dock') return;
    if (d.type === 'dock:size') {
      const was = size();
      collapsed = Boolean(d.collapsed);
      if (pos) pos = { x: pos.x + was.w - size().w, y: pos.y + was.h - size().h }; // keep the bottom-right corner where it was
      place();
    }
    if (d.type === 'dock:close') {
      try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(POS_KEY); } catch { /* ignore */ }
      location.reload();
    }
  });
  document.documentElement.append(box);
  w.__OPENMARKUP__ = { appOrigin: app, frameOrigin: location.origin, targetOrigin: location.origin, hostFrame: dock };
  loadWidget();
}

// Case 1: inside the review screen's frame.
function framed(app: string): void {
  if (w.__OPENMARKUP__) return;
  w.__OPENMARKUP__ = { appOrigin: app, frameOrigin: location.origin, targetOrigin: location.origin };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadWidget); else loadWidget();
}

const app = appOrigin();
const code = w.parent === w ? token() : null;
if (!app) { /* loaded in a way we can't trace back to the app: do nothing */ }
else if (w.parent !== w) framed(app);
else if (code && TOKEN.test(code)) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(app, code)); else start(app, code);
}
