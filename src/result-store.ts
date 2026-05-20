/** A full tool result held out of context, retrievable by handle. */
interface StoredResult {
  content: string;
  createdAt: number;
}

/** A page of a stored result. */
export interface ResultPage {
  text: string;
  offset: number;
  /** Offset to pass for the next page, or null if this was the last page. */
  nextOffset: number | null;
  total: number;
}

/**
 * Holds large tool results outside the model's context. The model receives a
 * handle plus a preview; it pages in raw content on demand via `slice`.
 *
 * Eviction is lazy: expired entries are dropped on the next access, and the
 * oldest entry is dropped when `maxEntries` is exceeded.
 */
export class ResultStore {
  private store = new Map<string, StoredResult>();
  private sequence = 0;

  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly maxEntries = 100,
  ) {}

  /** Store content and return its handle. */
  put(content: string): string {
    this.evictExpired();
    const handle = `res_${++this.sequence}`;
    this.store.set(handle, { content, createdAt: Date.now() });
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    return handle;
  }

  /** Full content for a handle, or undefined if unknown or expired. */
  get(handle: string): string | undefined {
    this.evictExpired();
    return this.store.get(handle)?.content;
  }

  /** A `limit`-character page of a stored result starting at `offset`. */
  slice(handle: string, offset = 0, limit = 4000): ResultPage | undefined {
    const content = this.get(handle);
    if (content === undefined) return undefined;
    const start = Math.max(0, Math.min(offset, content.length));
    const text = content.slice(start, start + limit);
    const end = start + text.length;
    return {
      text,
      offset: start,
      nextOffset: end < content.length ? end : null,
      total: content.length,
    };
  }

  get size(): number {
    return this.store.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [handle, result] of this.store) {
      if (now - result.createdAt > this.ttlMs) this.store.delete(handle);
    }
  }
}
