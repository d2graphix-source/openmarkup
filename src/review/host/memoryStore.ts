/**
 * In-memory ThreadStore for local development, Storybook-style demos and the
 * end-to-end tests. Same contract as the Supabase store, no network.
 */

import type { ReviewComment, ReviewThread } from '../shared/protocol.ts';
import type { ThreadStore } from './reviewHost.ts';

export class MemoryStore implements ThreadStore {
  threads: ReviewThread[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;

  private id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  async listThreads(): Promise<ReviewThread[]> {
    return structuredClone(this.threads);
  }

  async createThread(input: Parameters<ThreadStore['createThread']>[0]): Promise<ReviewThread> {
    const now = new Date().toISOString();
    const thread: ReviewThread = {
      id: this.id('thread'),
      pageUrl: input.draft.pageUrl,
      pageKey: input.draft.pageKey,
      viewport: input.viewport,
      anchor: input.draft.anchor,
      resolved: false,
      createdAt: now,
      comments: [
        { id: this.id('comment'), authorId: input.author.id, authorName: input.author.name, body: input.draft.body, createdAt: now, images: input.draft.images ?? [] },
      ],
    };
    this.threads.push(thread);
    return structuredClone(thread);
  }

  async addComment(input: Parameters<ThreadStore['addComment']>[0]): Promise<ReviewComment> {
    const thread = this.threads.find((t) => t.id === input.threadId);
    if (!thread) throw new Error('Thread not found');
    const comment: ReviewComment = {
      id: this.id('comment'),
      authorId: input.author.id,
      authorName: input.author.name,
      body: input.body,
      createdAt: new Date().toISOString(),
      images: input.images ?? [],
    };
    thread.comments.push(comment);
    return structuredClone(comment);
  }

  async setResolved(threadId: string, resolved: boolean): Promise<void> {
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error('Thread not found');
    thread.resolved = resolved;
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads = this.threads.filter((t) => t.id !== threadId);
  }

  async editComment(input: { threadId: string; commentId: string; body: string }): Promise<{ editedAt: string }> {
    const comment = this.threads.find((t) => t.id === input.threadId)?.comments.find((c) => c.id === input.commentId);
    if (!comment) throw new Error('Comment not found');
    comment.body = input.body;
    comment.editedAt = new Date().toISOString();
    return { editedAt: comment.editedAt };
  }

  async deleteComment(input: { threadId: string; commentId: string }): Promise<{ thread: boolean }> {
    const thread = this.threads.find((t) => t.id === input.threadId);
    if (!thread) throw new Error('Thread not found');
    if (thread.comments[0]?.id === input.commentId) {
      this.threads = this.threads.filter((t) => t.id !== input.threadId);
      return { thread: true };
    }
    thread.comments = thread.comments.filter((c) => c.id !== input.commentId);
    return { thread: false };
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  /** Simulate a change made by someone else (what Supabase Realtime would deliver). */
  emitRemoteChange(): void {
    for (const listener of this.listeners) listener();
  }
}
