import { detectCI } from './ci.js';
import { ENV } from './env.js';

export type ApiMode = 'collector' | 'rest';

export interface SharedOptions {
  username?: string;
  accessKey?: string;
  apiMode?: ApiMode;
  projectName?: string;
  buildName?: string;
  batchId?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  debug?: boolean;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export interface ServiceOptions extends SharedOptions {
  /**
   * Toggle the Observability integration on or off independently of Test
   * Management. When `enabled: false`, the service does NOT create an
   * Observability build, the reporter no-ops (no events streamed to the
   * collector), and `onComplete` skips the build finalize call. Useful if
   * you only want TM run reporting (set `testManagement.projectId`) without
   * the Observability dashboard, or if your account doesn't have
   * Observability provisioned.
   *
   * Default: enabled. Set to `{ enabled: false }` to opt out.
   */
  observability?: { enabled?: boolean };
  /**
   * If true and a build with the resolved batchId exists in env, the service
   * skips creation and reuses it. Default: true (lets multiple wdio invocations
   * in one CI job append to the same build).
   */
  reuseExistingBuild?: boolean;
  /**
   * Capture browser console logs (`browser.getLogs('browser')`) after each
   * WebDriver command and ship them to BrowserStack as LogCreated events.
   * Default: false. Some drivers don't support it (Safari, mobile) — failures
   * are silently ignored.
   */
  captureLogs?: boolean;
  /**
   * Take a screenshot in the worker's `afterTest` hook when a test fails and
   * upload it to BrowserStack. Default: true. Only works when the build
   * creation response had `allow_screenshots: true`.
   */
  captureScreenshotsOnFailure?: boolean;
  /**
   * If the collector is unreachable for the whole run, write events that
   * couldn't be delivered to this directory as JSONL. Default: undefined
   * (drop events). Set to e.g. `./.wdio-bstack-spool` to enable.
   */
  spoolDir?: string;
  /**
   * BrowserStack auto-provisions a Test Management project the first time
   * an Observability build streams test events with a `projectName` that
   * doesn't match any existing TM project. That pollutes your TM workspace
   * with sandbox / typo'd projects.
   *
   * When `true` (the default), `onPrepare`:
   *   1. Lists existing TM projects via `GET /api/v2/projects` (one extra
   *      request per run, ~50ms).
   *   2. Aborts with a clear error if `projectName` doesn't match any of
   *      them — *before* the build is sent — so no data leaks to BS and no
   *      TM project gets created.
   *
   * Pre-create the TM project (or pick a `projectName` that matches one)
   * to satisfy the guard. Set `false` to opt out of the check entirely
   * (legacy behavior — typos will provision new TM projects silently).
   */
  preventTmAutoCreate?: boolean;
  /**
   * If set, the service also creates a BrowserStack **Test Management** test
   * run in `onPrepare` and posts a result to it for every test whose
   * identifier resolves to a `TC-NNN` ID (use `tagPattern` to extract). The
   * project id has the format `PR-####` and is shown in the Test Management
   * URL when you open a project.
   */
  testManagement?: {
    projectId: string;
    /** Run name. Defaults to `buildName` (or `wdio-${batchId}`). */
    runName?: string;
    /** Description body for the run. */
    description?: string;
    /** Tags attached to the run. */
    tags?: string[];
    /**
     * If true, the run includes every test case in the project (untouched
     * cases stay `Untested`). If false, the run only includes the cases your
     * suite actually touches. Default: true.
     *
     * Ignored when `scopeFromSpecs: true`.
     */
    includeAll?: boolean;
    /**
     * Pre-register every `[TC-NNN]` discovered in your specs as part of the
     * run *at creation time*, so they all start as `Untested` and flip to
     * Passed/Failed/Skipped/Blocked as execution reports back. Anything not
     * reported (because the pipeline died, a hook bailed the suite, the
     * worker was killed) stays visibly `Untested` on the dashboard —
     * giving you a precise expected-vs-executed delta without a separate
     * spreadsheet.
     *
     * Implementation: statically parses specs (same as `preflightCheck`),
     * cross-references the IDs against the project catalog (drops unknown
     * ones — TM API silently drops POSTs to those anyway), and creates the
     * run with `test_cases: [...]` set to the surviving list.
     *
     * When set, `includeAll` is ignored. Default: false (keeps backward
     * compatibility with full-catalog runs).
     */
    scopeFromSpecs?: boolean;
    /** Optional folder ids to scope the run to. */
    folderIds?: number[];
    /**
     * Before workers spawn, statically discover every `[TC-NNN]` tag in
     * your spec files and warn about any that aren't in the project's case
     * catalog. The TM API returns 200 OK and silently drops results for
     * unknown identifiers, so without this check missing cases are
     * invisible. Default: true.
     *
     * Set false to skip the check (one extra GET per run is the only cost).
     */
    preflightCheck?: boolean;
    /**
     * Regex used to extract TC IDs from spec test titles for the
     * preflight check. Default matches `[TC-NNN]`. Provide your own if
     * your team uses a different convention. The first capture group is
     * the identifier.
     */
    preflightTagPattern?: RegExp | string;
    /**
     * Close the Test Management run when WDIO finishes. Default: true.
     *
     * Set false to leave the run as `in_progress` so additional CI jobs,
     * manual posts, or follow-up automation can keep adding results to
     * the same run. (Reminder: closed runs reject all subsequent POSTs.)
     */
    autoCloseTestRun?: boolean;
    /**
     * BrowserStack silently auto-creates a *second* TM run for every
     * Observability build, named after `buildName` with a `#N` suffix
     * (e.g. `local-2026-05-02T05-23-00-692Z #5`). It's left in `done/active`
     * state and BS never closes it.
     *
     * When true (the default), `onComplete` polls the project for runs
     * whose name starts with the current `buildName` and closes each one
     * as it appears. Strictly prefix-scoped — runs from concurrent CI
     * jobs or earlier WDIO invocations are never touched.
     *
     * The poll loop exits early once it's closed at least one run AND a
     * follow-up poll comes back empty (BS has finished provisioning), so
     * fast cases finish in seconds. Bounded by `sweepWaitMs`.
     *
     * Default: true. Set false to skip the sweep entirely (use the bundled
     * `wdio-bstack-reporter sweep` CLI as a separate CI step instead).
     */
    closeAutoCreatedRuns?: boolean;
    /**
     * Total time the inline sweep keeps polling in `onComplete` before
     * giving up. The shadow is created server-side asynchronously and may
     * appear seconds-to-minutes after WDIO finishes; longer waits catch
     * more cases at the cost of a longer CI tail. Default: 30000 (30s).
     *
     * For long-tail cases beyond this window, run the standalone CLI as a
     * follow-up CI step:
     *   `npx wdio-bstack-reporter sweep --project PR-1 --build-name "$BUILD_NAME" --wait 5m`
     */
    sweepWaitMs?: number;
    /**
     * Time between sweep polls. Default: 5000 (5s). Lowering helps on fast
     * BS pipelines; raising helps if BS rate-limits the listing endpoint.
     */
    sweepIntervalMs?: number;
  };
}

export interface IdentifierContext {
  /** Spec file path (relative to cwd if possible). */
  specFile: string;
  /** Suite titles, outermost first. */
  scopes: string[];
  /** Full hierarchical title used by default. */
  fullTitle: string;
}

export interface IdentifiedTest {
  uid: string;
  title: string;
  fullTitle?: string | undefined;
  file?: string | undefined;
  parent?: string | undefined;
  state?: 'passed' | 'failed' | 'skipped' | 'pending' | undefined;
}

export interface ReporterOptions extends Pick<SharedOptions, 'debug'> {
  flushIntervalMs?: number;
  flushBatchSize?: number;
  /**
   * When an `afterEach` / `afterAll` hook fails for a test that otherwise
   * passed, downgrade the test's TM status from `Passed` to `Failed`. The
   * hook's error is also appended to the result's `description` either way.
   *
   * Rationale: the test+teardown lifecycle as a whole failed — leaving the
   * row as `Passed` can mask broken cleanup (leaked DB rows, dangling
   * processes) that would silently rot the suite over time.
   *
   * Default: `true`. Set `false` to keep the description annotation but
   * leave the test status as it was reported.
   */
  failedAfterHook?: boolean;
  /**
   * When a setup hook (`before all` / `before each`) fails, mark **every
   * test in the affected suite** as `Failed` — including the ones WDIO
   * never told the reporter about (Mocha skips child tests of a failed
   * `before all` and bails the rest of a suite after a failed `beforeEach`,
   * so without this option those tests just vanish from TM).
   *
   * To discover the missing tests, the reporter statically parses the
   * spec file (regex match on `describe`/`it` calls). Best-effort: handles
   * literal-string titles, breaks for dynamic titles (template
   * expressions, `forEach`-generated tests, helpers wrapping `it()`).
   *
   * Also flips the in-flight test that the hook killed from `Blocked`
   * (the default for setup-hook orphans) to `Failed`, so the whole suite
   * is consistently red.
   *
   * Default: `false`. Opt in when your specs are statically defined and
   * you want suite-wide red status on hook failures.
   */
  failOnSetupHook?: boolean;
  /**
   * Pattern to extract a stable ID from the test title (e.g. `[TC-123]` or
   * `@TC-123`). The first capture group is used as the identifier and is
   * also pushed into the event `tags` array so the dashboard can filter
   * by it. When set as a string, it's treated as a regex source.
   *
   * Common patterns:
   *   /\[([A-Z]+-\d+)\]/   matches "[TC-123] should ..."
   *   /@([A-Z]+-\d+)/      matches "should ... @TC-123"
   */
  tagPattern?: string | RegExp;
  /**
   * Override identifier resolution entirely. Returning `undefined` falls
   * back to tagPattern → file+fullTitle. Runs once per test start.
   */
  getTestIdentifier?: (test: IdentifiedTest, context: IdentifierContext) => string | undefined;
  /**
   * When true, drop every Observability event for tests whose extracted TC
   * ID isn't in the TM project catalog. Keeps the BS-auto-created shadow
   * run scope-consistent with our explicit TM run (both end up with the
   * same N tests / N failures).
   *
   * Requires `testManagement.projectId` + `testManagement.preflightCheck`
   * to be active in the launcher options — that's how the missing-IDs set
   * is resolved and shared with workers (via env var `BSTACK_REPORTER_DROPPED_TC_IDS`).
   *
   * **Tradeoff**: tests for those TC IDs disappear from BrowserStack
   * entirely (no Observability timeline, screenshots, or hook trace).
   * Use only when your catalog is the source of truth and out-of-catalog
   * tests are intentional placeholders / experiments. Default: false.
   */
  enforceTcCatalog?: boolean;
}

export interface ResolvedAuth {
  username: string;
  accessKey: string;
}

export class ConfigError extends Error {}

export function resolveAuth(opts: SharedOptions): ResolvedAuth {
  const username = opts.username ?? process.env[ENV.USERNAME];
  const accessKey = opts.accessKey ?? process.env[ENV.ACCESS_KEY];
  if (!username || !accessKey) {
    throw new ConfigError(
      `Missing BrowserStack credentials. Provide options.username/accessKey or set ${ENV.USERNAME}/${ENV.ACCESS_KEY} env vars.`,
    );
  }
  return { username, accessKey };
}

export function resolveApiMode(opts: SharedOptions): ApiMode {
  return opts.apiMode ?? 'collector';
}

export function resolveBatchId(opts: SharedOptions): { batchId: string; source: string } {
  if (opts.batchId) return { batchId: opts.batchId, source: 'option' };
  const fromEnv = process.env[ENV.BATCH_ID];
  if (fromEnv) return { batchId: fromEnv, source: 'env' };
  const ci = detectCI();
  if (ci) return { batchId: ci.batchId, source: `ci:${ci.provider}` };
  // Fallback: per-invocation random ID
  return { batchId: randomBatchId(), source: 'generated' };
}

function randomBatchId(): string {
  return `wdio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const SDK_VERSION = '0.1.0';
