import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BstackReporter from '../src/reporter.js';
import { ENV } from '../src/env.js';

describe('reporter retries + capability attribution', () => {
  const fetchMock = vi.fn();
  const originalEnv = { ...process.env };
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    process.env[ENV.BUILD_ID] = 'b';
    process.env[ENV.API_MODE] = 'collector';
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('emits a synthetic finish on onTestRetry', async () => {
    const r = new BstackReporter({ flushBatchSize: 1, flushIntervalMs: 100_000 });
    r.onRunnerStart({ capabilities: { browserName: 'chrome' }, cid: '0-0' } as never);
    r.onTestStart({ uid: 't', title: 'flaky', start: new Date() } as never);
    r.onTestRetry({ uid: 't', title: 'flaky', state: 'failed', end: new Date() } as never);

    await new Promise((res) => setImmediate(res));
    // Should have fired: TestRunStarted + TestRunFinished(failed)
    const allBodies = fetchMock.mock.calls.flatMap((c) => JSON.parse(c[1].body));
    const types = allBodies.map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual(['TestRunStarted', 'TestRunFinished']);
    const finish = allBodies.find((e: { event_type: string }) => e.event_type === 'TestRunFinished');
    expect(finish.test_run.result).toBe('failed');
  });

  it('attaches runner capabilities to test event meta', async () => {
    const r = new BstackReporter({ flushBatchSize: 100, flushIntervalMs: 100_000 });
    r.onRunnerStart({
      capabilities: { browserName: 'chrome', browserVersion: '120' },
      cid: '0-0',
      sessionId: 'abc',
    } as never);
    r.onTestStart({ uid: 't', title: 'x', start: new Date() } as never);
    r.onTestPass({
      uid: 't',
      title: 'x',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);
    r.onRunnerEnd({} as never);

    // Wait for close()
    await new Promise((res) => setTimeout(res, 10));
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall![1].body);
    expect(body[0].test_run.meta.cid).toBe('0-0');
    expect(body[0].test_run.meta.session_id).toBe('abc');
    expect(body[0].test_run.meta.capabilities).toEqual([
      { browser: 'chrome', browserVersion: '120' },
    ]);
  });
});
