import { randomUUID } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import type { SanitizedCap } from './capabilities.js';
import type {
  HookRunFinishedEvent,
  HookRunStartedEvent,
  TestRunFinishedEvent,
  TestRunStartedEvent,
  TestStatus,
} from './client/types.js';
import type { IdentifiedTest, IdentifierContext, ReporterOptions } from './config.js';

export interface RunnerMeta {
  capabilities: SanitizedCap[];
  cid?: string;
  sessionId?: string;
  isMultiremote?: boolean;
}

/**
 * Subset of WDIO Stats objects we consume. We type them loosely (only the
 * fields we read) so we don't take a hard dependency on @wdio/reporter's
 * internal class shapes — these have shifted between major versions.
 */
export interface SuiteStatsLike {
  uid: string;
  title: string;
  fullTitle?: string;
  file?: string;
  type?: string;
  parent?: string;
}

export interface TestStatsLike {
  uid: string;
  title: string;
  fullTitle?: string;
  file?: string;
  parent?: string;
  state?: 'passed' | 'failed' | 'skipped' | 'pending';
  duration?: number;
  _duration?: number;
  start?: Date | string;
  end?: Date | string;
  error?: { message?: string; stack?: string } | undefined;
  errors?: Array<{ message?: string; stack?: string }>;
  retries?: number;
}

export interface HookStatsLike extends TestStatsLike {
  /** Mocha-ish hook titles, e.g. '"before all" hook'. */
}

export interface MapperContext {
  /** Suite uid → BS test_run scope chain, accumulated as suites enter/exit. */
  scopeStack: SuiteStatsLike[];
  /** Test uid → generated uuid (so finish event matches start event). */
  testUuids: Map<string, string>;
  /** Hook uid → generated uuid. */
  hookUuids: Map<string, string>;
  /** Test uid → ISO start timestamp. */
  testStarts: Map<string, string>;
  /** Hook uid → ISO start timestamp. */
  hookStarts: Map<string, string>;
  /** Test uid → resolved stable identifier (kept so finish matches start). */
  testIdentifiers: Map<string, string>;
  /** Test uid → tags resolved at start (e.g. extracted ticket IDs). */
  testTags: Map<string, string[]>;
  /**
   * Suite uid → details of the failed setup hook that ran in that suite.
   * Used to mark child tests as Blocked when the suite's before/beforeAll
   * hook prevented them from actually running.
   */
  failedHooksBySuite: Map<string, FailedHookInfo>;
  /** Captured at onRunnerStart; merged into every event meta. */
  runnerMeta?: RunnerMeta;
  framework: string;
  identify: IdentifyFn;
}

export interface FailedHookInfo {
  hookType: 'BEFORE_ALL' | 'BEFORE_EACH' | 'AFTER_ALL' | 'AFTER_EACH' | 'GLOBAL';
  hookTitle: string;
  reason: string;
  backtrace: string[];
}

export type IdentifyFn = (test: IdentifiedTest, context: IdentifierContext) => {
  identifier: string;
  extraTags: string[];
};

export interface MapperOptions {
  framework?: string;
  tagPattern?: ReporterOptions['tagPattern'];
  getTestIdentifier?: ReporterOptions['getTestIdentifier'];
}

export function createMapperContext(opts: MapperOptions | string = {}): MapperContext {
  const o: MapperOptions = typeof opts === 'string' ? { framework: opts } : opts;
  return {
    scopeStack: [],
    testUuids: new Map(),
    hookUuids: new Map(),
    testStarts: new Map(),
    hookStarts: new Map(),
    testIdentifiers: new Map(),
    testTags: new Map(),
    failedHooksBySuite: new Map(),
    framework: o.framework ?? 'webdriverio',
    identify: makeIdentifier(o),
  };
}

function compilePattern(p: string | RegExp | undefined): RegExp | undefined {
  if (!p) return undefined;
  if (p instanceof RegExp) return p;
  return new RegExp(p);
}

