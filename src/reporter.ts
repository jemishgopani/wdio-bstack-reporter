import WDIOReporter, {
  type HookStats,
  type RunnerStats,
  type SuiteStats,
  type TestStats,
} from '@wdio/reporter';
import type { Reporters } from '@wdio/types';
import { Batcher } from './batcher.js';
import { createClient } from './client/index.js';
import type { Client, Event } from './client/types.js';
import { discoverSpecTests, type DiscoveredTest } from './spec-parser.js';
import {
  TestManagementClient,
  extractTcId,
  statusFromObservability,
  type TmTestResult,
} from './client/test-management.js';
import type { ReporterOptions } from './config.js';
import { ENV, readBuildContext } from './env.js';
import { makeSessionEmitter, setSessionEmitter } from './session.js';
import { sanitizeCapabilities } from './capabilities.js';
import { wrapClientWithSpool } from './spool.js';
import {
  consumeBeforeEachFailure,
  createMapperContext,
  findAncestorHookFailure,
  hookTypeFromTitle,
  mapHookFinish,
  mapHookStart,
  mapTestFinish,
  mapTestStart,
  onSuiteEnd as ctxOnSuiteEnd,
  onSuiteStart as ctxOnSuiteStart,
  type MapperContext,
  type MapperOptions,
} from './mappers.js';

type FullOptions = Partial<Reporters.Options> & ReporterOptions;

/**
 * WebdriverIO reporter that streams test events to BrowserStack Test
 * Observability live as the suite runs. Designed to run alongside the
 * launcher service (BstackService) which creates the build in `onPrepare`
 * and finalizes it in `onComplete`. The build id and (optional) JWT are
 * passed to workers via env vars.
 *
 * If the env vars are missing, the reporter logs a warning and no-ops —
 * it does not crash the test run.
 */
export default class BstackReporter extends WDIOReporter {
  private readonly batcher: Batcher<Event> | undefined;
  private readonly tmBatcher: Batcher<TmTestResult> | undefined;
  private readonly mapperCtx: MapperContext;
  private readonly enabled: boolean;
  private readonly debug: boolean;
  private readonly failedAfterHook: boolean;
  private readonly failOnSetupHook: boolean;
  /**
   * TC IDs the launcher's preflight resolved as missing from the project
   * catalog (`BSTACK_REPORTER_DROPPED_TC_IDS` env var). Only consulted
   * when `enforceTcCatalog` is true.
   */
  private readonly droppedTcIds: ReadonlySet<string>;
  private readonly enforceTcCatalog: boolean;
  /**
   * Test UIDs that were filtered out by `enforceTcCatalog`. Tracked so we
   * can short-circuit subsequent end-of-test handlers (emitTestFinish,
   * dispatchTm) without emitting any events to either Observability or TM.
   */
  private readonly droppedUids = new Set<string>();
  /**
   * Test titles for which we've already dispatched a finish event in this
   * worker. Used by `failOnSetupHook` to skip tests that already ran.
   */
  private readonly emittedTitles = new Set<string>();
  /** Tests discovered by static parsing of the worker's spec file(s). */
  private readonly discovered: DiscoveredTest[] = [];
  /**
   * Tests for which onTestStart fired but no onTestPass/Fail/Skip/Pending
   * has come back yet. Used to synthesize a finish event when a beforeEach
   * hook failure orphans a started test (WDIO/Mocha doesn't fire any test
   * end event in that case, leaving the dashboard row stuck "In Progress").
   */
  private readonly pendingTests = new Map<string, TestStats>();
  /**
   * Most-recent TM result, buffered for one cycle. Held back from the TM
   * batcher until the next test result arrives, the suite ends, or the
   * runner ends — so an `afterEach`/`afterAll` hook failure that fires in
   * between can annotate this result's `description` field and (when
   * `failedAfterHook` is true) flip its status to Failed.
   */
  private pendingTmResult: TmTestResult | undefined;
  /**
   * Most-recent Observability TestRunFinished event, also buffered for one
   * cycle. Same lifecycle as `pendingTmResult` so a teardown hook failure
   * can flip the Observability dashboard row to Failed too — keeping the
   * two dashboards consistent. Without this, the Observability row would
   * stay green even when TM shows Failed.
   */
  private pendingObsEvent:
    | (ReturnType<typeof mapTestFinish> & { test_run: { uuid: string } })
    | undefined;

