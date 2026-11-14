// Small pure helpers for reviews: no imports from the app, so they can be unit-tested directly.

/** Refuse obviously internal addresses (localhost, bare IPs, intranet names). */
export function isForbiddenTarget(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return true;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^\[.*\]$/.test(host)) return true; // any IPv6 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true; // any IPv4 literal
  if (!host.includes('.')) return true; // single-label intranet names
  return false;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOKEN = /^[A-Za-z0-9_-]{32,100}$/;

// What someone types to start a review: "example.com", "https://example.com/about". Gives back the site's origin and the
// page to open first, or a plain-words problem. Addresses on private networks are refused.
export function parseSite(raw: string): { ok: true; origin: string; startPath: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Enter the address of the website." };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { ok: false, error: "That doesn’t look like a web address." }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Use an address that starts with http or https." };
  if (url.username || url.password) return { ok: false, error: "Leave any username and password out of the address." };
  if (isForbiddenTarget(url.origin)) return { ok: false, error: "That address can’t be reviewed. Use the public address of the website." };
  const startPath = (url.pathname + url.search) || "/";
  return { ok: true, origin: url.origin, startPath: startPath.length <= 1000 ? startPath : "/" };
}



// A comment's page must belong to the site being reviewed (or one of its alias hosts), so a crafted request cannot attach
// a comment to some other address.
export function pageBelongsToSite(pageUrl: string, siteOrigin: string, aliasHosts: string[] = []): boolean {
  try {
    const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
    const page = new URL(pageUrl), site = new URL(siteOrigin);
    if (page.protocol !== "https:" && page.protocol !== "http:") return false;
    return [site.hostname, ...aliasHosts].some((h) => bare(h) === bare(page.hostname));
  } catch { return false; }
}

export const cleanName = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

// The viewport names the screen uses, and what is stored.
export const VIEWPORT_NAMES = ["Desktop", "Tablet", "Phone"] as const;
export const toDbViewport = (name: string) => (name === "Phone" ? "phone" : name === "Tablet" ? "tablet" : "desktop");
export const fromDbViewport = (v: string) => (v === "phone" ? "Phone" : v === "tablet" ? "Tablet" : "Desktop");


/** Private storage bucket for the pictures taken around each comment's click. */
export const SNAPSHOT_BUCKET = "review-snapshots";
/** Pictures commenters attach to their comments. Private; served through signed links. */
export const ATTACHMENT_BUCKET = "review-attachments";

// Pins keep the address they were made on. When the review has since moved to a new address (the site went live on its
// real domain), show them on the current one: pages are matched by path, so every pin finds its page again.
export function onCurrentSite(pageUrl: string, siteOrigin: string): string {
  try {
    const page = new URL(pageUrl), site = new URL(siteOrigin);
    return page.origin === site.origin ? pageUrl : site.origin + page.pathname + page.search + page.hash;
  } catch { return pageUrl; }
}

// The link for pages behind a login: the real site, with the share code the on-site loader picks up.
export function onsiteLink(siteOrigin: string, startPath: string, token: string): string {
  const path = startPath || "/";
  return `${siteOrigin}${path}${path.includes("?") ? "&" : "?"}openmarkup=${token}`;
}

