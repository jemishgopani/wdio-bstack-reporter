import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BstackReporter from '../src/reporter.js';
import { ENV } from '../src/env.js';

describe('reporter → TM dispatch with hook failures', () => {
  const fetchMock = vi.fn();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
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

  it('marks pending test as Blocked when ancestor before-all hook failed', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onSuiteStart({ uid: 'suite-1', title: 'flaky group' } as never);
    r.onHookStart({
      uid: 'h',
      title: '"before all" hook',
      parent: 'suite-1',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h',
      title: '"before all" hook',
      parent: 'suite-1',
      state: 'failed',
      start: new Date(),
      end: new Date(),
      error: { message: 'db not reachable', stack: 'db not reachable\n at conn' },
    } as never);
    r.onTestPending({
      uid: 't',
      title: '[TC-99] never ran',
      parent: 'suite-1',
      state: 'pending',
      start: new Date(),
      end: new Date(),
    } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    expect(tmCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(tmCalls[0]![1].body);
    expect(body.results[0].test_case_id).toBe('TC-99');
    expect(body.results[0].test_result.status).toBe('Blocked');
    expect(body.results[0].test_result.description).toContain('BEFORE_ALL');
    expect(body.results[0].test_result.description).toContain('db not reachable');
  });

  it('beforeEach failure marks ONLY the next test as Blocked; subsequent tests pass through unaffected', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onSuiteStart({ uid: 's', title: 'group' } as never);

    // beforeEach fails for the first test only.
    r.onHookStart({
      uid: 'h1',
      title: '"before each" hook',
      parent: 's',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h1',
      title: '"before each" hook',
      parent: 's',
      state: 'failed',
      start: new Date(),
      end: new Date(),
      error: { message: 'each-setup failed' },
    } as never);
    // Mocha emits the killed test as pending (not failed) in modern versions.
    r.onTestPending({
      uid: 't1',
      title: '[TC-50] killed by beforeEach',
      parent: 's',
      state: 'pending',
      start: new Date(),
      end: new Date(),
    } as never);

    // beforeEach succeeds for the next test → it actually runs and passes.
    r.onHookStart({
      uid: 'h2',
      title: '"before each" hook',
      parent: 's',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h2',
      title: '"before each" hook',
      parent: 's',
      state: 'passed',
      start: new Date(),
      end: new Date(),
    } as never);
    r.onTestStart({
      uid: 't2',
      title: '[TC-51] runs normally',
      parent: 's',
      start: new Date(),
    } as never);
    r.onTestPass({
      uid: 't2',
      title: '[TC-51] runs normally',
      parent: 's',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);

    r.onRunnerEnd({} as never);
    await new Promise((res) => setTimeout(res, 30));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    const allResults = tmCalls.flatMap((c) => JSON.parse(c![1].body).results);
    const tc50 = allResults.find(
      (r: { test_case_id: string }) => r.test_case_id === 'TC-50',
    );
    const tc51 = allResults.find(
      (r: { test_case_id: string }) => r.test_case_id === 'TC-51',
    );
    expect(tc50.test_result.status).toBe('Blocked');
    expect(tc50.test_result.description).toContain('BEFORE_EACH');
    expect(tc50.test_result.description).toContain('each-setup failed');
    // Critically: TC-51 must NOT be Blocked — it ran fine.
    expect(tc51.test_result.status).toBe('Passed');
    expect(tc51.test_result.description).toBeUndefined();
  });

  it('synthesizes a finish event for a started test that beforeEach killed (no end event from WDIO)', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    // 1. Mocha emits onTestStart for TC-88 (it's about to run).
    r.onSuiteStart({ uid: 'suite-1', title: 'beforeEach group' } as never);
    r.onTestStart({
      uid: 't',
      title: '[TC-88] killed by beforeEach',
      parent: 'beforeEach group',
      start: new Date(),
    } as never);

    // 2. beforeEach runs and fails. Note: no onTestPass/Fail/Skip ever fires
    //    for TC-88 in this scenario — that's the bug we're fixing.
    r.onHookStart({
      uid: 'h',
      title: '"before each" hook',
      parent: 'beforeEach group',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h',
      title: '"before each" hook',
      parent: 'beforeEach group',
      state: 'failed',
      end: new Date(),
      error: { message: 'each-setup blew up', stack: 'each-setup blew up\n at x' },
    } as never);

    r.onRunnerEnd({} as never);
    await new Promise((res) => setTimeout(res, 30));

    // Observability should have received both Started and a synthesized Finished.
    const obsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('collector-observability.browserstack.com'),
    );
    const allObsEvents = obsCalls.flatMap((c) => JSON.parse(c![1].body));
    const startedForTc88 = allObsEvents.filter(
      (e: { event_type: string; test_run?: { name?: string } }) =>
        e.event_type === 'TestRunStarted' && e.test_run?.name?.includes('TC-88'),
    );
    const finishedForTc88 = allObsEvents.filter(
      (e: { event_type: string; test_run?: { name?: string } }) =>
        e.event_type === 'TestRunFinished' && e.test_run?.name?.includes('TC-88'),
    );
    expect(startedForTc88).toHaveLength(1);
    expect(finishedForTc88).toHaveLength(1); // <-- the synthesized one

    // TM should see TC-88 as Blocked (because BEFORE_EACH was the cause).
    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    const tmBody = JSON.parse(tmCalls[0]![1].body);
    expect(tmBody.results[0].test_case_id).toBe('TC-88');
    expect(tmBody.results[0].test_result.status).toBe('Blocked');
    expect(tmBody.results[0].test_result.description).toContain('BEFORE_EACH');
  });

  it('default: afterEach failure flips Passed → Failed and adds the hook error to description', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onSuiteStart({ uid: 's', title: 'group' } as never);
    r.onTestStart({ uid: 't', title: '[TC-105] runs', parent: 'group', start: new Date() } as never);
    r.onTestPass({
      uid: 't',
      title: '[TC-105] runs',
      parent: 'group',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);
    // afterEach fails — annotates buffered TM result.
    r.onHookStart({
      uid: 'h',
      title: '"after each" hook',
      parent: 'group',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h',
      title: '"after each" hook',
      parent: 'group',
      state: 'failed',
      end: new Date(),
      error: { message: 'cleanup blew up' },
    } as never);
    r.onSuiteEnd({ uid: 's', title: 'group' } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    const body = JSON.parse(tmCalls[0]![1].body);
    expect(body.results[0].test_case_id).toBe('TC-105');
    expect(body.results[0].test_result.status).toBe('Failed'); // downgraded by failedAfterHook=true (default)
    expect(body.results[0].test_result.description).toContain('AFTER_EACH');
    expect(body.results[0].test_result.description).toContain('cleanup blew up');

    // Observability event for the same test should also have been flipped
    // to result=failed with the hook error appended to the failure array.
    const obsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('collector-observability.browserstack.com'),
    );
    const finished = obsCalls
      .flatMap((c) => JSON.parse(c![1].body))
      .find((e: { event_type: string }) => e.event_type === 'TestRunFinished');
    expect(finished.test_run.result).toBe('failed');
    expect(finished.test_run.failure?.[0]?.reason).toContain('AFTER_EACH');
  });

  it('default: afterAll failure flips the last test of the suite Passed → Failed', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onSuiteStart({ uid: 's', title: 'group2' } as never);
    r.onTestStart({ uid: 't', title: '[TC-104] runs', parent: 'group2', start: new Date() } as never);
    r.onTestPass({
      uid: 't',
      title: '[TC-104] runs',
      parent: 'group2',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h',
      title: '"after all" hook',
      parent: 'group2',
      state: 'failed',
      end: new Date(),
      error: { message: 'teardown panic' },
    } as never);
    r.onSuiteEnd({ uid: 's', title: 'group2' } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    const body = JSON.parse(tmCalls[0]![1].body);
    expect(body.results[0].test_result.status).toBe('Failed'); // downgraded by failedAfterHook=true (default)
    expect(body.results[0].test_result.description).toContain('AFTER_ALL');
    expect(body.results[0].test_result.description).toContain('teardown panic');
  });

  it('failedAfterHook=false keeps Passed status; only annotates description', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      failedAfterHook: false,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onSuiteStart({ uid: 's', title: 'group3' } as never);
    r.onTestStart({ uid: 't', title: '[TC-200] passes', parent: 'group3', start: new Date() } as never);
    r.onTestPass({
      uid: 't',
      title: '[TC-200] passes',
      parent: 'group3',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h',
      title: '"after each" hook',
      parent: 'group3',
      state: 'failed',
      end: new Date(),
      error: { message: 'cleanup error' },
    } as never);
    r.onSuiteEnd({ uid: 's', title: 'group3' } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const body = JSON.parse(
      fetchMock.mock.calls.find(([u]) =>
        String(u).includes('test-management.browserstack.com'),
      )![1].body,
    );
    expect(body.results[0].test_result.status).toBe('Passed'); // NOT downgraded
    expect(body.results[0].test_result.description).toContain('AFTER_EACH');
  });

  it('keeps Skipped (not Blocked) for an explicitly skipped test in a healthy suite', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onSuiteStart({ uid: 's', title: 'group' } as never);
    r.onTestPending({
      uid: 't',
      title: '[TC-1] explicitly skipped',
      parent: 's',
      state: 'pending',
      start: new Date(),
      end: new Date(),
    } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    const body = JSON.parse(tmCalls[0]![1].body);
    expect(body.results[0].test_result.status).toBe('Skipped');
  });
});