  constructor(options: FullOptions) {
    // WDIOReporter wants either an outputDir+logFile or stdout:true + writeStream.
    // We don't write anything locally — events go to BrowserStack — so we hand it
    // a no-op write sink to satisfy its constructor.
    const noopWriter = { write: () => true };
    super({ ...options, stdout: true, writeStream: noopWriter });

    this.debug = options.debug ?? false;
    this.failedAfterHook = options.failedAfterHook ?? true;
    this.failOnSetupHook = options.failOnSetupHook ?? false;
    this.enforceTcCatalog = options.enforceTcCatalog === true;
    const dropEnv = process.env[ENV.DROPPED_TC_IDS];
    this.droppedTcIds = new Set(
      dropEnv ? dropEnv.split(',').map((s) => s.trim()).filter(Boolean) : [],
    );
    const mapperOpts: MapperOptions = { framework: 'webdriverio' };
    if (options.tagPattern !== undefined) mapperOpts.tagPattern = options.tagPattern;
    if (options.getTestIdentifier !== undefined) {
      mapperOpts.getTestIdentifier = options.getTestIdentifier;
    }
    this.mapperCtx = createMapperContext(mapperOpts);

    const ctx = readBuildContext();
    const tmRunId = process.env[ENV.TM_RUN_ID];
    const tmProjectId = process.env[ENV.TM_PROJECT_ID];
    const observabilityActive = !!(ctx.buildId && ctx.apiMode);
    const tmActive = !!(tmRunId && tmProjectId);

    // Neither dispatch path is configured — service didn't run, was
    // misconfigured, or the user opted out of both. Warn once and no-op.
    if (!observabilityActive && !tmActive) {
      console.warn(
        `[wdio-bstack-reporter] No active build or TM run found in env (${ENV.BUILD_ID}/${ENV.TM_RUN_ID}). ` +
          `The launcher service must run in onPrepare before workers spawn. Reporter will no-op.`,
      );
      this.enabled = false;
      return;
    }

    const username = process.env[ENV.USERNAME];
    const accessKey = process.env[ENV.ACCESS_KEY];
    if (!username || !accessKey) {
      console.warn(
        `[wdio-bstack-reporter] Missing ${ENV.USERNAME}/${ENV.ACCESS_KEY}; reporter will no-op.`,
      );
      this.enabled = false;
      return;
    }

    const batcherOpts: { intervalMs?: number; maxBatchSize?: number } = {};
    if (options.flushIntervalMs !== undefined) batcherOpts.intervalMs = options.flushIntervalMs;
    if (options.flushBatchSize !== undefined) batcherOpts.maxBatchSize = options.flushBatchSize;

    // Observability dispatch — only if the launcher created a build.
    if (observabilityActive) {
      const rawClient: Client = createClient({
        apiMode: ctx.apiMode!,
        username,
        accessKey,
      });
      rawClient.attachBuild({ buildId: ctx.buildId!, ...(ctx.jwt ? { jwt: ctx.jwt } : {}) });
      const spoolDir = process.env[ENV.SPOOL_DIR];
      const client: Client = spoolDir ? wrapClientWithSpool(rawClient, spoolDir) : rawClient;
      const batcher: Batcher<Event> = new Batcher<Event>(
        (events) => client.sendEvents(events),
        batcherOpts,
      );
      this.batcher = batcher;
      // Publish a session emitter so the worker-side service hooks (browser
      // logs, failure screenshots) can enqueue events into the same batcher.
      setSessionEmitter(
        makeSessionEmitter({ batcher, client, allowScreenshots: ctx.allowScreenshots }),
      );
    }

    // Test Management dispatch — independent of Observability. Each
    // TestRunFinished whose identifier is a `TC-NNN` ID becomes a TM
    // result, posted in batches of up to 300.
    if (tmActive) {
      const tmClient = new TestManagementClient({
        username,
        accessKey,
        projectId: tmProjectId!,
      });
      tmClient.attachRun(tmRunId!);
      this.tmBatcher = new Batcher<TmTestResult>(
        (results) => tmClient.postResults(results),
        { intervalMs: batcherOpts.intervalMs ?? 2000, maxBatchSize: 300 },
      );
    }

    this.enabled = true;
  }

  override get isSynchronised(): boolean {
    const obsDrained = !this.batcher || this.batcher.drained;
    const tmDrained = !this.tmBatcher || this.tmBatcher.drained;
    return obsDrained && tmDrained;
  }

