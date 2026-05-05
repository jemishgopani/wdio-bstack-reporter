import { describeCap, sanitizeCapabilities } from './capabilities.js';
import { detectCI } from './ci.js';
import { createClient } from './client/index.js';
import type { BuildCreateInput, LogCreatedEvent } from './client/types.js';
import { TestManagementClient, listTmProjects } from './client/test-management.js';
import { extractTcIdsFromSpecs } from './spec-discovery.js';
import {
  resolveApiMode,
  resolveAuth,
  resolveBatchId,
  SDK_VERSION,
  type ServiceOptions,
} from './config.js';
import { clearBuildContext, ENV, readBuildContext, writeBuildContext } from './env.js';
import { takeScreenshotIfPossible, getSessionEmitter } from './session.js';
import { wrapClientWithSpool } from './spool.js';
import { pollAndClose } from './sweep-loop.js';

interface RunResults {
  finished?: number;
  passed?: number;
  failed?: number;
  retries?: number;
}

/** WDIO test stat passed to afterTest. */
interface WdioTestArg {
  uid?: string;
  title: string;
  fullTitle?: string;
  parent?: string;
}
interface WdioTestResult {
  passed: boolean;
  error?: { message?: string; stack?: string };
}

type AnyBrowser = {
  sessionId?: string;
  capabilities?: unknown;
  getLogs?: (logType: string) => Promise<Array<{ level?: string; message?: string; timestamp?: number }>>;
  takeScreenshot?: () => Promise<string>;
};

/**
 * Reporter + service plugin. The same class runs in both the launcher (main)
 * process and each worker process; WDIO only invokes the hooks that match the
 * current process. Launcher hooks (onPrepare/onComplete) create and finalize
 * the BrowserStack Test Observability build. Worker hooks (before/afterCommand
 * /afterTest) capture browser console logs and failure screenshots so the
 * dashboard shows context, even though tests don't run on BrowserStack itself.
 */
export default class BstackService {
  // All internal state uses ECMAScript-private (#) fields so the class stays
  // structurally assignable to WDIO's ServiceInstance interface. TS `private`
  // would add a nominal brand that breaks assignability against the plain
  // ServiceInstance interface.
  // ---- Launcher state ----
  #buildId: string | undefined;
  #dashboardUrl: string | undefined;
  #tmRunId: string | undefined;
  /**
   * Numeric project id for the configured TM project, resolved from
   * `listTmProjects` during onPrepare. Used to build dashboard URLs that
   * match the TM web UI's URL format (`/projects/<numeric>/test-runs/<numeric>/folder`).
   */
  #tmNumericProjectId: string | undefined;
  #tmDashboardUrl: string | undefined;
  #startedAt = '';
  #signalHandlersInstalled = false;
  #finalizing = false;

  // ---- Worker state ----
  #browser: AnyBrowser | undefined;

  readonly #options: ServiceOptions;

  // The option type is widened to WebdriverIO.ServiceOption to satisfy WDIO's
  // ServiceClass contract under contravariant constructor params. At runtime
  // the user passes our specific ServiceOptions via wdio.conf.ts.
  constructor(
    options: WebdriverIO.ServiceOption | ServiceOptions,
    _capabilities?: unknown,
    _config?: unknown,
  ) {
    this.#options = options as ServiceOptions;
  }

  // =====================================================================
  // Launcher hooks
  // =====================================================================

