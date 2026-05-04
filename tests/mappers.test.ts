import { describe, expect, it } from 'vitest';
import {
  createMapperContext,
  mapHookFinish,
  mapHookStart,
  mapTestFinish,
  mapTestStart,
  onSuiteEnd,
  onSuiteStart,
} from '../src/mappers.js';

describe('mappers', () => {
  it('builds scope chain from suite stack', () => {
    const ctx = createMapperContext('webdriverio');
    onSuiteStart(ctx, { uid: 's1', title: 'outer' });
    onSuiteStart(ctx, { uid: 's2', title: 'inner' });
    const ev = mapTestStart(ctx, { uid: 't1', title: 'works', start: new Date() });
    expect(ev.test_run.scope).toBe('outer > inner');
    expect(ev.test_run.scopes).toEqual(['outer', 'inner']);
  });

  it('preserves uuid between start and finish', () => {
    const ctx = createMapperContext('webdriverio');
    onSuiteStart(ctx, { uid: 's', title: 'g' });
    const start = mapTestStart(ctx, { uid: 't1', title: 'a', start: new Date() });
    const finish = mapTestFinish(ctx, {
      uid: 't1',
      title: 'a',
      state: 'passed',
      duration: 12,
      end: new Date(),
    });
    expect(finish.test_run.uuid).toBe(start.test_run.uuid);
    expect(finish.test_run.result).toBe('passed');
    expect(finish.test_run.duration_in_ms).toBe(12);
  });

  it('maps failed tests to result=failed with failure backtrace', () => {
    const ctx = createMapperContext('webdriverio');
    mapTestStart(ctx, { uid: 't', title: 'x', start: new Date() });
    const ev = mapTestFinish(ctx, {
      uid: 't',
      title: 'x',
      state: 'failed',
      end: new Date(),
      error: { message: 'boom', stack: 'boom\n  at foo' },
    });
    expect(ev.test_run.result).toBe('failed');
    expect(ev.test_run.failure?.[0]?.reason).toBe('boom');
    expect(ev.test_run.failure?.[0]?.backtrace).toEqual(['boom', '  at foo']);
  });

  it('maps skipped/pending to result=skipped', () => {
    const ctx = createMapperContext('webdriverio');
    mapTestStart(ctx, { uid: 't', title: 'x', start: new Date() });
    const ev = mapTestFinish(ctx, { uid: 't', title: 'x', state: 'pending', end: new Date() });
    expect(ev.test_run.result).toBe('skipped');
  });

  it('detects hook type from title', () => {
    const ctx = createMapperContext('webdriverio');
    const start = mapHookStart(ctx, {
      uid: 'h1',
      title: '"before each" hook',
      start: new Date(),
    });
    expect(start.hook_run.hook_type).toBe('BEFORE_EACH');
    const end = mapHookFinish(ctx, {
      uid: 'h1',
      title: '"before each" hook',
      state: 'passed',
      end: new Date(),
    });
    expect(end.hook_run.uuid).toBe(start.hook_run.uuid);
    expect(end.hook_run.result).toBe('passed');
  });

  it('pops suite scope on suite end', () => {
    const ctx = createMapperContext('webdriverio');
    onSuiteStart(ctx, { uid: 's1', title: 'a' });
    onSuiteStart(ctx, { uid: 's2', title: 'b' });
    onSuiteEnd(ctx, { uid: 's2', title: 'b' });
    const ev = mapTestStart(ctx, { uid: 't', title: 'x', start: new Date() });
    expect(ev.test_run.scope).toBe('a');
  });
});

