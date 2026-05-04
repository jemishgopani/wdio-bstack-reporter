import { describe, expect, it, vi } from 'vitest';
import { pollAndClose } from '../src/sweep-loop.js';
import { TestManagementClient } from '../src/client/test-management.js';

function fakeTm(opts: {
  pages: Array<Array<{ identifier: string; name: string }>>;
  closeMock?: ReturnType<typeof vi.fn>;
}): { tm: TestManagementClient; close: ReturnType<typeof vi.fn>; listed: number } {
  const tm = new TestManagementClient({ username: 'u', accessKey: 'k', projectId: 'PR-1' });
  const close = opts.closeMock ?? vi.fn().mockResolvedValue(undefined);
  let i = 0;
  const state = { listed: 0 };
  vi.spyOn(tm, 'listActiveRuns').mockImplementation(async (q) => {
    state.listed += 1;
    const page = opts.pages[Math.min(i, opts.pages.length - 1)];
    i += 1;
    return (page ?? []).filter((r) =>
      q?.nameStartsWith ? r.name.startsWith(q.nameStartsWith) : true,
    ).map((r) => ({ ...r, run_state: 'done', active_state: 'active' }));
  });
  vi.spyOn(tm, 'closeRunById').mockImplementation(close);
  return { tm, close, get listed() { return state.listed; } } as never;
}

describe('pollAndClose', () => {
  it('exits early once one is closed and the next poll is empty', async () => {
    const { tm, close } = fakeTm({
      pages: [
        [],
        [{ identifier: 'TR-9', name: 'local-foo #1' }],
        [],
      ],
    });
    const result = await pollAndClose(
      tm,
      { nameStartsWith: 'local-foo', waitMs: 60_000, intervalMs: 5_000 },
      { sleep: async () => undefined },
    );
    expect(result.closed).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.polls).toBe(3);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('TR-9', { run_state: 'done' });
  });

  it('respects deadline when no run ever matches', async () => {
    const { tm, close } = fakeTm({ pages: [[]] });
    let now = 0;
    const result = await pollAndClose(
      tm,
      { nameStartsWith: 'anything', waitMs: 30_000, intervalMs: 10_000 },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(result.closed).toBe(0);
    expect(result.timedOut).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('NEVER closes runs whose name does not match the prefix (defensive)', async () => {
    // Even though listActiveRuns SHOULD already filter, double-check that
    // pollAndClose itself enforces the prefix on every close.
    const { tm, close } = fakeTm({
      pages: [
        [
          { identifier: 'TR-OURS', name: 'local-mine #1' },
          { identifier: 'TR-OTHER', name: 'someone-elses-build #1' },
        ],
        [],
      ],
    });
    // Make listActiveRuns ignore the filter and return both — to prove the
    // inner guard inside pollAndClose still skips the non-matching one.
    vi.spyOn(tm, 'listActiveRuns').mockResolvedValueOnce([
      { identifier: 'TR-OURS', name: 'local-mine #1', run_state: 'done', active_state: 'active' },
      { identifier: 'TR-OTHER', name: 'someone-elses-build #1', run_state: 'done', active_state: 'active' },
    ]).mockResolvedValueOnce([]);

    const result = await pollAndClose(
      tm,
      { nameStartsWith: 'local-mine', waitMs: 30_000, intervalMs: 5_000 },
      { sleep: async () => undefined },
    );

    expect(result.closed).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith('TR-OURS', { run_state: 'done' });
    // TR-OTHER must never be closed.
    expect(close).not.toHaveBeenCalledWith('TR-OTHER', expect.anything());
  });

  it('counts close failures separately from successes', async () => {
    const close = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('500 internal'))
      .mockResolvedValue(undefined);
    const { tm } = fakeTm({
      pages: [
        [
          { identifier: 'TR-A', name: 'p #1' },
          { identifier: 'TR-B', name: 'p #2' },
        ],
        [],
      ],
      closeMock: close,
    });
    const result = await pollAndClose(
      tm,
      { nameStartsWith: 'p', waitMs: 30_000, intervalMs: 5_000 },
      { sleep: async () => undefined },
    );
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(1);
  });
});
