/**
 * Host-side controller for a review session. Framework-free on purpose: it is
 * given an <iframe> and a data store, and can be driven from React, from a
 * plain page, or from a test.
 *
 * Responsibilities:
 *  - point the iframe at the site and lock it down with `sandbox`
 *  - authenticate every incoming message (origin + source window + channel)
 *  - turn the frame's intents into store calls, then push fresh state back
 *  - filter which threads the frame sees (current viewport preset)
 */

import {
  PROTOCOL_VERSION,
  cleanImages,
  isEnvelope,
  wrap,
  type FrameMessage,
  type HostMessage,
  type ReviewComment,
  type ReviewMode,
  type ReviewThread,
  type ReviewUser,
  type ThreadDraft,
} from '../shared/protocol.ts';
import { pageKey } from '../shared/urlmap.ts';

export interface Viewport {
  name: string;
  /** CSS pixels, or null to fill the available space. */
  width: number | null;
  height: number | null;
}

export const VIEWPORTS: Viewport[] = [
  { name: 'Desktop', width: null, height: null },
  { name: 'Laptop', width: 1280, height: 800 },
  { name: 'Tablet', width: 768, height: 1024 },
  { name: 'Phone', width: 390, height: 844 },
  { name: 'Small phone', width: 360, height: 740 },
];

/** Persistence boundary. `supabaseStore.ts` and `memoryStore.ts` implement it. */
export interface ThreadStore {
  listThreads(): Promise<ReviewThread[]>;
  createThread(input: { draft: ThreadDraft; viewport: string; author: ReviewUser }): Promise<ReviewThread>;
  addComment(input: { threadId: string; body: string; images?: string[]; author: ReviewUser }): Promise<ReviewComment>;
  setResolved(threadId: string, resolved: boolean): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  editComment(input: { threadId: string; commentId: string; body: string }): Promise<{ editedAt: string }>;
  /** Returns true when the whole thread went with it (it was the first comment). */
  deleteComment(input: { threadId: string; commentId: string }): Promise<{ thread: boolean }>;
  /** Optional live updates. Call `onChange` whenever threads may have changed; return an unsubscribe function. */
  subscribe?(onChange: () => void): () => void;
}

export interface ReviewHostOptions {
  /** The frame showing the site. Leave out in on-site mode, where the site is the top page and we are a dock inside it. */
  iframe?: HTMLIFrameElement;
  /** On-site mode: the window running the widget (the site page around the dock). */
  siteWindow?: Window;
  /** The reviewed site's origin, e.g. https://client-site.com */
  frameOrigin: string;
  /** Path to open first, e.g. "/" or "/about/". */
  startPath?: string;
  store: ThreadStore;
  user: ReviewUser | null;
  /** False for view-only members, share links without comment rights, and anonymous visitors. */
  canComment: boolean;
  mode?: ReviewMode;
  viewport?: string;
  onUrlChange?(info: { pageUrl: string; pageKey: string; title: string }): void;
  onThreadsChange?(threads: ReviewThread[]): void;
  /** Open (unresolved) comment counts for every viewport, so a screen can show where the comments are. */
  onCounts?(counts: Record<string, number>): void;
  onMissingAnchors?(threadIds: string[]): void;
  onReady?(): void;
  onError?(error: unknown, context: string): void;
}

/**
 * What the reviewed page is allowed to do. Notably absent:
 *  - allow-top-navigation: the client's site cannot navigate the review app away
 *  - allow-modals: alert()/confirm() on the site cannot block the reviewer
 * allow-same-origin is required for the site's own storage and cookies to work.
 * It is safe only because the site is a different origin from the app.
 */
export const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';

export class ReviewHost {
  private threads: ReviewThread[] = [];
  private mode: ReviewMode;
  private viewport: string;
  private frameReady = false;
  private currentPageKey = '/';
  /** A thread to open as soon as the frame reaches its page (set when a thread on another page was clicked). */
  private pendingFocus: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listener = (event: MessageEvent) => this.onMessage(event);
  private destroyed = false;

  constructor(private readonly opts: ReviewHostOptions) {
    this.mode = opts.mode ?? 'browse';
    this.viewport = opts.viewport ?? VIEWPORTS[0]!.name;
  }