  async onPrepare(config: unknown, capabilities: unknown): Promise<void> {
    const observabilityEnabled = this.#options.observability?.enabled !== false;
    const tmEnabled = !!this.#options.testManagement?.projectId;

    if (!observabilityEnabled && !tmEnabled) {
      console.warn(
        '[wdio-bstack-reporter] Both Observability and Test Management are disabled — service will no-op.',
      );
      return;
    }

    if (observabilityEnabled && this.#options.reuseExistingBuild !== false) {
      const ctx = readBuildContext();
      if (ctx.buildId && ctx.apiMode) {
        this.#buildId = ctx.buildId;
        console.log(
          `[wdio-bstack-reporter] Reusing existing build ${ctx.buildId} (apiMode=${ctx.apiMode})`,
        );
        this.#installSignalHandlers();
        return;
      }
    }

    let auth;
    try {
      auth = resolveAuth(this.#options);
    } catch (err) {
      console.error(`[wdio-bstack-reporter] ${(err as Error).message}`);
      console.error('[wdio-bstack-reporter] Skipping build creation; reporter will no-op.');
      return;
    }
    const apiMode = resolveApiMode(this.#options);
    const { batchId, source: batchSource } = resolveBatchId(this.#options);
    const projectName = this.#options.projectName ?? 'webdriverio';

    // BS auto-creates a TM project when an Observability build streams
    // events with a project_name no existing TM project matches. The guard
    // refuses to even start the build until the user pre-creates a matching
    // TM project (or fixes a projectName typo). On by default; opt out
    // explicitly with `preventTmAutoCreate: false`.
    //
    // The same `GET /api/v2/projects` response also powers the
    // projectName ↔ testManagement.projectId cross-check below — so a
    // misconfigured projectId can't silently land results in the wrong TM
    // project even if projectName matches some other project's name.
    const tmProjectId = this.#options.testManagement?.projectId;
    if (this.#options.preventTmAutoCreate !== false || tmProjectId) {
      let existing;
      try {
        existing = await listTmProjects(auth);
      } catch (err) {
        if (this.#options.preventTmAutoCreate !== false) {
          console.error(
            '[wdio-bstack-reporter] preventTmAutoCreate: failed to list TM projects:',
            err,
          );
          console.error(
            '[wdio-bstack-reporter] Refusing to send the build; remove preventTmAutoCreate or fix credentials.',
          );
          return;
        }
        // If only the cross-check needed it, log and continue — TM call will fail later anyway.
        console.warn(
          '[wdio-bstack-reporter] Could not list TM projects for projectId/name cross-check:',
          err,
        );
        existing = undefined;
      }

      const fail = (message: string): never => {
        // WDIO's launcher swallows thrown errors from onPrepare and runs
        // workers anyway, so throwing alone leaves the user staring at
        // already-executing specs. Logging then exiting non-zero is what
        // @wdio/browserstack-service does for unrecoverable misconfig.
        // The throw is for unit tests (which stub process.exit).
        console.error(message);
        process.exit(1);
      };

      if (existing && this.#options.preventTmAutoCreate !== false) {
        const names = new Set(existing.map((p) => p.name));
        if (!names.has(projectName)) {
          const known = [...names].map((n) => JSON.stringify(n)).join(', ') || '(none)';
          fail(
            `[wdio-bstack-reporter] preventTmAutoCreate: projectName ${JSON.stringify(projectName)} does not match any existing Test Management project. ` +
              `Sending this build would cause BrowserStack to auto-provision a new TM project. ` +
              `Existing TM project names: ${known}. ` +
              `Pre-create one with that name (TM dashboard) or change projectName to match.`,
          );
        }
      }

      if (existing && tmProjectId) {
        const byId = existing.find((p) => p.identifier === tmProjectId);
        if (!byId) {
          const known =
            existing.map((p) => `${p.identifier} (${JSON.stringify(p.name)})`).join(', ') || '(none)';
          fail(
            `[wdio-bstack-reporter] testManagement.projectId ${JSON.stringify(tmProjectId)} does not exist in this account. ` +
              `Existing project ids: ${known}.`,
          );
        }
        // Capture the numeric project id for dashboard URL building. The
        // BS web UI's URL pattern is /projects/<numeric>/test-runs/<numeric>/folder,
        // not the identifier-based path.
        if (byId?.numericId) this.#tmNumericProjectId = byId.numericId;
        if (byId && byId.name !== projectName) {
          fail(
            `[wdio-bstack-reporter] Mismatch: testManagement.projectId ${JSON.stringify(tmProjectId)} has name ${JSON.stringify(byId.name)}, but projectName is ${JSON.stringify(projectName)}. ` +
              `Observability would group this build under one TM project while results post to another. ` +
              `Fix: set projectName to ${JSON.stringify(byId.name)}, or point projectId at the project named ${JSON.stringify(projectName)}.`,
          );
        }
      }
    }

    this.#startedAt = new Date().toISOString();
    if (this.#options.spoolDir) process.env[ENV.SPOOL_DIR] = this.#options.spoolDir;

    if (!observabilityEnabled) {
      console.log(
        '[wdio-bstack-reporter] Observability disabled (observability.enabled=false); reporter will no-op.',
      );
      // Skip build creation entirely. TM block below still runs if configured.
      if (tmEnabled) {
        const tm = this.#options.testManagement!;
        const wantsDiscovery = tm.scopeFromSpecs === true || tm.preflightCheck !== false;
        const discovery = wantsDiscovery
          ? await this.#discoverScope(config, auth)
          : { expected: undefined, valid: undefined };
        await this.#createTmRun(auth, batchId, discovery.valid);
        if (tm.preflightCheck !== false && discovery.expected) {
          this.#reportPreflight(discovery.expected, discovery.valid);
        }
        this.#installSignalHandlers();
      }
      return;
    }

    const platforms = sanitizeCapabilities(capabilities);
    if (platforms.length > 1) {
      console.log(
        `[wdio-bstack-reporter] Build covers ${platforms.length} platform(s): ${platforms
          .map(describeCap)
          .join(', ')}`,
      );
    }

    const client = createClient({ apiMode, ...auth });
    const ci = detectCI();
    const input: BuildCreateInput = {
      name: this.#options.buildName ?? defaultRunName(batchId),
      project_name: projectName,
      build_identifier: batchId,
      started_at: this.#startedAt,
      framework: 'webdriverio',
      sdk_version: SDK_VERSION,
      language: 'typescript',
      ...(this.#options.tags ? { tags: this.#options.tags } : {}),
      ...(this.#options.meta ? { meta: this.#options.meta } : {}),
      ...(platforms.length > 0
        ? {
            platforms: platforms.map((p) => ({
              ...(p.browser ? { browser: p.browser } : {}),
              ...(p.browserVersion ? { browser_version: p.browserVersion } : {}),
              ...(p.platform ? { platform: p.platform } : {}),
              ...(p.device ? { device: p.device } : {}),
            })),
          }
        : {}),
      ...(ci
        ? {
            ci_info: {
              name: ci.provider,
              ...(ci.buildUrl ? { build_url: ci.buildUrl } : {}),
              ...(ci.branch ? { branch: ci.branch } : {}),
              ...(ci.commit ? { commit: ci.commit } : {}),
            },
          }
        : {}),
    };

    try {
      const result = await client.createBuild(input);
      this.#buildId = result.buildId;
      this.#dashboardUrl = result.dashboardUrl;
      writeBuildContext({
        buildId: result.buildId,
        ...(result.jwt ? { jwt: result.jwt } : {}),
        apiMode,
        allowScreenshots: result.allowScreenshots,
        dashboardUrl: result.dashboardUrl,
      });
      console.log(
        `[wdio-bstack-reporter] Build created: ${result.buildId} (batchId=${batchId} source=${batchSource} apiMode=${apiMode})`,
      );
      console.log(`[wdio-bstack-reporter] Dashboard: ${result.dashboardUrl}`);
      this.#installSignalHandlers();
    } catch (err) {
      console.error('[wdio-bstack-reporter] Failed to create build:', err);
      console.error('[wdio-bstack-reporter] Reporter will no-op for this run.');
    }

    // Optional: create a Test Management run alongside the Observability build.
    if (this.#options.testManagement?.projectId) {
      // When scopeFromSpecs (or preflight) is on, discover TC IDs first so
      // run creation can pre-register exactly the expected scenarios.
      const tm = this.#options.testManagement;
      const wantsDiscovery = tm.scopeFromSpecs === true || tm.preflightCheck !== false;
      const discovery = wantsDiscovery
        ? await this.#discoverScope(config, auth)
        : { expected: undefined, valid: undefined };
      await this.#createTmRun(auth, batchId, discovery.valid);
      if (tm.preflightCheck !== false && discovery.expected) {
        this.#reportPreflight(discovery.expected, discovery.valid);
      }
    }
  }

  /**
   * Discover `[TC-NNN]` ids in the spec files and cross-check against the
   * project catalog. Returns the expected set and the subset that exists
   * in the catalog (the only IDs safe to send to the TM API).
   */
  async #discoverScope(
    config: unknown,
    auth: { username: string; accessKey: string },
  ): Promise<{ expected: Set<string> | undefined; valid: Set<string> | undefined }> {
    const tm = this.#options.testManagement;
    if (!tm?.projectId) return { expected: undefined, valid: undefined };
    const cfg = (config ?? {}) as { specs?: ReadonlyArray<string | string[]> };
    const specs = cfg.specs;
    if (!specs || specs.length === 0) return { expected: undefined, valid: undefined };

    const rawPattern = tm.preflightTagPattern ?? /\[(TC-\d+)\]/;
    const pattern = rawPattern instanceof RegExp ? rawPattern : new RegExp(rawPattern);
    let expected: Set<string>;
    try {
      expected = await extractTcIdsFromSpecs(specs, pattern);
    } catch (err) {
      console.warn('[wdio-bstack-reporter] preflight: spec discovery failed:', err);
      return { expected: undefined, valid: undefined };
    }
    if (expected.size === 0) return { expected, valid: new Set<string>() };

    let existing: Set<string>;
    try {
      const tmClient = new TestManagementClient({
        username: auth.username,
        accessKey: auth.accessKey,
        projectId: tm.projectId,
      });
      existing = await tmClient.listAllCaseIdentifiers();
    } catch (err) {
      console.warn('[wdio-bstack-reporter] preflight: failed to list project cases:', err);
      return { expected, valid: undefined };
    }
    const valid = new Set([...expected].filter((id) => existing.has(id)));
    return { expected, valid };
  }

  async #createTmRun(
    auth: { username: string; accessKey: string },
    batchId: string,
    scope: Set<string> | undefined,
  ): Promise<void> {
    const tm = this.#options.testManagement;
    if (!tm?.projectId) return;
    const client = new TestManagementClient({
      username: auth.username,
      accessKey: auth.accessKey,
      projectId: tm.projectId,
      ...(this.#tmNumericProjectId ? { numericProjectId: this.#tmNumericProjectId } : {}),
    });
    try {
      const useScope = tm.scopeFromSpecs === true && scope && scope.size > 0;
      const result = await client.createRun({
        name: tm.runName ?? this.#options.buildName ?? defaultRunName(batchId),
        ...(tm.description ? { description: tm.description } : {}),
        ...(tm.tags ? { tags: tm.tags } : {}),
        ...(tm.folderIds ? { folder_ids: tm.folderIds } : {}),
        ...(useScope
          ? { test_cases: [...scope!].sort(), include_all: false }
          : { include_all: tm.includeAll ?? true }),
        run_state: 'in_progress',
      });
      this.#tmRunId = result.runId;
      this.#tmDashboardUrl = result.dashboardUrl;
      process.env[ENV.TM_PROJECT_ID] = tm.projectId;
      process.env[ENV.TM_RUN_ID] = result.runId;
      process.env[ENV.TM_DASHBOARD_URL] = result.dashboardUrl;
      console.log(
        `[wdio-bstack-reporter] Test Management run created: ${result.runId} (project=${tm.projectId})`,
      );
      if (useScope) {
        console.log(
          `[wdio-bstack-reporter] Run scoped to ${scope!.size} TC ID(s) from spec discovery (scopeFromSpecs)`,
        );
      }
      console.log(`[wdio-bstack-reporter] TM dashboard: ${result.dashboardUrl}`);
    } catch (err) {
      console.error('[wdio-bstack-reporter] Failed to create Test Management run:', err);
      console.error('[wdio-bstack-reporter] Continuing without TM reporting.');
    }
  }

  #reportPreflight(expected: Set<string>, valid: Set<string> | undefined): void {
    const tm = this.#options.testManagement;
    if (!tm?.projectId) return;
    if (expected.size === 0) return;
    if (!valid) return; // catalog fetch failed; skip silent-drops warning
    const missing = [...expected]
      .filter((id) => !valid.has(id))
      .sort((a, b) => {
        const ai = parseInt(a.replace(/^TC-/, ''), 10) || 0;
        const bi = parseInt(b.replace(/^TC-/, ''), 10) || 0;
        return ai - bi;
      });
    // Share the missing set with worker reporters so `enforceTcCatalog: true`
    // can drop their Observability events. Always written (cheap) so the
    // option works without extra wiring on the user's side.
    if (missing.length > 0) {
      process.env[ENV.DROPPED_TC_IDS] = missing.join(',');
    } else {
      delete process.env[ENV.DROPPED_TC_IDS];
    }
    if (missing.length === 0) {
      console.log(
        `[wdio-bstack-reporter] preflight: all ${expected.size} TC ID(s) found in ${tm.projectId} ✓`,
      );
      return;
    }
    console.warn(
      `[wdio-bstack-reporter] preflight: ${missing.length} of ${expected.size} TC ID(s) missing from project ${tm.projectId}:`,
    );
    console.warn(`  ${missing.join(', ')}`);
    console.warn(
      `  Results posted for these will be silently dropped by the TM API.`,
    );
    console.warn(
      `  Pre-create them via the dashboard or CSV import before the next run.`,
    );
  }

  async onComplete(
    _exitCode: number,
    _config: unknown,
    _caps: unknown,
    results?: RunResults,
  ): Promise<void> {
    await this.#finalize(results, /*forced*/ false);
  }

  // =====================================================================
  // Worker hooks (run inside each spec worker)
  // =====================================================================

  before(_caps: unknown, _specs: string[], browser: AnyBrowser): void {
    this.#browser = browser;
  }

  async afterCommand(
    _commandName: string,
    _args: unknown[],
    _result: unknown,
    _error?: Error,
  ): Promise<void> {
    if (!this.#options.captureLogs) return;
    if (!this.#browser?.getLogs) return;
    try {
      const entries = await this.#browser.getLogs('browser');
      if (!entries || entries.length === 0) return;
      const emitter = getSessionEmitter();
      if (!emitter) return;
      const event: LogCreatedEvent = {
        event_type: 'LogCreated',
        logs: entries.map((e) => ({
          timestamp: new Date(e.timestamp ?? Date.now()).toISOString(),
          kind: levelToKind(e.level),
          message: e.message ?? '',
        })),
      };
      emitter.enqueue(event);
    } catch {
      // Some drivers don't support getLogs('browser') — silently ignore.
    }
  }

  async afterTest(test: WdioTestArg, _ctx: unknown, result: WdioTestResult): Promise<void> {
    if (result.passed) return;
    if (this.#options.captureScreenshotsOnFailure === false) return;
    if (!this.#browser) return;
    const emitter = getSessionEmitter();
    if (!emitter) return;
    const ctx = readBuildContext();
    if (ctx.allowScreenshots === false) return;
    const dataUrl = await takeScreenshotIfPossible(this.#browser);
    if (!dataUrl) return;
    const event: LogCreatedEvent = {
      event_type: 'LogCreated',
      logs: [
        {
          timestamp: new Date().toISOString(),
          kind: 'ERROR',
          message: `[screenshot] ${test.fullTitle ?? test.title}: ${dataUrl.slice(0, 64)}…`,
        },
      ],
    };
    emitter.enqueue(event);
    void emitter.uploadScreenshot({
      testTitle: test.fullTitle ?? test.title,
      dataUrl,
    });
  }

  // =====================================================================
  // Internal
  // =====================================================================

  #installSignalHandlers(): void {
    if (this.#signalHandlersInstalled) return;
    this.#signalHandlersInstalled = true;
    const finalize = (signal: NodeJS.Signals) => {
      if (this.#finalizing) return;
      this.#finalizing = true;
      console.error(`[wdio-bstack-reporter] Caught ${signal}; finalizing build…`);
      this.#finalize(undefined, /*forced*/ true)
        .catch(() => undefined)
        .finally(() => {
          // Re-raise the signal with default handler so the process actually exits.
          process.kill(process.pid, signal);
        });
    };
    const onSigint = () => finalize('SIGINT');
    const onSigterm = () => finalize('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  async #finalize(results: RunResults | undefined, forced: boolean): Promise<void> {
    if (!this.#buildId && !this.#tmRunId) return;
    if (this.#buildId && this.#options.reuseExistingBuild !== false && !forced) {
      const ctx = readBuildContext();
      if (ctx.buildId !== this.#buildId) return;
    }

    const auth = (() => {
      try {
        return resolveAuth(this.#options);
      } catch {
        return undefined;
      }
    })();
    if (!auth) return;

    const apiMode = resolveApiMode(this.#options);
    const ctx = readBuildContext();
    const failed = forced || (results?.failed ?? 0) > 0;
    const finishedAt = new Date().toISOString();
    const stopMeta =
      results || forced
        ? { ...(results ? { results } : {}), ...(forced ? { aborted: true } : {}) }
        : undefined;

    if (this.#buildId) {
      const rawClient = createClient({ apiMode, ...auth });
      rawClient.attachBuild({ buildId: this.#buildId, ...(ctx.jwt ? { jwt: ctx.jwt } : {}) });
      const client = this.#options.spoolDir
        ? wrapClientWithSpool(rawClient, this.#options.spoolDir)
        : rawClient;
      try {
        // Match the official @wdio/browserstack-service stop body shape:
        // a single PUT with `stop_time` is what closes the build on the
        // Observability dashboard. We were sending `finished_at` (silently
        // ignored), which is why builds appeared stuck "running" even after
        // PUT /stop returned 200. The BuildUpdate event is NOT something the
        // official service emits — removed.
        await client.stopBuild({
          stop_time: finishedAt,
          result: failed ? 'failed' : 'passed',
          ...(stopMeta ? { meta: stopMeta } : {}),
        });
        if (this.#dashboardUrl) {
          console.log(`[wdio-bstack-reporter] Build finalized: ${this.#dashboardUrl}`);
        }
      } catch (err) {
        console.error('[wdio-bstack-reporter] Failed to stop build:', err);
      } finally {
        if (!forced) clearBuildContext();
      }
    }

    // Close the Test Management run too if we created one — unless the user
    // opted out via autoCloseTestRun: false (e.g. multi-job CI pipelines that
    // need to keep posting results to the same run after WDIO exits).
    const tmOpts = this.#options.testManagement;
    if (this.#tmRunId && tmOpts?.projectId) {
      if (tmOpts.autoCloseTestRun === false) {
        console.log(
          `[wdio-bstack-reporter] TM run left open (autoCloseTestRun=false): ${this.#tmDashboardUrl ?? this.#tmRunId}`,
        );
        if (!forced) {
          delete process.env[ENV.TM_PROJECT_ID];
          delete process.env[ENV.TM_RUN_ID];
          // TM_DASHBOARD_URL stays set (see clearBuildContext rationale).
        }
      } else {
        try {
          const tm = new TestManagementClient({
            username: auth.username,
            accessKey: auth.accessKey,
            projectId: tmOpts.projectId,
          });
          tm.attachRun(this.#tmRunId);
          await tm.closeRun({ run_state: 'done' });
          if (this.#tmDashboardUrl) {
            console.log(`[wdio-bstack-reporter] TM run closed: ${this.#tmDashboardUrl}`);
          }

          // Sweep BS-auto-created shadow runs (named `<buildName> #N`) that
          // BS provisions for every Observability build but never closes.
          // We do NOT mirror our authoritative results onto them: doing so
          // tags the shadow with a "Manually Overridden" badge in the BS
          // dashboard, which QA leads find more confusing than the stat
          // mismatch. Shadow keeps BS's natural classification.
          //
          // Skip if Observability is disabled — no Observability build means
          // BS never auto-provisions a shadow run, so nothing to clean up.
          const observabilityWasEnabled =
            this.#options.observability?.enabled !== false;
          if (observabilityWasEnabled && tmOpts.closeAutoCreatedRuns !== false) {
            await this.#sweepAutoCreatedRuns(tm);
          }
        } catch (err) {
          console.error('[wdio-bstack-reporter] Failed to close TM run:', err);
        } finally {
          if (!forced) {
            // Clear sensitive/behavioral env vars so a wrapper that runs
            // multiple WDIO invocations gets a clean slate. TM_DASHBOARD_URL
            // is intentionally left set — it's non-sensitive and useful to
            // user-defined services that read it in their own onComplete.
            delete process.env[ENV.TM_PROJECT_ID];
            delete process.env[ENV.TM_RUN_ID];
          }
        }
      }
    }
  }

  async #sweepAutoCreatedRuns(tm: TestManagementClient): Promise<void> {
    const buildName = this.#options.buildName;
    if (!buildName) return; // can't filter without a known prefix
    const tmOpts = this.#options.testManagement;
    const waitMs = tmOpts?.sweepWaitMs ?? 30_000;
    const intervalMs = tmOpts?.sweepIntervalMs ?? 5_000;

    // pollAndClose strictly enforces the buildName prefix on every /close
    // call, so concurrent CI jobs (different buildName) and earlier WDIO
    // runs in the same project are never touched. Loop exits early once
    // we've closed ≥1 run AND a follow-up poll is empty.
    const result = await pollAndClose(
      tm,
      { nameStartsWith: buildName, waitMs, intervalMs },
      {
        log: (msg) => {
          if (this.#options.debug) console.log(`[wdio-bstack-reporter] sweep: ${msg}`);
        },
      },
    );
    if (result.closed > 0) {
      console.log(
        `[wdio-bstack-reporter] Closed ${result.closed} auto-created TM run(s) named like ${JSON.stringify(buildName)} (in ${result.polls} poll(s))`,
      );
    }
    if (result.timedOut && result.closed === 0 && this.#options.debug) {
      console.log(
        `[wdio-bstack-reporter] sweep: ${Math.round(waitMs / 1000)}s budget elapsed without finding a shadow run. ` +
          `If your BS pipeline runs slow, set testManagement.sweepWaitMs higher or use the standalone "wdio-bstack-reporter sweep" CLI as a follow-up CI step.`,
      );
    }
  }
}

/**
 * Default run/build name when neither `buildName` nor `tm.runName` was set.
 * The auto-generated batchId already starts with `wdio-`, so don't double the
 * prefix — only prepend when batchId came from CI / env (e.g. a numeric
 * pipeline id like `12345`).
 */
function defaultRunName(batchId: string): string {
  return batchId.startsWith('wdio-') ? batchId : `wdio-${batchId}`;
}

function levelToKind(level: string | undefined): 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' {
  switch ((level ?? '').toUpperCase()) {
    case 'SEVERE':
    case 'ERROR':
      return 'ERROR';
    case 'WARNING':
    case 'WARN':
      return 'WARN';
    case 'DEBUG':
    case 'FINE':
    case 'FINER':
    case 'FINEST':
      return 'DEBUG';
    default:
      return 'INFO';
  }
}
