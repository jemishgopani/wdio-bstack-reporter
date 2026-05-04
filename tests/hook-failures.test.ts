import { describe, expect, it } from 'vitest';
import {
  createMapperContext,
  findAncestorHookFailure,
  mapHookFinish,
  mapTestFinish,
  mapTestStart,
  onSuiteEnd,
  onSuiteStart,
} from '../src/mappers.js';

describe('hook-failure tracking', () => {
  it('records a failed before-all hook against its parent suite', () => {
    const ctx = createMapperContext({});
    onSuiteStart(ctx, { uid: 'suite-1', title: 'broken setup' });
    mapHookFinish(ctx, {
      uid: 'h1',
      title: '"before all" hook',
      parent: 'suite-1',
      state: 'failed',
      end: new Date(),
      error: { message: 'db not reachable', stack: 'db not reachable\n  at conn' },
    });
    expect(ctx.failedHooksBySuite.get('suite-1')).toMatchObject({
      hookType: 'BEFORE_ALL',
      reason: 'db not reachable',
    });
  });

  it('does not record passed hooks', () => {
    const ctx = createMapperContext({});
    onSuiteStart(ctx, { uid: 's', title: 'ok' });
    mapHookFinish(ctx, {
      uid: 'h',
      title: '"before all" hook',
      parent: 's',
      state: 'passed',
      end: new Date(),
    });
    expect(ctx.failedHooksBySuite.size).toBe(0);
  });

  it('does not record after-hook failures (only setup hooks block tests)', () => {
    const ctx = createMapperContext({});
    onSuiteStart(ctx, { uid: 's', title: 'ok' });
    mapHookFinish(ctx, {
      uid: 'h',
      title: '"after all" hook',
      parent: 's',
      state: 'failed',
      end: new Date(),
      error: { message: 'cleanup error' },
    });
    expect(ctx.failedHooksBySuite.size).toBe(0);
  });

  it('findAncestorHookFailure walks up the scope stack', () => {
    const ctx = createMapperContext({});
    onSuiteStart(ctx, { uid: 'outer', title: 'outer' });
    onSuiteStart(ctx, { uid: 'inner', title: 'inner' });
    mapHookFinish(ctx, {
      uid: 'h',
      title: '"before all" hook',
      parent: 'outer',
      state: 'failed',
      end: new Date(),
      error: { message: 'outer setup broke' },
    });
    const f = findAncestorHookFailure(ctx, { uid: 't', title: 'x' });
    expect(f?.failure.reason).toBe('outer setup broke');
    expect(f?.suiteKey).toBe('outer');
  });

  it('returns the innermost hook failure when both inner and outer have failures', () => {
    const ctx = createMapperContext({});
    onSuiteStart(ctx, { uid: 'outer', title: 'outer' });
    onSuiteStart(ctx, { uid: 'inner', title: 'inner' });
    mapHookFinish(ctx, {
      uid: 'h1',
      title: '"before all" hook',
      parent: 'outer',
      state: 'failed',
      end: new Date(),
      error: { message: 'outer broke' },
    });
    mapHookFinish(ctx, {
      uid: 'h2',
      title: '"before all" hook',
      parent: 'inner',
      state: 'failed',
      end: new Date(),
      error: { message: 'inner broke' },
    });
    const f = findAncestorHookFailure(ctx, { uid: 't', title: 'x' });
    expect(f?.failure.reason).toBe('inner broke');
    expect(f?.suiteKey).toBe('inner');
  });

  it('clears the entry on suite end', () => {
    const ctx = createMapperContext({});
    onSuiteStart(ctx, { uid: 's', title: 's' });
    mapHookFinish(ctx, {
      uid: 'h',
      title: '"before all" hook',
      parent: 's',
      state: 'failed',
      end: new Date(),
      error: { message: 'x' },
    });
    expect(ctx.failedHooksBySuite.has('s')).toBe(true);
    onSuiteEnd(ctx, { uid: 's', title: 's' });
    expect(ctx.failedHooksBySuite.has('s')).toBe(false);
  });

  it('lifecycle: failed beforeAll → child test sees the failure on its way to TM', () => {
    const ctx = createMapperContext({ tagPattern: /\[(TC-\d+)\]/ });
    onSuiteStart(ctx, { uid: 'suite-x', title: 'flaky group' });
    mapHookFinish(ctx, {
      uid: 'h',
      title: '"before all" hook',
      parent: 'suite-x',
      state: 'failed',
      end: new Date(),
      error: { message: 'setup failed', stack: 'setup failed\n at foo' },
    });
    // Mocha will then emit the test as pending/skipped:
    const test = {
      uid: 't',
      title: '[TC-99] never ran',
      parent: 'suite-x',
      state: 'pending' as const,
      start: new Date(),
      end: new Date(),
    };
    mapTestStart(ctx, test);
    const finish = mapTestFinish(ctx, test);
    expect(finish.test_run.result).toBe('skipped');
    // The reporter, before mapping, looks up the ancestor failure.
    const hookFailure = findAncestorHookFailure(ctx, test);
    expect(hookFailure?.failure.reason).toBe('setup failed');
    // (The reporter's dispatchTm then maps Skipped+hookFailure → Blocked.)
  });
});
