/**
 * Message contract between the OpenMarkup app (the "host") and the review layer that
 * runs inside the reviewed page (the "frame").
 *
 * Rules both sides follow:
 *  - Every message carries `channel: CHANNEL` so unrelated postMessage traffic
 *    from the reviewed site is ignored cheaply.
 *  - The frame only posts to, and only accepts from, the app origin.
 *  - The host only accepts from the site origin AND from its own iframe's window.
 *  - The frame never talks to the database. It reports intent; the host persists
 *    and pushes the resulting state back down.
 */

export const CHANNEL = 'openmarkup';
export const PROTOCOL_VERSION = 1;

export type ReviewMode = 'browse' | 'comment';

/** Set on the page by openmarkup.js before the widget loads. */
export interface FrameBootConfig {
  /** Where the page is served from: the site itself. */
  frameOrigin: string;
  /** The real site, e.g. https://client-site.com */
  targetOrigin: string;
  /** Extra hostnames that count as the same site. */
  aliasHosts?: string[];
  /** e.g. https://openmarkup.example.com */
  appOrigin: string;
  /** On-site mode: the OpenMarkup dock frame the widget talks to instead of window.parent. */
  hostFrame?: HTMLIFrameElement;
}

/**
 * Where a comment is pinned. Several independent ways of finding the element
 * again are stored so that one of them survives a layout change.
 */
export interface Anchor {
  /** Shortest selector that was unique when the pin was made. */
  selector: string;
  /** Full structural path from <body>, used when `selector` stops matching. */
  path: string;
  /** Lower-case tag name of the pinned element. */
  tag: string;
  /** First characters of the element's visible text (or alt/src for media). */
  text: string;
  /** Click position inside the element, as a fraction of its box (0..1). */
  fx: number;
  fy: number;
  /** Last-resort position in document pixels, with the document size it was measured against. */
  page: { x: number; y: number; docW: number; docH: number };
  /** Viewport the pin was made in, in CSS pixels. */
  viewport: { w: number; h: number };
}

export interface ReviewComment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  /** Set once the author has changed the words. */
  editedAt?: string | null;
  /** The viewer wrote this comment and may change its words. */
  canEdit?: boolean;
  /** The viewer is on the team and wrote this comment, so may remove it. */
  canDelete?: boolean;
  /** Short-lived links to pictures the commenter attached. */
  images?: string[];
}

export interface ReviewThread {
  id: string;
  /** Real URL of the page on the client's site. */
  pageUrl: string;
  /** Normalised path + query used to match threads to pages. See `pageKey`. */
  pageKey: string;
  /** Name of the viewport preset the thread belongs to. */
  viewport: string;
  anchor: Anchor;
  resolved: boolean;
  createdAt: string;
  /** Short-lived link to the picture of the screen around the click, if one was taken. */
  snapshotUrl?: string | null;
  comments: ReviewComment[];
}

export interface ReviewUser {
  id: string;
  name: string;
  isGuest: boolean;
}

export interface ThreadDraft {
  /** Client-generated id so the frame can match the saved thread to its pending pin. */
  tempId: string;
  pageUrl: string;
  pageKey: string;
  anchor: Anchor;
  body: string;
  /** JPEG data URL of the screen around the click, when the browser could draw one. */
  snapshot?: string;
  /** Pictures the reviewer attached (JPEG data URLs, shrunk in the browser). */
  images?: string[];
}

/** Most pictures one comment can carry, and the largest one we accept (as a data URL). */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_CHARS = 2_000_000;

/** Keeps only well-formed, small-enough JPEG data URLs, at most MAX_IMAGES of them. */
export function cleanImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images
    .filter((s): s is string => typeof s === 'string' && s.startsWith('data:image/jpeg;base64,') && s.length <= MAX_IMAGE_CHARS)
    .slice(0, MAX_IMAGES);
}

/** Frame -> host */
export type FrameMessage =
  | { type: 'frame:ready'; v: number }
  | { type: 'frame:url'; pageUrl: string; pageKey: string; title: string }
  | { type: 'frame:composing'; active: boolean }
  | { type: 'thread:create'; draft: ThreadDraft }
  | { type: 'thread:resolve'; threadId: string; resolved: boolean }
  | { type: 'thread:delete'; threadId: string }
  | { type: 'comment:create'; threadId: string; body: string; images?: string[] }
  | { type: 'comment:edit'; threadId: string; commentId: string; body: string }
  | { type: 'comment:delete'; threadId: string; commentId: string }
  | { type: 'anchors:missing'; threadIds: string[] };

/** Host -> frame */
export type HostMessage =
  /** On-site mode: a (re)started dock asks the page to say hello again so it can send a fresh init. */
  | { type: 'host:ping' }
  | {
      type: 'host:init';
      v: number;
      mode: ReviewMode;
      readOnly: boolean;
      user: ReviewUser | null;
      threads: ReviewThread[];
    }
  | { type: 'host:mode'; mode: ReviewMode }
  | { type: 'host:readonly'; readOnly: boolean }
  | { type: 'host:threads'; threads: ReviewThread[]; settledTempId?: string }
  | { type: 'host:focus'; threadId: string; pageUrl: string };

export type Envelope<T> = T & { channel: typeof CHANNEL };

export function wrap<T extends object>(msg: T): Envelope<T> {
  return { ...msg, channel: CHANNEL };
}

/** Structural check only. Origin and source checks are the caller's job. */
export function isEnvelope(data: unknown): data is Envelope<{ type: string }> {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { channel?: unknown }).channel === CHANNEL &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}