  override onRunnerStart(runner: RunnerStats): void {
    if (this.debug) console.log('[wdio-bstack-reporter] runner start');
    // Capture this worker's capabilities once so every test event from this
    // worker can be attributed to the right browser/platform.
    const platforms = sanitizeCapabilities(runner.capabilities);
    if (platforms.length > 0) {
      this.mapperCtx.runnerMeta = {
        capabilities: platforms,
        cid: runner.cid,
        sessionId: runner.sessionId,
        isMultiremote: runner.isMultiremote,
      };
    }
    // If the user opted into failOnSetupHook, statically parse this worker's
    // spec file(s) so we can synthesize Failed events for tests that hook
    // failures kill before WDIO ever fires onTestStart for them.
    if (this.failOnSetupHook) {
      for (const spec of runner.specs ?? []) {
        const filePath = spec.startsWith('file://') ? new URL(spec).pathname : spec;
        const tests = discoverSpecTests(filePath);
        this.discovered.push(...tests);
        if (this.debug)
          console.log(
            `[wdio-bstack-reporter] discovered ${tests.length} test(s) in ${filePath}`,
          );
      }
    }
  }

  override onSuiteStart(suite: SuiteStats): void {
    ctxOnSuiteStart(this.mapperCtx, suite);
  }

  override onSuiteEnd(suite: SuiteStats): void {
    // Suite is ending — afterAll has already fired. Flush both buffered
    // results so their annotation windows close.
    this.flushBufferedObs();
    this.flushBufferedTm();
    ctxOnSuiteEnd(this.mapperCtx, suite);
  }

  override onHookStart(hook: HookStats): void {
    if (!this.enabled) return;
    const event = mapHookStart(this.mapperCtx, hook);
    if (this.batcher) this.batcher.enqueue(event);
  }

  override onHookEnd(hook: HookStats): void {
    if (!this.enabled) return;
    // mapHookFinish must run even in TM-only mode: it's what records the
    // failed hook into `failedHooksBySuite`, which dispatchTm consults to
    // mark TM Blocked/Failed for hook-orphaned tests.
    const event = mapHookFinish(this.mapperCtx, hook);
    if (this.batcher) this.batcher.enqueue(event);
    // If a setup hook failed (`before all` / `before each`), WDIO/Mocha will
    // NOT fire a test end event for tests that were already started but get
    // killed by the hook. Without a synthesized finish, those tests stay
    // "In Progress" forever on the Observability dashboard. Detect and
    // close them here.
    if (hook.state === 'failed') {
      this.flushPendingTestsKilledBy(hook);
      const hookType = hookTypeFromTitle(hook.title);
      // Teardown-hook failures (`after each` / `after all`) don't change a
      // test's pass/fail status — but the dashboard reader should still see
      // them. Annotate the most recently buffered TM result.
      if (hookType === 'AFTER_EACH' || hookType === 'AFTER_ALL') {
        this.annotateBufferedTmWithTeardownFailure(hookType, hook);
      }
      // If failOnSetupHook is on, also synthesize Failed events for any
      // tests in this suite that the hook killed before WDIO told us
      // about them (Mocha skips children of failed `before all`, and bails
      // the rest of a suite after a failed `beforeEach`).
      if (
        this.failOnSetupHook &&
        (hookType === 'BEFORE_ALL' || hookType === 'BEFORE_EACH')
      ) {
        this.synthesizeMissingTestsAsFailed(hook);
      }
    }
  }

  override onTestStart(test: TestStats): void {
    if (!this.enabled) return;
    this.pendingTests.set(test.uid, test);
    // mapTestStart populates testUuids/testIdentifiers — required for the
    // finish event to match in both Observability and TM paths.
    const event = mapTestStart(this.mapperCtx, test);
    if (this.enforceTcCatalog && this.droppedTcIds.has(event.test_run.identifier)) {
      this.droppedUids.add(test.uid);
      return;
    }
    if (this.batcher) this.batcher.enqueue(event);
  }

  override onTestPass(test: TestStats): void {
    this.emitTestFinish(test);
  }

  override onTestFail(test: TestStats): void {
    this.emitTestFinish(test);
  }

  override onTestSkip(test: TestStats): void {
    this.emitTestFinish(test);
  }

  override onTestPending(test: TestStats): void {
    // Mocha emits onTestPending (not onTestSkip) for some skipped cases —
    // notably tests in a describe whose `before all` hook failed. Treat
    // identically to skip; dispatchTm decides Blocked vs Skipped based on
    // whether an ancestor hook failure was recorded.
    this.emitTestFinish(test);
  }

  override onTestRetry(test: TestStats): void {
    if (!this.enabled) return;
    if (!this.batcher) return; // retry events are Observability-only
    if (this.mapperCtx.testUuids.has(test.uid)) {
      this.batcher.enqueue(
        mapTestFinish(this.mapperCtx, { ...test, state: 'failed' as const }),
      );
    }
  }