  async start(): Promise<void> {
    const { iframe, frameOrigin, startPath = '/' } = this.opts;
    if (new URL(frameOrigin).origin === window.location.origin) {
      throw new Error('The reviewed site must be on a different origin than the app.');
    }
    if (!iframe) {
      // On-site mode: the site is already loaded around us; just listen and wait for its widget to say hello.
      window.addEventListener('message', this.listener);
      await this.reload();
      this.unsubscribe = this.opts.store.subscribe?.(() => void this.reload()) ?? null;
      // The page may have said hello to an earlier dock (before the reviewer gave their name, say): ask again.
      this.opts.siteWindow?.postMessage(wrap({ type: 'host:ping' }), new URL(this.opts.frameOrigin).origin);
      return;
    }
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    window.addEventListener('message', this.listener);
    this.applyViewport();
    // Load threads first so the frame gets them in its very first message.
    await this.reload();
    this.unsubscribe = this.opts.store.subscribe?.(() => void this.reload()) ?? null;
    iframe.src = frameOrigin + (startPath.startsWith('/') ? startPath : '/' + startPath);
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('message', this.listener);
    this.unsubscribe?.();
  }

  setMode(mode: ReviewMode): void {
    this.mode = mode;
    this.send({ type: 'host:mode', mode });
  }

  getMode(): ReviewMode {
    return this.mode;
  }

  setViewport(name: string): void {
    if (!VIEWPORTS.some((v) => v.name === name)) return;
    this.viewport = name;
    this.applyViewport();
    this.pushThreads();
  }

  setCanComment(canComment: boolean): void {
    this.opts.canComment = canComment;
    this.send({ type: 'host:readonly', readOnly: !this.canWrite });
  }