describe('mappers — identifier resolution', () => {
  it('default identifier is `relativeFile::fullTitle`', () => {
    const ctx = createMapperContext({});
    const ev = mapTestStart(ctx, {
      uid: 't1',
      title: 'should foo',
      fullTitle: 'group > should foo',
      file: 'tests/specs/foo.spec.ts',
      start: new Date(),
    });
    expect(ev.test_run.identifier).toBe('tests/specs/foo.spec.ts::group > should foo');
    expect(ev.test_run.tags ?? []).toEqual([]);
  });

  it('tagPattern extracts ID and pushes it into tags', () => {
    const ctx = createMapperContext({ tagPattern: /\[([A-Z]+-\d+)\]/ });
    const ev = mapTestStart(ctx, {
      uid: 't1',
      title: '[TC-123] should foo',
      fullTitle: 'group > [TC-123] should foo',
      file: 'tests/specs/foo.spec.ts',
      start: new Date(),
    });
    expect(ev.test_run.identifier).toBe('TC-123');
    expect(ev.test_run.tags).toContain('TC-123');
  });

  it('tagPattern with multiple matches collects all into tags', () => {
    const ctx = createMapperContext({ tagPattern: /\[([A-Z]+-\d+)\]/ });
    const ev = mapTestStart(ctx, {
      uid: 't',
      title: '[TC-1] [JIRA-42] composite',
      start: new Date(),
    });
    expect(ev.test_run.identifier).toBe('TC-1');
    expect(ev.test_run.tags).toEqual(expect.arrayContaining(['TC-1', 'JIRA-42']));
  });

  it('falls back to file+fullTitle when tagPattern does not match', () => {
    const ctx = createMapperContext({ tagPattern: /\[([A-Z]+-\d+)\]/ });
    const ev = mapTestStart(ctx, {
      uid: 't',
      title: 'no tag here',
      fullTitle: 'group > no tag here',
      file: 'a.spec.ts',
      start: new Date(),
    });
    expect(ev.test_run.identifier).toBe('a.spec.ts::group > no tag here');
    expect(ev.test_run.tags ?? []).toEqual([]);
  });

  it('getTestIdentifier overrides everything when it returns a value', () => {
    const ctx = createMapperContext({
      tagPattern: /\[([A-Z]+-\d+)\]/,
      getTestIdentifier: (test, c) => `custom:${c.specFile}#${test.uid}`,
    });
    const ev = mapTestStart(ctx, {
      uid: 't1',
      title: '[TC-1] foo',
      fullTitle: 'g > [TC-1] foo',
      file: 'specs/x.ts',
      start: new Date(),
    });
    expect(ev.test_run.identifier).toBe('custom:specs/x.ts#t1');
    // Tag still surfaces via tagPattern even though identifier was overridden.
    expect(ev.test_run.tags).toContain('TC-1');
  });

  it('getTestIdentifier returning undefined falls through to tagPattern', () => {
    const ctx = createMapperContext({
      tagPattern: /\[([A-Z]+-\d+)\]/,
      getTestIdentifier: () => undefined,
    });
    const ev = mapTestStart(ctx, { uid: 't', title: '[TC-9] x', start: new Date() });
    expect(ev.test_run.identifier).toBe('TC-9');
  });

  it('finish event reuses identifier and tags resolved at start', () => {
    const ctx = createMapperContext({ tagPattern: /\[([A-Z]+-\d+)\]/ });
    mapTestStart(ctx, {
      uid: 't1',
      title: '[TC-7] runs',
      fullTitle: 'g > [TC-7] runs',
      file: 'a.ts',
      start: new Date(),
    });
    const finish = mapTestFinish(ctx, {
      uid: 't1',
      title: '[TC-7] runs',
      state: 'passed',
      duration: 5,
      end: new Date(),
    });
    expect(finish.test_run.identifier).toBe('TC-7');
    expect(finish.test_run.tags).toContain('TC-7');
  });

  it('absolute file paths get normalized to cwd-relative', () => {
    const ctx = createMapperContext({});
    const abs = `${process.cwd()}/tests/specs/x.spec.ts`;
    const ev = mapTestStart(ctx, {
      uid: 't',
      title: 'a',
      fullTitle: 'a',
      file: abs,
      start: new Date(),
    });
    expect(ev.test_run.identifier).toBe('tests/specs/x.spec.ts::a');
    expect(ev.test_run.file_name).toBe('tests/specs/x.spec.ts');
  });
});