function relativeFile(file: string | undefined): string {
  if (!file) return '';
  if (!isAbsolute(file)) return file;
  const rel = relative(process.cwd(), file);
  return rel.startsWith('..') ? file : rel;
}

function makeIdentifier(o: MapperOptions): IdentifyFn {
  const re = compilePattern(o.tagPattern);
  const custom = o.getTestIdentifier;
  return (test, ctx) => {
    if (custom) {
      const id = custom(test, ctx);
      if (id) return { identifier: id, extraTags: tagsFromTitle(re, test.title) };
    }
    if (re) {
      const m = re.exec(test.title) ?? re.exec(ctx.fullTitle);
      if (m && m[1]) {
        const allTags = tagsFromTitle(re, test.title);
        // Identifier is always the first capture; tags include any siblings too.
        return { identifier: m[1], extraTags: allTags.length > 0 ? allTags : [m[1]] };
      }
    }
    const file = relativeFile(test.file ?? ctx.specFile);
    const id = file ? `${file}::${ctx.fullTitle}` : ctx.fullTitle;
    return { identifier: id, extraTags: [] };
  };
}

function tagsFromTitle(re: RegExp | undefined, title: string): string[] {
  if (!re) return [];
  // Use a global flavor of the pattern to collect every match in the title.
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags);
  const out: string[] = [];
  for (const m of title.matchAll(g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function isoNow(): string {
  return new Date().toISOString();
}

function toIso(d: Date | string | undefined): string {
  if (!d) return isoNow();
  if (typeof d === 'string') return d;
  return d.toISOString();
}

function scopeFromStack(stack: SuiteStatsLike[]): { scope: string; scopes: string[] } {
  const scopes = stack.map((s) => s.title).filter(Boolean);
  return { scope: scopes.join(' > '), scopes };
}

function failuresFrom(t: TestStatsLike): { backtrace: string[]; reason: string }[] | undefined {
  const errors = t.errors && t.errors.length > 0 ? t.errors : t.error ? [t.error] : [];
  if (errors.length === 0) return undefined;
  return errors.map((e) => ({
    reason: e.message ?? 'Unknown failure',
    backtrace: e.stack ? e.stack.split('\n') : [],
  }));
}

function statusOf(t: TestStatsLike): TestStatus {
  switch (t.state) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'pending':
      return 'skipped';
    default:
      return 'failed';
  }
}

function durationMs(t: TestStatsLike): number {
  if (typeof t.duration === 'number') return t.duration;
  if (typeof t._duration === 'number') return t._duration;
  if (t.start && t.end) {
    const startMs = new Date(t.start).getTime();
    const endMs = new Date(t.end).getTime();
    return Math.max(0, endMs - startMs);
  }
  return 0;
}

export function hookTypeFromTitle(title: string): HookRunStartedEvent['hook_run']['hook_type'] {
  const t = title.toLowerCase();
  if (t.includes('before all')) return 'BEFORE_ALL';
  if (t.includes('before each')) return 'BEFORE_EACH';
  if (t.includes('after all')) return 'AFTER_ALL';
  if (t.includes('after each')) return 'AFTER_EACH';
  return 'GLOBAL';
}

export function onSuiteStart(ctx: MapperContext, suite: SuiteStatsLike): void {
  ctx.scopeStack.push(suite);
}

export function onSuiteEnd(ctx: MapperContext, suite: SuiteStatsLike): void {
  // Pop matching suite (defensive against out-of-order callbacks).
  const idx = ctx.scopeStack.findIndex((s) => s.uid === suite.uid);
  if (idx >= 0) ctx.scopeStack.splice(idx, 1);
  // Clear any recorded hook failure for this suite — once the suite ends,
  // its hook failure has been propagated to all child tests already.
  ctx.failedHooksBySuite.delete(suite.uid);
}

function mergeTags(a: string[] | undefined, b: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of a ?? []) out.add(t);
  for (const t of b ?? []) out.add(t);
  return [...out];
}

