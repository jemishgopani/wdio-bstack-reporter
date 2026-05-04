import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BstackReporter from '../src/reporter.js';
import { ENV } from '../src/env.js';

describe('BstackReporter', () => {
  const fetchMock = vi.fn();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('no-ops when build context env vars are missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = new BstackReporter({});
    expect(r.isSynchronised).toBe(true);
    r.onTestStart({ uid: 't', title: 'x', start: new Date() } as never);
    r.onTestPass({ uid: 't', title: 'x', state: 'passed', end: new Date() } as never);
    r.onRunnerEnd({} as never);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('streams test events to the collector when env is configured', async () => {
    process.env[ENV.BUILD_ID] = 'build-xyz';
    process.env[ENV.API_MODE] = 'collector';
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';

    const r = new BstackReporter({ flushBatchSize: 100, flushIntervalMs: 100_000 });
    r.onSuiteStart({ uid: 's', title: 'group' } as never);
    r.onTestStart({ uid: 't1', title: 'works', start: new Date() } as never);
    r.onTestPass({
      uid: 't1',
      title: 'works',
      state: 'passed',
      duration: 10,
      end: new Date(),
    } as never);
    // The reporter buffers the TestRunFinished event for one cycle so a
    // teardown hook failure can flip it. onRunnerEnd flushes the buffer.
    r.onRunnerEnd({} as never);

    // Wait for the batch flush microtask.
    await new Promise((res) => setTimeout(res, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/api/v1/batch');
    const body = JSON.parse(init.body);
    expect(body).toHaveLength(2);
    expect(body[0].event_type).toBe('TestRunStarted');
    expect(body[1].event_type).toBe('TestRunFinished');
    expect(body[1].test_run.result).toBe('passed');

    expect(r.isSynchronised).toBe(true);
  });

  it('enforceTcCatalog drops events for TC IDs in BSTACK_REPORTER_DROPPED_TC_IDS', async () => {
    process.env[ENV.BUILD_ID] = 'b';
    process.env[ENV.API_MODE] = 'collector';
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';
    process.env[ENV.DROPPED_TC_IDS] = 'TC-101,TC-102';

    const r = new BstackReporter({
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
      tagPattern: /\[(TC-\d+)\]/,
      enforceTcCatalog: true,
    });
    r.onSuiteStart({ uid: 's', title: 'group' } as never);
    // In-catalog TC: should emit
    r.onTestStart({ uid: 't1', title: '[TC-1] in catalog', start: new Date() } as never);
    r.onTestPass({
      uid: 't1', title: '[TC-1] in catalog', state: 'passed', duration: 10, end: new Date(),
    } as never);
    // Out-of-catalog TC: should be dropped
    r.onTestStart({ uid: 't2', title: '[TC-101] missing', start: new Date() } as never);
    r.onTestFail({
      uid: 't2', title: '[TC-101] missing', state: 'failed', duration: 10, end: new Date(),
    } as never);
    r.onRunnerEnd({} as never);
    await new Promise((res) => setTimeout(res, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    // Only TC-1's start+finish should land — TC-101 dropped both.
    expect(body).toHaveLength(2);
    expect(body[0].test_run.identifier).toBe('TC-1');
    expect(body[1].test_run.identifier).toBe('TC-1');
  });

  it('emits all events when enforceTcCatalog is false (default)', async () => {
    process.env[ENV.BUILD_ID] = 'b';
    process.env[ENV.API_MODE] = 'collector';
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';
    process.env[ENV.DROPPED_TC_IDS] = 'TC-101';

    const r = new BstackReporter({
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
      tagPattern: /\[(TC-\d+)\]/,
      // enforceTcCatalog: false (default)
    });
    r.onSuiteStart({ uid: 's', title: 'group' } as never);
    r.onTestStart({ uid: 't1', title: '[TC-101] missing', start: new Date() } as never);
    r.onTestPass({
      uid: 't1', title: '[TC-101] missing', state: 'passed', duration: 10, end: new Date(),
    } as never);
    r.onRunnerEnd({} as never);
    await new Promise((res) => setTimeout(res, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    // Without enforceTcCatalog, the dropped env var is ignored.
    expect(body).toHaveLength(2);
    expect(body[0].test_run.identifier).toBe('TC-101');
  });

  it('isSynchronised stays false until the in-flight request finishes', async () => {
    process.env[ENV.BUILD_ID] = 'b';
    process.env[ENV.API_MODE] = 'collector';
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';

    let resolveFetch!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => (resolveFetch = res)));

    const r = new BstackReporter({ flushBatchSize: 1, flushIntervalMs: 100_000 });
    r.onTestStart({ uid: 't', title: 'x', start: new Date() } as never);

    await new Promise((res) => setImmediate(res));
    expect(r.isSynchronised).toBe(false);

    resolveFetch(new Response('{}', { status: 200 }));
    await new Promise((res) => setImmediate(res));
    expect(r.isSynchronised).toBe(true);
  });
});