  override onRunnerEnd(_runner: RunnerStats): void {
    if (!this.enabled) return;
    // Drain any buffered events/results before closing the batchers.
    this.flushBufferedObs();
    this.flushBufferedTm();
    // Trigger a flush; isSynchronised will keep WDIO waiting until drained.
    if (this.batcher) {
      void this.batcher.close().finally(() => setSessionEmitter(undefined));
    }
    if (this.tmBatcher) void this.tmBatcher.close();
  }

  private emitTestFinish(test: TestStats): void {
    if (!this.enabled) return;
    this.pendingTests.delete(test.uid);
    this.emittedTitles.add(test.title);
    // enforceTcCatalog dropped the start event; drop the finish too so the
    // BS shadow run sees no events for this test at all.
    if (this.droppedUids.has(test.uid)) {
      this.droppedUids.delete(test.uid);
      return;
    }
    // If onTestStart wasn't seen (e.g. skipped tests in some frameworks),
    // emit a synthetic start first so the dashboard shows the test row —
    // unless enforceTcCatalog says to drop this TC ID.
    if (!this.mapperCtx.testUuids.has(test.uid)) {
      const startEvent = mapTestStart(this.mapperCtx, test);
      if (this.enforceTcCatalog && this.droppedTcIds.has(startEvent.test_run.identifier)) {
        return;
      }
      if (this.batcher) this.batcher.enqueue(startEvent);
    }
    // Look up ancestor hook failure BEFORE mapTestFinish so the mapper
    // context is still pristine. dispatchTm uses it to decide Blocked vs
    // Skipped for tests that didn't actually run.
    const hookFailure = findAncestorHookFailure(this.mapperCtx, test);
    const finishEvent = mapTestFinish(this.mapperCtx, test);
    // Buffer the Observability event for one cycle so a teardown hook
    // failure can flip its status. (See pendingObsEvent.) Only buffered
    // when Observability is active; in TM-only mode we skip directly to TM.
    if (this.batcher) {
      this.flushBufferedObs();
      this.pendingObsEvent = finishEvent;
      this.applySetupHookOverrideToObs(hookFailure);
    }
    this.dispatchTm(finishEvent, hookFailure);
    // BEFORE_EACH failures only block the very next test — clear after use
    // so the next test in the same suite sees no recorded failure.
    if (hookFailure) consumeBeforeEachFailure(this.mapperCtx, hookFailure.suiteKey);
  }

  /**
   * When a setup hook fails, find any test that was already started under
   * the same parent suite but never received an end event, and synthesize
   * a `pending` finish so the dashboard doesn't show it stuck "In Progress".
   * The TM dispatch path will then map this to `Blocked` with the hook's
   * error attached as the comment.
   */
  private flushPendingTestsKilledBy(hook: HookStats): void {
    if (this.pendingTests.size === 0) return;
    for (const [uid, started] of this.pendingTests) {
      // Match by parent (typically the same suite title).
      if (started.parent !== hook.parent) continue;
      const synthetic = {
        ...started,
        state: 'pending' as const,
        end: new Date(),
      } as TestStats;
      this.pendingTests.delete(uid);
      if (this.debug)
        console.log(`[wdio-bstack-reporter] synthesizing finish for ${started.title} (killed by ${hook.title})`);
      this.emitTestFinish(synthetic);
    }
  }

  private dispatchTm(
    event: ReturnType<typeof mapTestFinish>,
    hookFailure: ReturnType<typeof findAncestorHookFailure>,
  ): void {
    if (!this.tmBatcher) return;
    const tcId = extractTcId(event.test_run.identifier);
    if (!tcId) return;

    // Flush whatever was buffered for the previous test before queueing
    // this one — its annotation window is now closed.
    this.flushBufferedTm();

    let status = statusFromObservability(event.test_run.result);
    let description = event.test_run.failure?.[0]?.reason;

    // If a setup hook (before/beforeAll/beforeEach) of an ancestor suite
    // failed and the test ended up skipped/pending, attribute the cause:
    // by default → Blocked (BS TM convention for "couldn't run").
    // With failOnSetupHook=true → Failed (suite-wide red).
    if (hookFailure && (status === 'Skipped' || status === 'Untested')) {
      status = this.failOnSetupHook ? 'Failed' : 'Blocked';
      description = `${status === 'Failed' ? 'Failed' : 'Blocked'} by failing ${hookFailure.failure.hookType} hook "${hookFailure.failure.hookTitle}": ${hookFailure.failure.reason}`;
    }

    const result: TmTestResult = {
      test_case_id: tcId,
      test_result: {
        status,
        duration_in_ms: event.test_run.duration_in_ms,
        ...(description ? { description } : {}),
      },
    };
    // Buffer it. Will be enqueued on the next test, the suite end, or the
    // runner end — giving any teardown-hook failure a chance to annotate.
    this.pendingTmResult = result;
  }