function metaFromContext(ctx: MapperContext): Record<string, unknown> | undefined {
  const m = ctx.runnerMeta;
  if (!m) return undefined;
  const out: Record<string, unknown> = {};
  if (m.cid) out.cid = m.cid;
  if (m.sessionId) out.session_id = m.sessionId;
  if (m.isMultiremote) out.multiremote = true;
  if (m.capabilities && m.capabilities.length > 0) out.capabilities = m.capabilities;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mapTestStart(
  ctx: MapperContext,
  test: TestStatsLike,
  tags?: string[],
): TestRunStartedEvent {
  const uuid = randomUUID();
  ctx.testUuids.set(test.uid, uuid);
  const startedAt = toIso(test.start);
  ctx.testStarts.set(test.uid, startedAt);
  const { scope, scopes } = scopeFromStack(ctx.scopeStack);
  const file = relativeFile(test.file);
  const fullTitle = test.fullTitle ?? `${scope} > ${test.title}`;
  const { identifier, extraTags } = ctx.identify(test, {
    specFile: file,
    scopes,
    fullTitle,
  });
  const allTags = mergeTags(tags, extraTags);
  ctx.testIdentifiers.set(test.uid, identifier);
  ctx.testTags.set(test.uid, allTags);
  const meta = metaFromContext(ctx);
  return {
    event_type: 'TestRunStarted',
    test_run: {
      uuid,
      name: test.title,
      scope,
      scopes,
      identifier,
      file_name: file,
      location: file,
      started_at: startedAt,
      framework: ctx.framework,
      ...(allTags.length > 0 ? { tags: allTags } : {}),
      ...(typeof test.retries === 'number' && test.retries > 0 ? { retries: test.retries } : {}),
      ...(meta ? { meta } : {}),
    },
  };
}

export function mapTestFinish(
  ctx: MapperContext,
  test: TestStatsLike,
  tags?: string[],
): TestRunFinishedEvent {
  const uuid = ctx.testUuids.get(test.uid) ?? randomUUID();
  ctx.testUuids.delete(test.uid);
  const startedAt = ctx.testStarts.get(test.uid) ?? toIso(test.start);
  ctx.testStarts.delete(test.uid);
  const finishedAt = toIso(test.end);
  const { scope, scopes } = scopeFromStack(ctx.scopeStack);
  const file = relativeFile(test.file);
  const fullTitle = test.fullTitle ?? `${scope} > ${test.title}`;
  // Reuse the identifier/tags resolved at start so dashboard merges the rows.
  const identifier =
    ctx.testIdentifiers.get(test.uid) ??
    ctx.identify(test, { specFile: file, scopes, fullTitle }).identifier;
  ctx.testIdentifiers.delete(test.uid);
  const startTags = ctx.testTags.get(test.uid);
  ctx.testTags.delete(test.uid);
  const allTags = mergeTags(tags, startTags);
  const failure = failuresFrom(test);
  const meta = metaFromContext(ctx);
  return {
    event_type: 'TestRunFinished',
    test_run: {
      uuid,
      name: test.title,
      scope,
      scopes,
      identifier,
      file_name: file,
      location: file,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_in_ms: durationMs(test),
      result: statusOf(test),
      framework: ctx.framework,
      ...(failure ? { failure } : {}),
      ...(allTags.length > 0 ? { tags: allTags } : {}),
      ...(typeof test.retries === 'number' && test.retries > 0 ? { retries: test.retries } : {}),
      ...(meta ? { meta } : {}),
    },
  };
}

export function mapHookStart(ctx: MapperContext, hook: HookStatsLike): HookRunStartedEvent {
  const uuid = randomUUID();
  ctx.hookUuids.set(hook.uid, uuid);
  const startedAt = toIso(hook.start);
  ctx.hookStarts.set(hook.uid, startedAt);
  return {
    event_type: 'HookRunStarted',
    hook_run: {
      uuid,
      name: hook.title,
      hook_type: hookTypeFromTitle(hook.title),
      started_at: startedAt,
    },
  };
}

export function mapHookFinish(ctx: MapperContext, hook: HookStatsLike): HookRunFinishedEvent {
  const uuid = ctx.hookUuids.get(hook.uid) ?? randomUUID();
  ctx.hookUuids.delete(hook.uid);
  const startedAt = ctx.hookStarts.get(hook.uid) ?? toIso(hook.start);
  ctx.hookStarts.delete(hook.uid);
  const failure = failuresFrom(hook);
  const hookType = hookTypeFromTitle(hook.title);

  // If a *setup* hook (BEFORE_ALL / BEFORE_EACH) failed, record it against
  // its parent suite. Tests in that suite that subsequently emit as
  // skipped/pending are then reported to Test Management as Blocked with
  // the hook's error attached, instead of a generic Skipped.
  if (
    hook.state === 'failed' &&
    hook.parent &&
    failure?.[0] &&
    (hookType === 'BEFORE_ALL' || hookType === 'BEFORE_EACH')
  ) {
    ctx.failedHooksBySuite.set(hook.parent, {
      hookType,
      hookTitle: hook.title,
      reason: failure[0].reason,
      backtrace: failure[0].backtrace,
    });
  }

  return {
    event_type: 'HookRunFinished',
    hook_run: {
      uuid,
      name: hook.title,
      hook_type: hookType,
      started_at: startedAt,
      finished_at: toIso(hook.end),
      duration_in_ms: durationMs(hook),
      result: statusOf(hook),
      ...(failure ? { failure } : {}),
    },
  };
}

/**
 * Walk up the active suite stack to find the closest ancestor suite whose
 * setup hook failed. Returns the failure plus the key it was recorded under
 * (so the caller can clear single-shot BEFORE_EACH failures after applying
 * them to the next test).
 *
 * WDIO/Mocha report `hook.parent` and `test.parent` as the parent suite's
 * **title** (a human-readable string), not its uid. We index
 * `failedHooksBySuite` by whatever string `hook.parent` carried at write
 * time, then look up by both `suite.title` and `suite.uid` here so the
 * implementation is robust across frameworks that disagree about which
 * field holds the parent reference.
 */
export function findAncestorHookFailure(
  ctx: MapperContext,
  test: TestStatsLike,
): { suiteKey: string; failure: FailedHookInfo } | undefined {
  // Direct parent match (test.parent typically === hook.parent for the same suite).
  if (test.parent) {
    const f = ctx.failedHooksBySuite.get(test.parent);
    if (f) return { suiteKey: test.parent, failure: f };
  }
  // Most-specific (innermost) suite first; try both title and uid.
  for (let i = ctx.scopeStack.length - 1; i >= 0; i--) {
    const suite = ctx.scopeStack[i];
    if (!suite) continue;
    const byTitle = ctx.failedHooksBySuite.get(suite.title);
    if (byTitle) return { suiteKey: suite.title, failure: byTitle };
    const byUid = ctx.failedHooksBySuite.get(suite.uid);
    if (byUid) return { suiteKey: suite.uid, failure: byUid };
  }
  return undefined;
}

/**
 * Clear a recorded hook failure if it was BEFORE_EACH (single-shot — only
 * blocks the immediately-next test, then the next beforeEach runs fresh).
 * BEFORE_ALL failures stay in place until the suite ends.
 */
export function consumeBeforeEachFailure(ctx: MapperContext, suiteKey: string): void {
  const f = ctx.failedHooksBySuite.get(suiteKey);
  if (f && f.hookType === 'BEFORE_EACH') {
    ctx.failedHooksBySuite.delete(suiteKey);
  }
}
