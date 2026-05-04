import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BstackReporter from '../src/reporter.js';
import { ENV } from '../src/env.js';
import { clearSpecCache } from '../src/spec-parser.js';

describe('reporter — failOnSetupHook + spec discovery', () => {
  const fetchMock = vi.fn();
  const originalEnv = { ...process.env };
  let dir: string;
  let specPath: string;

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

    clearSpecCache();
    dir = mkdtempSync(join(tmpdir(), 'bstack-spec-'));
    specPath = join(dir, 'before-fails.spec.ts');
    writeFileSync(
      specPath,
      `
        describe('before-fails with 4 tests', () => {
          before(() => { throw new Error('setup failure'); });
          it('[TC-201] first child', async () => {});
          it('[TC-202] second child', async () => {});
          it('[TC-203] third child', async () => {});
          it('[TC-204] fourth child', async () => {});
        });
      `,
      'utf8',
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('beforeAll fails → all 4 tests reported as Failed', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      failOnSetupHook: true,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onRunnerStart({
      cid: '0-0',
      capabilities: { browserName: 'chrome' },
      sessionId: 's',
      isMultiremote: false,
      specs: [specPath],
    } as never);
    r.onSuiteStart({ uid: 's1', title: 'before-fails with 4 tests' } as never);
    r.onHookStart({
      uid: 'h',
      title: '"before all" hook',
      parent: 'before-fails with 4 tests',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h',
      title: '"before all" hook',
      parent: 'before-fails with 4 tests',
      state: 'failed',
      end: new Date(),
      error: { message: 'setup failure' },
    } as never);
    r.onSuiteEnd({ uid: 's1', title: 'before-fails with 4 tests' } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    const allResults = tmCalls.flatMap((c) => JSON.parse(c![1].body).results);
    const ids = allResults.map((r: { test_case_id: string }) => r.test_case_id).sort();
    expect(ids).toEqual(['TC-201', 'TC-202', 'TC-203', 'TC-204']);
    for (const r of allResults) {
      expect(r.test_result.status).toBe('Failed');
      expect(r.test_result.description).toContain('setup failure');
    }
  });

  it('TC-201 passes, TC-202 beforeEach fails → TC-201 Passed, TC-202..204 Failed', async () => {
    writeFileSync(
      specPath,
      `
        describe('per-test bail', () => {
          beforeEach(function () {
            if (this.currentTest?.title.includes('TC-202')) throw new Error('per-test setup failure');
          });
          it('[TC-201] first', async () => {});
          it('[TC-202] second', async () => {});
          it('[TC-203] third', async () => {});
          it('[TC-204] fourth', async () => {});
        });
      `,
      'utf8',
    );
    clearSpecCache();

    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      failOnSetupHook: true,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onRunnerStart({
      cid: '0-0',
      capabilities: { browserName: 'chrome' },
      sessionId: 's',
      isMultiremote: false,
      specs: [specPath],
    } as never);
    r.onSuiteStart({ uid: 'suite', title: 'per-test bail' } as never);

    // TC-201 passes normally
    r.onTestStart({
      uid: 't1',
      title: '[TC-201] first',
      parent: 'per-test bail',
      start: new Date(),
    } as never);
    r.onTestPass({
      uid: 't1',
      title: '[TC-201] first',
      parent: 'per-test bail',
      state: 'passed',
      duration: 1,
      end: new Date(),
    } as never);

    // TC-202: onTestStart, then beforeEach fails
    r.onTestStart({
      uid: 't2',
      title: '[TC-202] second',
      parent: 'per-test bail',
      start: new Date(),
    } as never);
    r.onHookStart({
      uid: 'h2',
      title: '"before each" hook',
      parent: 'per-test bail',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h2',
      title: '"before each" hook',
      parent: 'per-test bail',
      state: 'failed',
      end: new Date(),
      error: { message: 'per-test setup failure' },
    } as never);
    // Mocha bails — TC-203, TC-204 never start.
    r.onSuiteEnd({ uid: 'suite', title: 'per-test bail' } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const tmCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('test-management.browserstack.com'),
    );
    const allResults = tmCalls.flatMap((c) => JSON.parse(c![1].body).results);
    const byId = new Map<string, { status: string; description?: string }>();
    for (const r of allResults) byId.set(r.test_case_id, r.test_result);

    expect(byId.get('TC-201')?.status).toBe('Passed');
    expect(byId.get('TC-202')?.status).toBe('Failed');
    expect(byId.get('TC-203')?.status).toBe('Failed');
    expect(byId.get('TC-204')?.status).toBe('Failed');
    // TC-202 had its beforeEach error specifically; TC-203/204 share the same hook reason.
    expect(byId.get('TC-203')?.description).toContain('per-test setup failure');
  });

  it('Observability events for hook-blocked tests are flipped to result=failed (matches TM)', async () => {
    const r = new BstackReporter({
      tagPattern: /\[(TC-\d+)\]/,
      failOnSetupHook: true,
      flushBatchSize: 100,
      flushIntervalMs: 100_000,
    });

    r.onRunnerStart({
      cid: '0-0',
      capabilities: { browserName: 'chrome' },
      sessionId: 's',
      isMultiremote: false,
      specs: [specPath],
    } as never);
    r.onSuiteStart({ uid: 's1', title: 'before-fails with 4 tests' } as never);
    r.onHookStart({
      uid: 'h',
      title: '"before all" hook',
      parent: 'before-fails with 4 tests',
      start: new Date(),
    } as never);
    r.onHookEnd({
      uid: 'h',
      title: '"before all" hook',
      parent: 'before-fails with 4 tests',
      state: 'failed',
      end: new Date(),
      error: { message: 'setup failure' },
    } as never);
    // Mocha then emits onTestPending for each hook-blocked test.
    for (const [uid, title] of [
      ['t1', '[TC-201] first child'],
      ['t2', '[TC-202] second child'],
      ['t3', '[TC-203] third child'],
      ['t4', '[TC-204] fourth child'],
    ] as const) {
      r.onTestPending({
        uid,
        title,
        parent: 'before-fails with 4 tests',
        state: 'pending',
        start: new Date(),
        end: new Date(),
      } as never);
    }
    r.onSuiteEnd({ uid: 's1', title: 'before-fails with 4 tests' } as never);
    r.onRunnerEnd({} as never);

    await new Promise((res) => setTimeout(res, 30));

    const obsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('collector-observability.browserstack.com/api/v1/batch'),
    );
    const events = obsCalls.flatMap((c) => JSON.parse(c![1].body));
    const finishEvents = events.filter(
      (e: { event_type?: string }) => e.event_type === 'TestRunFinished',
    );
    // Group by identifier — there may be both a synthesized and a Mocha-driven
    // finish event for the same test, but every finish event for a hook-blocked
    // test must report result='failed' (not 'skipped'). That's what the
    // dashboard renders, regardless of which one BS dedupes to.
    const blockedIds = ['TC-201', 'TC-202', 'TC-203', 'TC-204'];
    for (const id of blockedIds) {
      const matching = finishEvents.filter(
        (e: { test_run: { identifier: string; result: string } }) =>
          e.test_run.identifier === id,
      );
      expect(matching.length).toBeGreaterThan(0);
      for (const e of matching) {
        expect(e.test_run.result).toBe('failed');
      }
    }
  });
});
