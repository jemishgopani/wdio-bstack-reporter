import type { Client, Event } from './client/types.js';

export interface BatcherOptions<T> {
  intervalMs?: number;
  maxBatchSize?: number;
  onError?: (err: unknown, items: T[]) => void;
}

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH_SIZE = 1000;

/**
 * Generic queue-and-flush. Used for both Observability events (flushed via
 * `Client.sendEvents`) and Test Management results (flushed via the TM
 * client's `postResults`). Tracks in-flight requests via `pending` so the
 * reporter's `isSynchronised` getter can drain cleanly.
 */
export class Batcher<T = Event> {
  private queue: T[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pending = 0;
  private flushing = false;
  private closed = false;
  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private readonly send: (items: T[]) => Promise<void>;
  private readonly onError: (err: unknown, items: T[]) => void;

  constructor(send: (items: T[]) => Promise<void>, opts?: BatcherOptions<T>);
  constructor(client: Client, opts?: BatcherOptions<T>);
  constructor(
    sendOrClient: Client | ((items: T[]) => Promise<void>),
    opts: BatcherOptions<T> = {},
  ) {
    this.send =
      typeof sendOrClient === 'function'
        ? sendOrClient
        : (items) => sendOrClient.sendEvents(items as unknown as Event[]);
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.onError =
      opts.onError ??
      ((err) => {
        console.error('[wdio-bstack-reporter] failed to flush batch:', err);
      });
  }

  enqueue(item: T): void {
    if (this.closed) return;
    this.queue.push(item);
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  get pendingCount(): number {
    return this.pending + this.queue.length + (this.flushing ? 1 : 0);
  }

  get drained(): boolean {
    return this.pendingCount === 0;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0 || this.flushing) return;
    const batch = this.queue.splice(0, this.maxBatchSize);
    this.flushing = true;
    this.pending++;
    try {
      await this.send(batch);
    } catch (err) {
      this.onError(err, batch);
    } finally {
      this.pending--;
      this.flushing = false;
    }
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}
