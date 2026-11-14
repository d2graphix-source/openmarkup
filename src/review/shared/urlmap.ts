/**
 * URL helpers shared by the app and the in-page widget: which URLs belong to the
 * reviewed site, and the page key comments are matched by. The frame origin and the
 * target origin are the same site, so the mapping functions return URLs unchanged
 * there; they stay general so a different serving origin would still work.
 */

export interface UrlMapConfig {
  frameOrigin: string;
  targetOrigin: string;
  /** Additional hostnames treated as the target (e.g. a bare/www twin). */
  aliasHosts?: string[];
}

/** URLs that are never network locations on the target and must be left alone. */
const NON_NAVIGABLE = /^\s*(?:#|javascript:|mailto:|tel:|sms:|data:|blob:|about:|chrome:|intent:)/i;

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** True when `url` points at the client's site (ignoring a www. difference and http/https). */
export function isTargetUrl(url: URL, cfg: UrlMapConfig): boolean {
  if (!/^(?:https?|wss?):$/.test(url.protocol)) return false;
  const target = new URL(cfg.targetOrigin);
  // Compare port as well: default ports normalise to '' on both sides.
  if (url.port !== target.port) return false;
  const host = bareHost(url.hostname);
  if (host === bareHost(target.hostname)) return true;
  return (cfg.aliasHosts ?? []).some((h) => bareHost(h) === host);
}

/**
 * Map a URL found in the page to where the browser should actually request it.
 *
 *  - not a network URL (fragment, mailto:, data:, ...)  -> unchanged
 *  - relative, or already on the proxy                  -> unchanged (it resolves to the proxy by itself)
 *  - absolute on the target site                        -> same path on the proxy
 *  - absolute on any other site                         -> unchanged (third parties load directly)
 *
 * `base` is the document's base URL; it only matters for deciding what a
 * relative or protocol-relative URL resolves to.
 */
export function toProxyUrl(raw: string, cfg: UrlMapConfig, base?: string): string {
  if (!raw || NON_NAVIGABLE.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw.trim(), base ?? cfg.frameOrigin + '/');
  } catch {
    return raw;
  }
  if (!isTargetUrl(url, cfg)) return raw;
  const proxy = new URL(cfg.frameOrigin);
  const isSocket = url.protocol === 'ws:' || url.protocol === 'wss:';
  const scheme = isSocket ? (proxy.protocol === 'https:' ? 'wss:' : 'ws:') : proxy.protocol;
  return `${scheme}//${proxy.host}${url.pathname}${url.search}${url.hash}`;
}

/** Inverse of `toProxyUrl` for a URL on the proxy. Anything else is returned unchanged. */
export function toTargetUrl(raw: string, cfg: UrlMapConfig): string {
  let url: URL;
  try {
    url = new URL(raw, cfg.frameOrigin + '/');
  } catch {
    return raw;
  }
  if (url.origin !== new URL(cfg.frameOrigin).origin) return raw;
  return `${new URL(cfg.targetOrigin).origin}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Identity of a page for matching comments to it: path without a trailing
 * slash, plus the query string. The fragment is ignored. Two URLs with the same
 * key show the same set of pins.
 */
export function pageKey(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://x/');
  } catch {
    return rawUrl;
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  return path + url.search;
}

/** Rewrite each candidate in a `srcset` / `imagesrcset` value. */
export function rewriteSrcset(value: string, cfg: UrlMapConfig, base?: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const space = trimmed.search(/\s/);
      const url = space === -1 ? trimmed : trimmed.slice(0, space);
      const descriptor = space === -1 ? '' : trimmed.slice(space);
      return toProxyUrl(url, cfg, base) + descriptor;
    })
    .join(', ');
}

/** Rewrite `url(...)` and string `@import` targets inside CSS text. */
export function rewriteCss(css: string, cfg: UrlMapConfig, base?: string): string {
  const urlFn = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;
  const importStr = /(@import\s+)(?:"([^"]+)"|'([^']+)')/gi;
  return css
    .replace(urlFn, (whole, dq, sq, bare) => {
      const original: string = dq ?? sq ?? bare ?? '';
      const mapped = toProxyUrl(original, cfg, base);
      if (mapped === original) return whole;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      return `url(${quote}${mapped}${quote})`;
    })
    .replace(importStr, (whole, head, dq, sq) => {
      const original: string = dq ?? sq ?? '';
      const mapped = toProxyUrl(original, cfg, base);
      return mapped === original ? whole : `${head}"${mapped}"`;
    });
}

/**
 * Replace the target origin wherever it appears as a literal inside inline
 * script text, in both plain and JSON-escaped (`https:\/\/`) spellings.
 * Deliberately string-based: script text cannot be parsed for URLs reliably.
 */
export function rewriteOriginLiterals(text: string, cfg: UrlMapConfig): string {
  const target = new URL(cfg.targetOrigin);
  const proxy = new URL(cfg.frameOrigin);
  const hosts = new Set<string>([target.host]);
  const bare = target.host.replace(/^www\./i, '');
  hosts.add(bare);
  hosts.add('www.' + bare);
  for (const h of cfg.aliasHosts ?? []) hosts.add(h);
  let out = text;
  for (const host of hosts) {
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Host must end at a boundary so "site.com" does not match "site.com.evil.io".
    const plain = new RegExp(`https?://${escaped}(?![\\w.-])`, 'gi');
    const jsonEscaped = new RegExp(`https?:\\\\/\\\\/${escaped}(?![\\w.-])`, 'gi');
    out = out.replace(plain, proxy.origin).replace(jsonEscaped, proxy.origin.replace(/\//g, '\\/'));
  }
  return out;
}
