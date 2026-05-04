import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, parseDuration, sweep } from '../src/cli/sweep.js';

describe('cli/sweep parseArgs', () => {
  it('parses --project + defaults', () => {
    const r = parseArgs(['--project', 'PR-1']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options).toEqual({ projectId: 'PR-1', dryRun: false });
  });

  it('rejects invalid project format', () => {
    const r = parseArgs(['--project', 'demo-project']);
    expect(r.ok).toBe(false);
  });

  it('parses --build-name --max-age --dry-run', () => {
    const r = parseArgs(['-p', 'PR-2', '--build-name', 'local-x', '--max-age', '1h', '--dry-run']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.buildName).toBe('local-x');
    expect(r.options.maxAgeMs).toBe(3_600_000);
    expect(r.options.dryRun).toBe(true);
  });

  it('rejects unknown flags', () => {
    const r = parseArgs(['--project', 'PR-1', '--bogus']);
    expect(r.ok).toBe(false);
  });

  it('rejects --max-age with garbage value', () => {
    const r = parseArgs(['--project', 'PR-1', '--max-age', 'sometime']);
    expect(r.ok).toBe(false);
  });

  it('parses --wait and --interval', () => {
    const r = parseArgs(['-p', 'PR-1', '--wait', '5m', '--interval', '15s']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.waitMs).toBe(300_000);
    expect(r.options.intervalMs).toBe(15_000);
  });

  it('rejects garbage --wait', () => {
    const r = parseArgs(['-p', 'PR-1', '--wait', 'forever']);
    expect(r.ok).toBe(false);
  });
});

describe('cli/sweep parseDuration', () => {
  it.each([
    ['100ms', 100],
    ['10s', 10_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['  3 h ', 10_800_000],
  ])('%s → %d ms', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', 'forever', '5', '10seconds'])('rejects %s', (input) => {
    expect(parseDuration(input)).toBeUndefined();
  });
});

describe('cli/sweep sweep()', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists then closes matching active runs', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/test-runs?p=')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              test_runs: [
                { identifier: 'TR-1', name: 'local-foo #1', active_state: 'active', run_state: 'done' },
                { identifier: 'TR-2', name: 'local-foo #2', active_state: 'active', run_state: 'done' },
                { identifier: 'TR-3', name: 'wdio-other', active_state: 'active', run_state: 'done' },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      // /close
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const result = await sweep(
      { projectId: 'PR-1', buildName: 'local-foo', dryRun: false },
      { username: 'u', accessKey: 'k', log: () => undefined },
    );

    expect(result.matched).toBe(2);
    expect(result.closed).toBe(2);
    expect(result.failed).toBe(0);
    // 1 list + 2 close
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const closeUrls = fetchMock.mock.calls.slice(1).map(([u]) => String(u));
    expect(closeUrls.every((u) => u.endsWith('/close'))).toBe(true);
    expect(closeUrls[0]).toContain('/TR-1/close');
    expect(closeUrls[1]).toContain('/TR-2/close');
  });

  it('dry-run does not call /close', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          test_runs: [
            { identifier: 'TR-1', name: 'local-x #1', active_state: 'active', run_state: 'done' },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await sweep(
      { projectId: 'PR-1', dryRun: true },
      { username: 'u', accessKey: 'k', log: () => undefined },
    );
    expect(result.matched).toBe(1);
    expect(result.closed).toBe(0);
    expect(result.dryRun).toBe(true);
    // Only the list call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('--wait polls every interval and exits early when shadow appears + is closed', async () => {
    // Poll 1: nothing yet (BS hasn't provisioned the shadow).
    // Poll 2: the shadow has appeared.
    // Poll 3: nothing left (we just closed it). Should exit early.
    let listCall = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/test-runs?p=')) {
        listCall += 1;
        if (listCall === 1) {
          return Promise.resolve(new Response(JSON.stringify({ test_runs: [] }), { status: 200 }));
        }
        if (listCall === 2) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                test_runs: [
                  { identifier: 'TR-9', name: 'local-x #1', active_state: 'active', run_state: 'done' },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ test_runs: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const sleepCalls: number[] = [];
    const result = await sweep(
      { projectId: 'PR-1', dryRun: false, waitMs: 60_000, intervalMs: 10_000 },
      {
        username: 'u',
        accessKey: 'k',
        log: () => undefined,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    );
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(0);
    // 3 polls (empty / found / empty), so 2 sleeps in between.
    expect(listCall).toBe(3);
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(10_000);
  });

  it('--wait respects deadline when no shadow ever appears', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ test_runs: [] }), { status: 200 })),
    );

    let nowMs = 1_000_000;
    const result = await sweep(
      { projectId: 'PR-1', dryRun: false, waitMs: 30_000, intervalMs: 10_000 },
      {
        username: 'u',
        accessKey: 'k',
        log: () => undefined,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
    );
    expect(result.closed).toBe(0);
    // 30s budget, 10s interval → poll at t=0, 10, 20, 30 = 4 polls; then deadline reached.
    // (sleep is 10s each time; loop exits when now >= deadline after the 4th poll.)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('--max-age filters out runs younger than the cutoff', async () => {
    const now = 1_000_000_000_000;
    // List
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          test_runs: [
            { identifier: 'TR-OLD', name: 'x', active_state: 'active', run_state: 'done' },
            { identifier: 'TR-NEW', name: 'x', active_state: 'active', run_state: 'done' },
          ],
        }),
        { status: 200 },
      ),
    );
    // GET /TR-OLD (created 1h ago) and GET /TR-NEW (created 1m ago)
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/TR-OLD')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ test_run: { created_at: new Date(now - 60 * 60_000).toISOString() } }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/TR-NEW')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ test_run: { created_at: new Date(now - 60_000).toISOString() } }),
            { status: 200 },
          ),
        );
      }
      // close
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const result = await sweep(
      { projectId: 'PR-1', dryRun: false, maxAgeMs: 30 * 60_000 }, // older than 30 min
      { username: 'u', accessKey: 'k', now: () => now, log: () => undefined },
    );
    expect(result.matched).toBe(1);
    expect(result.closed).toBe(1);
  });
});
