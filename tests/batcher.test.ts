import { describe, expect, it, vi } from 'vitest';
import { Batcher } from '../src/batcher.js';
import type { Client, Event } from '../src/client/types.js';

function makeClient(impl?: Partial<Client>): Client & { sendEvents: ReturnType<typeof vi.fn> } {
  return {
    mode: 'collector',
    buildId: 'b1',
    attachBuild: vi.fn(),
    createBuild: vi.fn() as never,
    stopBuild: vi.fn(),
    sendEvents: vi.fn().mockResolvedValue(undefined),
    ...impl,
  } as never;
}

const evt: Event = {
  event_type: 'TestRunStarted',
  test_run: {
    uuid: '1',
    name: 'a',
    scope: '',
    scopes: [],
    identifier: 'a',
    file_name: '',
    location: '',
    started_at: new Date().toISOString(),
  },
};

describe('Batcher', () => {
  it('flushes when reaching maxBatchSize', async () => {
    const client = makeClient();
    const b = new Batcher(client, { maxBatchSize: 2, intervalMs: 100_000 });
    b.enqueue(evt);
    b.enqueue(evt);
    // Wait microtask for the void flush() chain.
    await new Promise((r) => setImmediate(r));
    expect(client.sendEvents).toHaveBeenCalledTimes(1);
    expect(client.sendEvents.mock.calls[0]?.[0]).toHaveLength(2);
    expect(b.drained).toBe(true);
  });

  it('flushes on interval', async () => {
    vi.useFakeTimers();
    const client = makeClient();
    const b = new Batcher(client, { maxBatchSize: 100, intervalMs: 50 });
    b.enqueue(evt);
    expect(client.sendEvents).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(client.sendEvents).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('drains on close()', async () => {
    const client = makeClient();
    const b = new Batcher(client, { maxBatchSize: 100, intervalMs: 100_000 });
    b.enqueue(evt);
    expect(b.drained).toBe(false);
    await b.close();
    expect(client.sendEvents).toHaveBeenCalledTimes(1);
    expect(b.drained).toBe(true);
  });

  it('still drains after a send error', async () => {
    const client = makeClient({
      sendEvents: vi.fn().mockRejectedValue(new Error('net')) as never,
    });
    const onError = vi.fn();
    const b = new Batcher(client, { maxBatchSize: 1, intervalMs: 100_000, onError });
    b.enqueue(evt);
    await new Promise((r) => setImmediate(r));
    expect(onError).toHaveBeenCalledOnce();
    expect(b.drained).toBe(true);
  });

  it('ignores enqueues after close', async () => {
    const client = makeClient();
    const b = new Batcher(client, { maxBatchSize: 100, intervalMs: 100_000 });
    await b.close();
    b.enqueue(evt);
    expect(client.sendEvents).not.toHaveBeenCalled();
  });
});
