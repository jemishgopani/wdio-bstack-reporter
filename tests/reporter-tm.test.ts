import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BstackReporter from '../src/reporter.js';
import { ENV } from '../src/env.js';

describe('reporter → Test Management dispatch', () => {
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
    process.env[ENV.TM_PROJECT_ID] = 'PR-1';
    process.env[ENV.TM_RUN_ID] = 'TR-9';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('TM-only mode (no Observability env vars) still posts TM results', async () => {
    delete process.env[ENV.BUILD_ID];
    delete process.env[ENV.API_MODE];
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });
    r.onTestStart({ uid: 't1', title: '[TC-1] only TM', start: new Date() } as never);
    r.onTestPass({
      uid: 't1',
      title: '[TC-1] only TM',
      state: 'passed',
      duration: 10,
      end: new Date(),
    } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 20));

    const obsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('collector-observability.browserstack.com'),
    );
    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    // Observability batcher must not have fired (no build context).
    expect(obsCalls).toHaveLength(0);
    // TM batcher must have posted a result.
    expect(tmCalls.length).toBeGreaterThan(0);
    const tmBody = JSON.parse(tmCalls[0]![1].body);
    expect(tmBody.results).toHaveLength(1);
    expect(tmBody.results[0].test_case_id).toBe('TC-1');
    expect(tmBody.results[0].test_result.status).toBe('Passed');
  });

  it('posts a TM result for tests whose identifier is a TC-NN ID', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });
    r.onTestStart({ uid: 't1', title: '[TC-82] performance test', start: new Date() } as never);
    r.onTestFail({
      uid: 't1',
      title: '[TC-82] performance test',
      state: 'failed',
      end: new Date(),
      error: { message: 'too slow' },
    } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 20));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    expect(tmCalls.length).toBeGreaterThan(0);
    const tmBody = JSON.parse(tmCalls[0]![1].body);
    expect(tmBody.results).toHaveLength(1);
    expect(tmBody.results[0].test_case_id).toBe('TC-82');
    expect(tmBody.results[0].test_result.status).toBe('Failed');
    expect(tmBody.results[0].test_result.description).toBe('too slow');
  });

  it('skips TM dispatch for tests without a TC-NN identifier', async () => {
    const r = new BstackReporter({ flushBatchSize: 100, flushIntervalMs: 100_000 });
    // No tagPattern set → identifier is `file::title`, not a TC ID
    r.onTestStart({
      uid: 't',
      title: 'no ticket',
      file: 'a.spec.ts',
      start: new Date(),
    } as never);
    r.onTestPass({
      uid: 't',
      title: 'no ticket',
      file: 'a.spec.ts',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 20));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    expect(tmCalls).toHaveLength(0);
  });

  it('isSynchronised waits for TM batcher to drain too', async () => {
    let resolveTm: ((r: Response) => void) | undefined;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('test-management.browserstack.com')) {
        return new Promise<Response>((res) => {
          resolveTm = res;
        });
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 1,
      flushIntervalMs: 100_000,
    });
    r.onTestStart({ uid: 't', title: '[TC-1] x', start: new Date() } as never);
    r.onTestPass({
      uid: 't',
      title: '[TC-1] x',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);
    // Trigger close() on both batchers — TM batcher's flush will then fire.
    r.onRunnerEnd({} as never);
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(typeof resolveTm).toBe('function');
    expect(r.isSynchronised).toBe(false);

    resolveTm!(new Response('{}', { status: 200 }));
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(r.isSynchronised).toBe(true);
  });
});