  /**
   * Push the buffered TM result to the batcher and clear it. Called on
   * suite end, runner end, and just before queuing the next result.
   */
  private flushBufferedTm(): void {
    if (!this.pendingTmResult || !this.tmBatcher) return;
    this.tmBatcher.enqueue(this.pendingTmResult);
    this.pendingTmResult = undefined;
  }

  /**
   * Append a teardown-hook-failure note to the buffered TM result's
   * comment. Used for AFTER_EACH (annotates the test that just finished)
   * and AFTER_ALL (annotates the last test in the suite, which is the
   * `pendingTmResult` at the moment afterAll runs).
   */
  private annotateBufferedTmWithTeardownFailure(
    hookType: 'AFTER_EACH' | 'AFTER_ALL',
    hook: HookStats,
  ): void {
    const reason =
      hook.error?.message ?? hook.errors?.[0]?.message ?? 'unknown';
    const note = `[${hookType} hook "${hook.title}" failed: ${reason}]`;
    const backtrace = (hook.error?.stack ?? '').split('\n');

    // --- TM side ---
    if (this.pendingTmResult) {
      const result = this.pendingTmResult.test_result;
      result.description = result.description ? `${result.description}\n${note}` : note;
      if (this.failedAfterHook && result.status === 'Passed') {
        result.status = 'Failed';
      }
    }

    // --- Observability side ---
    // When `failedAfterHook` is on, also flip the buffered TestRunFinished
    // event so the Observability dashboard shows the same Failed status —
    // otherwise the two dashboards would disagree (TM Failed, Obs green).
    if (this.pendingObsEvent && this.failedAfterHook) {
      const obs = this.pendingObsEvent.test_run;
      if (obs.result === 'passed') obs.result = 'failed';
      const failure = obs.failure ? [...obs.failure] : [];
      failure.push({ reason: note, backtrace });
      obs.failure = failure;
    }
  }

  private flushBufferedObs(): void {
    if (!this.pendingObsEvent || !this.batcher) return;
    this.batcher.enqueue(this.pendingObsEvent);
    this.pendingObsEvent = undefined;
  }

  private applySetupHookOverrideToObs(
    hookFailure: ReturnType<typeof findAncestorHookFailure>,
  ): void {
    if (!hookFailure || !this.failOnSetupHook || !this.pendingObsEvent) return;
    const obs = this.pendingObsEvent.test_run;
    if (obs.result !== 'skipped') return;
    obs.result = 'failed';
    const reason = `Failed by failing ${hookFailure.failure.hookType} hook "${hookFailure.failure.hookTitle}": ${hookFailure.failure.reason}`;
    const failure = obs.failure ? [...obs.failure] : [];
    failure.push({ reason, backtrace: hookFailure.failure.backtrace });
    obs.failure = failure;
  }

  /**
   * For each test discovered via static spec parsing that hasn't been
   * emitted yet AND belongs to the same suite as the failed hook, fabricate
   * a TestStats and run it through emitTestFinish with state=failed. Errors
   * land as `failed` on Observability and `Failed` on TM (with the hook's
   * reason in description / failure backtrace).
   */
  private synthesizeMissingTestsAsFailed(hook: HookStats): void {
    if (this.discovered.length === 0) return;
    const reason =
      hook.error?.message ?? hook.errors?.[0]?.message ?? 'unknown';
    const stack = hook.error?.stack ?? '';
    let counter = 0;
    for (const dt of this.discovered) {
      if (dt.suite !== hook.parent) continue;
      if (this.emittedTitles.has(dt.title)) continue;
      if (this.pendingTests.size > 0) {
        // The currently-running test (if any) is being killed by this hook
        // — handled separately by flushPendingTestsKilledBy. Skip it here.
        let alreadyPending = false;
        for (const [, t] of this.pendingTests) {
          if (t.title === dt.title) {
            alreadyPending = true;
            break;
          }
        }
        if (alreadyPending) continue;
      }
      const synthetic = {
        uid: `synthetic-${hook.uid ?? 'h'}-${counter++}`,
        title: dt.title,
        fullTitle: `${dt.suite} ${dt.title}`,
        parent: dt.suite,
        state: 'failed' as const,
        start: new Date(),
        end: new Date(),
        error: {
          message: `Setup hook "${hook.title}" failed: ${reason}`,
          stack,
        },
      } as unknown as TestStats;
      this.emitTestFinish(synthetic);
    }
  }
}