  /**
   * Show a thread. If it lives on another page, the host moves the frame there itself (it does not depend on the page
   * navigating itself), then opens the thread once the frame reports that page.
   */
  focusThread(threadId: string): void {
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) return;
    if (thread.viewport !== this.viewport) this.setViewport(thread.viewport);
    if (this.mode !== 'comment') this.setMode('comment');
    if (thread.pageKey !== this.currentPageKey) {
      this.pendingFocus = threadId;
      if (!this.opts.iframe) {
        // On-site mode: ask the page to go there; it reports back and we open the thread then.
        this.send({ type: 'host:focus', threadId, pageUrl: thread.pageUrl });
        return;
      }
      try {
        const page = new URL(thread.pageUrl);
        this.opts.iframe.src = new URL(this.opts.frameOrigin).origin + page.pathname + page.search;
        return;
      } catch {
        this.pendingFocus = null; // fall through: let the page try to navigate itself
      }
    }
    this.send({ type: 'host:focus', threadId, pageUrl: thread.pageUrl });
  }

  /** Threads for the active viewport, all pages. This is what the sidebar should list. */
  visibleThreads(): ReviewThread[] {
    return this.threads.filter((t) => t.viewport === this.viewport);
  }

  /** Threads for the active viewport on the page currently shown in the frame. */
  threadsOnCurrentPage(): ReviewThread[] {
    return this.visibleThreads().filter((t) => t.pageKey === this.currentPageKey);
  }

  async reload(): Promise<void> {
    try {
      this.threads = await this.opts.store.listThreads();
    } catch (error) {
      this.opts.onError?.(error, 'listThreads');
      return;
    }
    this.pushThreads();
  }

  // --- internals --------------------------------------------------------------

  private get canWrite(): boolean {
    return this.opts.canComment && this.opts.user !== null;
  }

  private applyViewport(): void {
    if (!this.opts.iframe) return; // on-site: the real window is the size
    const preset = VIEWPORTS.find((v) => v.name === this.viewport);
    const style = this.opts.iframe.style;
    style.width = preset?.width ? `${preset.width}px` : '100%';
    style.height = preset?.height ? `${preset.height}px` : '100%';
  }

  private target(): Window | null {
    return this.opts.iframe ? this.opts.iframe.contentWindow : this.opts.siteWindow ?? null;
  }

  private send(message: HostMessage): void {
    if (!this.frameReady || this.destroyed) return;
    // Explicit target origin: if the frame has somehow navigated elsewhere, the browser drops the message.
    this.target()?.postMessage(wrap(message), new URL(this.opts.frameOrigin).origin);
  }

  private pushThreads(settledTempId?: string): void {
    const visible = this.visibleThreads();
    this.opts.onThreadsChange?.(visible);
    if (this.opts.onCounts) {
      const counts: Record<string, number> = {};
      for (const t of this.threads) if (!t.resolved) counts[t.viewport] = (counts[t.viewport] ?? 0) + 1;
      this.opts.onCounts(counts);
    }
    this.send({ type: 'host:threads', threads: visible, settledTempId });
  }

  private onMessage(event: MessageEvent): void {
    // All three must hold. Origin alone is not enough: another window on the
    // site origin (a popup the site opened, say) must not be able to drive us.
    if (event.origin !== new URL(this.opts.frameOrigin).origin) return;
    if (!event.source || event.source !== this.target()) return;
    if (!isEnvelope(event.data)) return;
    void this.handle(event.data as unknown as FrameMessage);
  }

  private async handle(msg: FrameMessage): Promise<void> {
    const { store, user } = this.opts;
    try {
      switch (msg.type) {
        case 'frame:ready': {
          // Fires on every document load inside the frame, so this is also the re-sync point after navigation.
          this.frameReady = true;
          this.send({
            type: 'host:init',
            v: PROTOCOL_VERSION,
            mode: this.mode,
            readOnly: !this.canWrite,
            user,
            threads: this.visibleThreads(),
          });
          this.opts.onReady?.();
          break;
        }
        case 'frame:url': {
          this.currentPageKey = msg.pageKey;
          this.opts.onUrlChange?.({ pageUrl: msg.pageUrl, pageKey: msg.pageKey, title: msg.title });
          if (this.pendingFocus) {
            const t = this.threads.find((x) => x.id === this.pendingFocus);
            if (t && t.pageKey === msg.pageKey) {
              this.pendingFocus = null;
              // The widget sets up its pins after its first message, so give it a moment before asking it to open one.
              setTimeout(() => this.send({ type: 'host:focus', threadId: t.id, pageUrl: t.pageUrl }), 250);
            }
          }
          break;
        }
        case 'frame:composing':
          break;
        case 'anchors:missing': {
          this.opts.onMissingAnchors?.(msg.threadIds);
          break;
        }
        case 'thread:create': {
          if (!this.canWrite || !user) return this.pushThreads(msg.draft.tempId);
          // Never trust the frame for anything it can derive wrongly: recompute the page key here.
          const snapshot = typeof msg.draft.snapshot === 'string' && msg.draft.snapshot.startsWith('data:image/jpeg;base64,') && msg.draft.snapshot.length < 600_000 ? msg.draft.snapshot : undefined;
          const draft: ThreadDraft = { ...msg.draft, snapshot, images: cleanImages(msg.draft.images), pageKey: pageKey(msg.draft.pageUrl), body: msg.draft.body.slice(0, 5000) };
          try {
            const thread = await store.createThread({ draft, viewport: this.viewport, author: user });
            this.threads = [...this.threads.filter((t) => t.id !== thread.id), thread];
          } finally {
            this.pushThreads(msg.draft.tempId); // clears the pending pin whether or not the save worked
          }
          break;
        }
        case 'comment:create': {
          if (!this.canWrite || !user) return;
          const comment = await store.addComment({ threadId: msg.threadId, body: msg.body.slice(0, 5000), images: cleanImages(msg.images), author: user });
          this.threads = this.threads.map((t) =>
            t.id === msg.threadId && !t.comments.some((c) => c.id === comment.id) ? { ...t, comments: [...t.comments, comment] } : t,
          );
          this.pushThreads();
          break;
        }
        case 'thread:resolve': {
          if (!this.canWrite) return;
          await store.setResolved(msg.threadId, msg.resolved);
          this.threads = this.threads.map((t) => (t.id === msg.threadId ? { ...t, resolved: msg.resolved } : t));
          this.pushThreads();
          break;
        }
        case 'comment:edit': {
          if (!this.canWrite) return this.pushThreads();
          const body = msg.body.trim().slice(0, 5000);
          try {
            const { editedAt } = await store.editComment({ threadId: msg.threadId, commentId: msg.commentId, body });
            this.threads = this.threads.map((t) => t.id !== msg.threadId ? t
              : { ...t, comments: t.comments.map((c) => (c.id === msg.commentId ? { ...c, body, editedAt } : c)) });
          } finally {
            this.pushThreads(); // closes the edit box whether or not the save worked
          }
          break;
        }
        case 'comment:delete': {
          const { thread } = await store.deleteComment({ threadId: msg.threadId, commentId: msg.commentId });
          this.threads = thread ? this.threads.filter((t) => t.id !== msg.threadId)
            : this.threads.map((t) => (t.id === msg.threadId ? { ...t, comments: t.comments.filter((c) => c.id !== msg.commentId) } : t));
          this.pushThreads();
          break;
        }
        case 'thread:delete': {
          if (!this.canWrite) return;
          await store.deleteThread(msg.threadId);
          this.threads = this.threads.filter((t) => t.id !== msg.threadId);
          this.pushThreads();
          break;
        }
      }
    } catch (error) {
      this.opts.onError?.(error, msg.type);
    }
  }
}
