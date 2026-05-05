# wdio-bstack-reporter

[![npm version](https://img.shields.io/npm/v/wdio-bstack-reporter.svg)](https://www.npmjs.com/package/wdio-bstack-reporter)
[![CI](https://github.com/jemishgopani/wdio-bstack-reporter/actions/workflows/ci.yml/badge.svg)](https://github.com/jemishgopani/wdio-bstack-reporter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/wdio-bstack-reporter.svg)](https://nodejs.org/)

A WebdriverIO **reporter + launcher service** that streams test results live to
BrowserStack — both **Test Observability** (live runs / debugging) and
**Test Management** (your TC-NNN catalog with priorities, assignees, history).
Designed for teams whose tests run on their own infrastructure (local Selenium,
SauceLabs, internal grid) but who want their results reported to BrowserStack
nonetheless.

- 🔴 Live test rows on Observability within ~2 seconds of each test finishing
- 🎯 Direct results into Test Management (`TC-NNN` → `Passed`/`Failed`/`Blocked`)
- 🪝 Smart hook-failure handling (orphan synthesis, teardown attribution, beforeAll cascade)
- 🛬 Pre-flight check that warns about missing TC IDs **before** the run starts
- 🔌 Survives JWT expiry, network blips, SIGINT, parallel workers, retries

---

## Contents

- [Architecture](#architecture)
- [Install](#install)
- [Quick start](#quick-start)
- [Test Observability](#test-observability)
- [Test Management](#test-management)
- [Test identification](#test-identification)
- [Hook-failure handling](#hook-failure-handling)
- [Configuration reference](#configuration-reference)
  - [Service options](#service-options)
  - [Service options · `testManagement`](#service-options--testmanagement)
  - [Reporter options](#reporter-options)
  - [Environment variables](#environment-variables)
- [BrowserStack TM API quirks](#browserstack-tm-api-quirks)
- [Failure modes](#failure-modes)
- [Development](#development)

---

## Architecture

WDIO spawns one worker process per spec. Each worker has its own reporter
instance with no shared memory. To attach all workers to the **same**
BrowserStack build, the build must be created **before** workers spawn —
that's a launcher-service responsibility, not a reporter's.

```
┌────────────────────────────────────────────────────────────┐
│ WDIO main process                                          │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ BstackService                                        │   │
│ │   onPrepare                                          │   │
│ │     ├─ create Observability build                    │   │
│ │     ├─ create Test Management run                    │   │
│ │     ├─ pre-flight: warn about missing TC IDs         │   │
│ │     └─ install SIGINT/SIGTERM handler                │   │
│ │   onComplete                                         │   │
│ │     ├─ stop Observability build                      │   │
│ │     └─ close Test Management run (or leave open)     │   │
│ └──────────────────────────────────────────────────────┘   │
│                  │                                          │
│                  └─ exports BSTACK_REPORTER_* env vars      │
│                  ▼                                          │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ Worker processes (N parallel)                        │   │
│ │ ┌──────────────────────────────────────────────────┐ │   │
│ │ │ BstackReporter (reads env vars)                  │ │   │
│ │ │   ├─ Observability batcher (events, 2s flush)    │ │   │
│ │ │   ├─ Test Management batcher (results, 300/req)  │ │   │
│ │ │   ├─ buffered TM result (1-cycle) for hook       │ │   │
│ │ │   │   teardown annotation                        │ │   │
│ │ │   └─ orphan-synthesis on hook failure            │ │   │
│ │ │                                                  │ │   │
│ │ │ BstackService (worker hooks):                    │ │   │
│ │ │   ├─ before(): grab `browser` reference          │ │   │
│ │ │   ├─ afterCommand(): browser.getLogs() if opted  │ │   │
│ │ │   └─ afterTest(): screenshot on failure          │ │   │
│ │ └──────────────────────────────────────────────────┘ │   │
│ └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

If the env vars are missing (e.g. the service didn't run), the reporter logs
a warning and no-ops. It never crashes the test run.

## Install

```sh
npm install --save-dev wdio-bstack-reporter
```

Peer deps: `@wdio/reporter` and `@wdio/types` (>= 9). Node >= 18.

## Quick start

```ts
// wdio.conf.ts
import { BstackService } from 'wdio-bstack-reporter';

export const config: WebdriverIO.Config = {
  services: [[BstackService, {
    projectName: 'my-app',
    buildName: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
    apiMode: 'collector',
    tags: ['regression'],

    // (optional) push results into Test Management too
    testManagement: {
      projectId: 'PR-1234',                   // required if you want TM
      runName: `nightly-${new Date().toISOString().slice(0, 10)}`,
    },
  }]],

  reporters: [
    'spec',
    ['bstack', {
      tagPattern: /\[(TC-\d+)\]/,             // extract TC-XX from titles
      failedAfterHook: true,                  // teardown failures fail the test
      failOnSetupHook: false,                 // suite-wide red on setup failures (opt-in)
    }],
  ],
};
```

Set credentials in your environment:

```sh
export BROWSERSTACK_USERNAME=...
export BROWSERSTACK_ACCESS_KEY=...
```

Or pass `username`/`accessKey` directly in service options.

```ts
it('[TC-123] should authenticate the user', async () => { /* ... */ });
```

That's it. Each test's `[TC-XXX]` tag becomes the BrowserStack identifier and
also lands in the `tags` array, so the dashboard is filterable by ticket ID.

### Observability + TM are independent

You can run any combination:

| Observability | Test Management | How to enable |
| --- | --- | --- |
| ✅ | ❌ | Default — just configure the service. |
| ✅ | ✅ | Default + set `testManagement.projectId`. |
| ❌ | ✅ | `observability: { enabled: false }` + `testManagement.projectId`. No build, no events streamed; only TM run + results. The reporter no-ops gracefully. |
| ❌ | ❌ | `observability: { enabled: false }` and no `testManagement` — service warns and no-ops, useful for sanity-checking config. |

> **Note:** `closeAutoCreatedRuns` (default `true`) only runs when Observability
> is enabled. With Observability off, BS doesn't auto-provision a shadow run
> in the first place, so the inline sweep is skipped — there's nothing to
> clean up.

#### Observability-only (default)

```ts
services: [[BstackService, {
  projectName: 'my-app',
  buildName: process.env.GITHUB_RUN_ID,
}]];
```

#### TM-only (no Observability dashboard, just live TM run)

```ts
services: [[BstackService, {
  projectName: 'my-app',                     // must match an existing TM project
  observability: { enabled: false },
  testManagement: {
    projectId: 'PR-1234',
    scopeFromSpecs: true,
  },
}]];
```

#### Both Observability + TM (full live mode)

See the Quick Start example above.

#### Sharing one Observability build across multiple WDIO invocations

```bash
# Same CI job runs `npx wdio` twice and wants both into one build:
export BSTACK_BATCH_ID="$GITHUB_RUN_ID"
npx wdio run wdio.smoke.conf.ts
npx wdio run wdio.regression.conf.ts
```

The first invocation creates the build and writes `BSTACK_REPORTER_BUILD_ID`
to its own process env; the second invocation sees `reuseExistingBuild: true`
(default) and appends to the same build instead of creating a new one. To
force a new build per invocation despite the shared batchId, set
`reuseExistingBuild: false`.

---

## Test Observability

The default target. Every test event flows live:

| WDIO hook | BrowserStack event |
| --- | --- |
| `onTestStart` | `TestRunStarted` |
| `onTestPass` | `TestRunFinished { result: 'passed' }` |
| `onTestFail` | `TestRunFinished { result: 'failed', failure: [...] }` |
| `onTestSkip` / `onTestPending` | `TestRunFinished { result: 'skipped' }` |
| `onTestRetry` | synth `TestRunFinished(failed)` for the previous attempt; the next attempt's `Started` carries `retries: N` |
| `onHookStart` / `onHookEnd` | `HookRunStarted` / `HookRunFinished` |
| (worker afterCommand if `captureLogs`) | `LogCreated` |
| (worker afterTest, on failure, if `captureScreenshotsOnFailure`) | `LogCreated` + screenshot upload to `/api/v1/screenshots` (collector only) |

### API surfaces

`apiMode` chooses where Observability events go:

| `apiMode` | URL | Auth | Notes |
| --- | --- | --- | --- |
| `'collector'` (default) | `collector-observability.browserstack.com/api/v1/batch` | JWT issued by `createBuild` | Live, batched (max 1000 events / 2s). Used by official BrowserStack SDKs. |
| `'rest'` | `api-observability.browserstack.com/start-build`, `/start-test-run`, etc. | HTTP Basic | Officially documented, rate-limited (1600 req/5min). One HTTP call per event. Screenshots not supported. |

Both deliver the same events to the same dashboard.

### Execution batches

A *batch* is the logical group of test runs that share one BrowserStack build.
The batch ID is resolved in this order (first match wins):

1. Service option `batchId`
2. Env var `BSTACK_BATCH_ID`
3. CI auto-detection: GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite
4. A generated UUID (one batch per `npx wdio` invocation)

To share one Observability build across multiple `wdio` invocations in the
same CI job, set `BSTACK_BATCH_ID` to the same value. The service detects
the existing build via env vars and reuses it.

---

## Test Management

BrowserStack has two products that share auth:

- **Test Observability** — `observability.browserstack.com` — live runs, debugging, failure history.
- **Test Management** — `test-management.browserstack.com` — your test case catalog with priorities, assignees, labels, manual runs, traceability.

This reporter writes to **both** when `testManagement.projectId` is set. The TM
push is a separate code path; results are referenced by the `TC-NNN` ID
extracted via `tagPattern` (or `getTestIdentifier`).

```ts
services: [[BstackService, {
  testManagement: {
    projectId: 'PR-1234',           // required, find in TM project URL
    runName: 'nightly-2026-05-01',  // optional, default = buildName
    description: 'Sprint 12 regression',
    tags: ['regression'],
    includeAll: true,               // run lists every TC (untouched stay Untested)
    scopeFromSpecs: false,          // OR: scope run to TC IDs found in specs (see below)
    folderIds: [42, 43],            // scope to specific folders
    preflightCheck: true,           // warn before run if TC IDs are missing
    preflightTagPattern: /\[(TC-\d+)\]/,
    autoCloseTestRun: true,         // close run on onComplete (default true)
  },
}]],

reporters: [['bstack', {
  tagPattern: /\[(TC-\d+)\]/,       // identifier extraction
}]],
```

### Status mapping

| WDIO test outcome | TM status |
| --- | --- |
| `onTestPass` | `Passed` |
| `onTestFail` | `Failed` |
| `onTestSkip` / `onTestPending` (no ancestor hook failed) | `Skipped` |
| `onTestSkip` / `onTestPending` + ancestor `before*` hook failed | `Blocked` (or `Failed` if `failOnSetupHook: true`) |
| `onTestPass` + `afterEach`/`afterAll` failed (`failedAfterHook: true`, default) | `Failed` |
| `onTestPass` + `afterEach`/`afterAll` failed (`failedAfterHook: false`) | `Passed` (with description annotation) |

### Catalog enforcement (`enforceTcCatalog`)

By default, every `[TC-NNN]` in your specs streams events to **Test
Observability** — even if the ID isn't in your TM catalog. That's useful
for debugging orphan / typo tests, but it makes the BS-auto-created shadow
TM run (`local-...#N`) include phantom entries that aren't in your real
catalog. Two views diverge:

| View | Without `enforceTcCatalog` | With `enforceTcCatalog: true` |
| --- | --- | --- |
| Explicit run (`wdio-...`) | Scoped to catalog ✓ | Scoped to catalog ✓ |
| BS shadow run (`local-...#N`) | Includes orphans ✗ | Scoped to catalog ✓ |

Opt in via reporter options:

```ts
reporters: [['bstack', {
  tagPattern: /\[(TC-\d+)\]/,
  enforceTcCatalog: true,    // drop events for orphan TC IDs
}]],
```

How it works: the launcher's preflight resolves the missing-from-catalog
TC IDs and writes them to `BSTACK_REPORTER_DROPPED_TC_IDS`. The reporter
reads that set and skips both `TestRunStarted` and `TestRunFinished`
events for any test whose extracted TC ID is in it. Requires
`testManagement.projectId` + `preflightCheck` to be active.

**Tradeoff**: orphan tests vanish from BS entirely — no Observability
timeline, no screenshots, no hook trace. The test still runs locally and
its pass/fail is in your spec output, but BS dashboards show nothing for
it. Use only when out-of-catalog TC IDs are intentional placeholders /
experiments. Otherwise, prefer pre-creating the missing cases in PR-####.

### Pre-flight check

When you create a TM run, the launcher statically parses every spec file in
`config.specs`, extracts every `[TC-NNN]` tag, then `GET /test-cases` on the
project and **warns about IDs that aren't in the catalog** before any worker
spawns:

```
[wdio-bstack-reporter] preflight: 4 of 60 TC ID(s) missing from project PR-1234:
  TC-201, TC-202, TC-203, TC-204
  Results posted for these will be silently dropped by the TM API.
  Pre-create them via the dashboard or CSV import before the next run.
```

This is critical because the TM API returns **`200 success: true`** for results
posted against unknown identifiers and **silently drops them** (see
[BrowserStack TM API quirks](#browserstack-tm-api-quirks)). Without the
pre-flight, a typo in a TC tag costs you a whole run's worth of data.

The check is on by default. Set `preflightCheck: false` to skip it (one extra
GET per run is the only cost). `preflightTagPattern` overrides the default
`/\[(TC-\d+)\]/` if your team uses a different convention.

### Knowing what didn't execute (`scopeFromSpecs`)

`includeAll: true` makes every TC in the project visible in the run, but a
1000-case project shows 940 `Untested` even when the suite only ever
intended to run 60. To see *exactly the expected-vs-executed delta for this
run*, opt into:

```ts
testManagement: {
  projectId: 'PR-1234',
  scopeFromSpecs: true,   // run scope = TC IDs discovered in specs
}
```

What happens at startup:

1. Statically parse every spec file (same logic as `preflightCheck`).
2. Cross-reference the discovered IDs against `GET /test-cases` (drops
   unknown ones — TM silently drops POSTs to those anyway).
3. Create the TM run with `test_cases: [...]` set to the surviving list and
   `include_all: false`. Every expected TC starts as `Untested`.

As execution reports back, each TC flips to `Passed` / `Failed` /
`Skipped` / `Blocked`. **If the pipeline dies mid-run** (Ctrl-C, killed
worker, OOM, CI cancellation) anything that never reported still sits as
`Untested` in the run — and the count is precisely the scenarios that
didn't execute, not the whole catalog.

```
[wdio-bstack-reporter] Test Management run created: TR-200 (project=PR-1234)
[wdio-bstack-reporter] Run scoped to 60 TC ID(s) from spec discovery (scopeFromSpecs)
```

When `scopeFromSpecs: true`, the `includeAll` option is ignored.

> **Caveats.** Spec discovery is regex-based; dynamically generated test
> titles (template literals, `forEach`, helpers wrapping `it()`) won't be
> seen. For those suites stick with `includeAll: true`.

### Closing the run

By default `onComplete` calls `POST /test-runs/{id}/close`. Set
`autoCloseTestRun: false` to leave the run as `in_progress` so other CI jobs
or manual workflows can keep posting results to it.

---

## Test identification

For BrowserStack to merge runs of "the same test" across executions (history,
flake tracking, trends), each test needs a **stable identifier**.

**Default**: `${specFileRelativeToCwd}::${fullTitle}`. Stable until a file or
test gets renamed.

**Tag pattern (recommended)** — extract a stable ID from the test title:

```ts
reporters: [['bstack', {
  tagPattern: /\[([A-Z]+-\d+)\]/,    // matches "[TC-123]", "[JIRA-42]", etc.
}]],
```

```ts
it('[TC-123] should authenticate the user', async () => { /* ... */ });
```

The first capture group becomes the identifier and is also pushed into the
event's `tags` array. Multi-tag titles like `[TC-1] [JIRA-42] composite` work —
`TC-1` is the identifier, both end up as tags.

**Custom resolver** — for tests stored in your test management system:

```ts
reporters: [['bstack', {
  getTestIdentifier: (test, ctx) => {
    // ctx: { specFile, scopes, fullTitle }
    return myMap.get(ctx.fullTitle);  // or undefined to fall through
  },
}]],
```

The resolver runs per test in the worker. Returning `undefined` falls through
to `tagPattern`, then to the default file+title combo.

---

## Hook-failure handling

Mocha and WDIO together emit hook failures in awkward ways. This reporter
takes care of all four positions so the dashboard always tells the truth.

### `beforeEach` fails (most common path)

WDIO fires `onTestStart` for the test that's about to run, then `onHookEnd
(state=failed)` for the hook, then **never fires any test end event** for the
killed test. Without intervention the dashboard would show the test stuck "In
Progress" forever.

**This reporter** detects the orphan in `onHookEnd` and synthesizes a `pending`
finish event. Result:

- **Observability**: `TestRunFinished(skipped)` (synthesized) plus the hook's
  own `HookRunFinished(failed)` event.
- **Test Management**: `Blocked` with `Blocked by failing BEFORE_EACH hook
  "..." : <reason>` in the description.

### `beforeAll` fails (suite-wide cascade)

Mocha doesn't fire `onTestStart` for any of the suite's tests when `beforeAll`
fails — they simply never enter the runner. This reporter has no events to
attach to.

Two coping mechanisms:

| Option | Behavior |
| --- | --- |
| `failOnSetupHook: false` (default) | Affected tests don't appear in TM at all. The hook failure is visible in Observability via `HookRunFinished(failed)`. Best paired with `testManagement.includeAll: true` so the cases at least show as `Untested` in the run. |
| `failOnSetupHook: true` (opt-in) | Statically parses the spec file at runner start, then synthesizes a `Failed` test event for every `[TC-NNN]`-tagged test in the affected suite that hasn't otherwise been seen. **Recommended** for static suites; see [Caveat](#failonsetuphook-caveat). |

The same option also handles "Mocha bails the rest of a suite after a
beforeEach failure": all subsequent unran tests get `Failed` with the hook
reason instead of vanishing.

`failOnSetupHook: true` flips **both dashboards symmetrically** — TM goes
`Skipped`/`Blocked` → `Failed`, and the buffered Observability
`TestRunFinished` event flips `result` from `'skipped'` → `'failed'` with
the hook reason appended to its `failure` array. Without this symmetry, a
hook-blocked test would read Failed in TM but Skipped in Observability.

### `failOnSetupHook` caveat

The static parser is best-effort. It handles literal `it('title', ...)` calls
and template literals **without** expressions. It does not handle:

- Dynamic titles: `it(\`TC-${i}\`, ...)`, `forEach`-generated tests
- Helper functions wrapping `it()` (e.g. `myCustomIt('x', ...)`)
- `it.each([...])` parameterised tests

For dynamic suites, leave this off and pre-create the cases in TM.

### `afterEach` / `afterAll` fail (teardown)

The test itself was running fine, but cleanup blew up. By default
(`failedAfterHook: true`):

- **TM**: status flips from `Passed` → `Failed`, with
  `[AFTER_EACH hook "..." failed: <reason>]` appended to `description`.
- **Observability**: `result` flips from `passed` → `failed`, with the hook
  error appended to the `failure` array. Both dashboards stay in sync.

For `afterAll`, the annotation lands on the **last test in the suite** (the
one currently in the buffer when the hook runs).

To preserve the test's `Passed` status and only annotate the description, set
`failedAfterHook: false`.

---

## Configuration reference

### Service options

```ts
import { BstackService } from 'wdio-bstack-reporter';

services: [[BstackService, { /* options below */ }]];
```

| option | default | meaning |
| --- | --- | --- |
| `username` | `BROWSERSTACK_USERNAME` env | BrowserStack auth |
| `accessKey` | `BROWSERSTACK_ACCESS_KEY` env | BrowserStack auth |
| `apiMode` | `'collector'` | `'collector'` (default, batched, JWT) or `'rest'` (per-event, HTTP Basic) |
| `projectName` | `'webdriverio'` | Shown in Observability dashboard |
| `buildName` | `wdio-${batchId}` | Shown in Observability dashboard |
| `batchId` | auto | Override batch ID (see [Execution batches](#execution-batches)) |
| `tags` | — | Strings attached to the build |
| `meta` | — | Free-form metadata |
| `observability` | `{ enabled: true }` | Set `{ enabled: false }` to disable Observability entirely. Combine with `testManagement.projectId` for TM-only mode (no build created, reporter no-ops, no shadow run sweep). Both off → service warns and no-ops. |
| `reuseExistingBuild` | `true` | If env carries an existing build id (wrapping process), reuse it instead of creating a new one |
| `captureLogs` | `false` | Worker hook calls `browser.getLogs('browser')` after each command and emits `LogCreated` events |
| `captureScreenshotsOnFailure` | `true` | Worker `afterTest` hook takes a screenshot on failure and uploads it (collector only) |
| `spoolDir` | — | Directory to write JSONL when an event/result POST fails after retries. See [Offline spooling](#offline-spooling) below. |
| `preventTmAutoCreate` | `true` | Refuse to send the build if `projectName` would cause BrowserStack to auto-provision a new TM project. Set `false` to opt out. See [TM auto-provisioning](#tm-auto-provisioning). |
| `testManagement` | — | TM-specific options (see below) |
| `requestTimeoutMs` | `10000` | HTTP timeout per request |
| `maxRetries` | `3` | Retry budget on 5xx / 429 (exponential backoff) |

### Service options · `testManagement`

```ts
testManagement: { /* options below */ }
```

| option | default | meaning |
| --- | --- | --- |
| `projectId` | — (**required**) | Test Management project id, format `PR-####`. Find it in the TM project URL. |
| `runName` | `buildName` (or `wdio-${batchId}`) | TM run name |
| `description` | — | Run description body |
| `tags` | — | Tags attached to the TM run |
| `includeAll` | `true` | Run includes every test case in the project (untouched stay `Untested`). Set `false` to only include touched cases. Ignored when `scopeFromSpecs: true`. |
| `scopeFromSpecs` | `false` | Pre-register exactly the `[TC-NNN]` IDs discovered in spec files (cross-checked against the project catalog) at run creation. See [Knowing what didn't execute](#knowing-what-didnt-execute-scopefromspecs). |
| `folderIds` | — | Optional folder IDs to scope the run |
| `preflightCheck` | `true` | Statically discover TC IDs from spec files at start, warn about ones missing from the project catalog. See [Pre-flight check](#pre-flight-check). |
| `preflightTagPattern` | `/\[(TC-\d+)\]/` | Pattern used by pre-flight to extract TC IDs from spec titles. First capture group is the ID. |
| `autoCloseTestRun` | `true` | Close the TM run in `onComplete`. Set `false` to leave it `in_progress` for follow-up jobs. |
| `closeAutoCreatedRuns` | `true` | Sweep BS-auto-created shadow TM runs (named like `<buildName> #N`) at finalize. Strictly prefix-scoped to `buildName` — concurrent CI jobs are never touched. |
| `sweepWaitMs` | `30000` | Total time the inline sweep keeps polling for the shadow before giving up. Loop exits early once it's closed at least one run and a follow-up poll is empty. |
| `sweepIntervalMs` | `5000` | Time between sweep polls. |

### Reporter options

```ts
reporters: [['bstack', { /* options below */ }]];
```

| option | default | meaning |
| --- | --- | --- |
| `tagPattern` | — | Regex to extract a stable test ID from the test title. First capture group becomes the BrowserStack identifier; **all** matches in the title land in `tags`. See [Test identification](#test-identification). |
| `getTestIdentifier` | — | `(test, ctx) => string \| undefined` — custom per-test identifier resolver. Falls through to `tagPattern` and then the default. |
| `flushIntervalMs` | `2000` | Background flush cadence (ms) |
| `flushBatchSize` | `1000` | Force-flush threshold (events per request) |
| `failedAfterHook` | `true` | When `afterEach`/`afterAll` fails for an otherwise-passing test, downgrade it to `Failed` (in both Observability and TM). Set `false` to keep `Passed` and only annotate. |
| `failOnSetupHook` | `false` | When a setup hook (`before all`/`before each`) fails, statically parse the spec file and synthesize `Failed` events for every test in the affected suite that WDIO never reported. See [Hook-failure handling](#hook-failure-handling). |
| `debug` | `false` | Verbose console logging from the reporter |

### Environment variables

| name | direction | meaning |
| --- | --- | --- |
| `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` | in | Auth (used for both Observability and TM) |
| `BSTACK_BATCH_ID` | in | Override / share batch ID across multiple `wdio` invocations |
| `BSTACK_REPORTER_BUILD_ID` | out | Set by service in onPrepare; read by workers |
| `BSTACK_REPORTER_JWT` | out | Collector JWT for the build |
| `BSTACK_REPORTER_API_MODE` | out | `'collector'` or `'rest'` |
| `BSTACK_REPORTER_ALLOW_SCREENSHOTS` | out | `'true'`/`'false'` from createBuild |
| `BSTACK_REPORTER_DASHBOARD_URL` | out | Convenience pointer for shell scripts |
| `BSTACK_REPORTER_TM_PROJECT_ID` | out | TM project id (set when TM is enabled) |
| `BSTACK_REPORTER_TM_RUN_ID` | out | TM run id |
| `BSTACK_REPORTER_TM_DASHBOARD_URL` | out | TM run URL |
| `BSTACK_REPORTER_SPOOL_DIR` | out | Where to spool failed batches (mirrors `spoolDir` option) |

---

## BrowserStack TM API quirks

These behaviors are **server-side** and we work around them where possible.
Documenting so you don't have to rediscover them.

### Pagination uses `p=N`, **not** `page=N`

`GET /test-cases?p=2&per_page=200` works. `?page=2` is silently ignored — you
always get page 1. `per_page` is capped server-side at ~30; drive pagination
off `info.next` rather than response size.

### Comment field is `description`, not `comment`

When posting results, the free-text annotation field is named **`description`**
(the API silently drops `comment` if you send it). Already handled in the
client — your `failure[0].reason` lands in the `description` column on the
dashboard.

### Unknown TC IDs are silently dropped

`POST /test-runs/{id}/results` returns `200 success: true` even when the
`test_case_id` you sent doesn't exist in the project. The result simply isn't
applied. There's **no client-side signal** that data was rejected.

Auto-creation **sometimes** works (you'll see new cases appear with
auto-incremented numeric identifiers), but the rules are inconsistent —
empirical probes show it accepts a few values per request and silently drops
the rest. Don't rely on it.

**Mitigation**: this reporter's `preflightCheck` (on by default) loads the
project's existing case identifiers at run start and warns about every TC ID
your suite would dispatch that isn't in the catalog. Pre-create those cases in
the TM dashboard or via CSV import before the run.

### TM auto-provisioning

The Observability collector auto-creates a Test Management project the first
time a build streams test events with a `project_name` that doesn't match any
existing TM project name in your account. Once it's auto-provisioned, follow-up
runs reuse it.

Empirically:
- `POST /api/v1/builds` alone (just the createBuild call) does **not** trigger it.
- `POST /api/v1/builds` + `POST /api/v1/batch` (with test events) **does**.
- The new TM project's `name` is exactly the `project_name` field on the
  Observability build (= our `projectName` service option).

This means typos and per-environment `projectName` values pollute your TM
workspace with sandbox projects. To prevent this, set:

```ts
services: [[BstackService, {
  projectName: 'Demo Project',     // matches an existing TM project
  // preventTmAutoCreate is on by default — set false to opt out.
  // ...
}]],
```

The guard runs in `onPrepare` by default: it lists every TM project (one
extra `GET /api/v2/projects`, ~50ms) and **throws** before sending the
build if any of these conditions hold:

1. `projectName` doesn't match any existing TM project — the build would
   auto-create a new TM project (the original guard).
2. `testManagement.projectId` is set but no project with that identifier
   exists in your account.
3. `testManagement.projectId` and `projectName` point at different TM
   projects (mismatched config — Observability would group the build under
   one project while results post to another).

Throwing — not `return`ing — means WDIO halts the run; no specs execute and
no data leaks to BS. The same `GET /api/v2/projects` call powers all three
checks, so this is one round-trip total.

`testManagement.projectId` is also validated even when `preventTmAutoCreate:
false` (the cross-check is independent of the auto-provisioning concern). The console error tells you the
existing names so you can pre-create or fix the typo:

```
[wdio-bstack-reporter] preventTmAutoCreate: projectName "sandbox-123" does not match any existing Test Management project.
[wdio-bstack-reporter] Sending this build would cause BrowserStack to auto-provision a new TM project.
[wdio-bstack-reporter] Existing TM project names: "Demo Project", "Mobile QA"
[wdio-bstack-reporter] Pre-create one with that name (TM dashboard) or change projectName to match.
```

There is no documented account-level toggle to disable auto-provisioning on the
BrowserStack side — this guard is the cleanest way to keep your TM workspace
tidy.

### BS auto-creates a "shadow" TM run per Observability build (and never closes it)

In addition to the explicit TM run our reporter creates, BS provisions a **second
TM run** server-side, named after `buildName` with a `#N` suffix
(e.g. `local-2026-05-02T05-23-00-692Z #5`). It's left in `done/active` state and
BS never closes it.

The reporter sweeps these at `onComplete` (option `closeAutoCreatedRuns: true`,
default). The inline sweep uses a poll-and-close loop with a default 30s budget
(configurable via `sweepWaitMs` / `sweepIntervalMs`) and exits early once it
closes at least one run and a follow-up poll comes back empty — so fast cases
finish in seconds, slow cases hit the cap. **BS's creation is asynchronous and
non-deterministic** — sometimes within a few seconds (always caught by the
inline sweep), sometimes minutes after WDIO finishes (caught by the inline
sweep if `sweepWaitMs` is generous enough; otherwise needs the standalone CLI).

The sweep is **strictly prefix-scoped** to the current `buildName`, so
concurrent CI jobs running against the same TM project are never affected.

**Stats divergence** (known limitation): the shadow's per-test stats
won't always match the explicit run's because:

1. BS populates the shadow with **its own auto-generated test case IDs**
   (e.g. `TC-318`, `TC-319`, …) in a parallel namespace from your real
   catalog IDs (`TC-1`..`TC-96`).
2. The shadow's classification is BS's mechanical view of raw events —
   `before all` hook failures show as `Skipped` rather than `Failed`,
   and `afterEach` hook failures may not flip a `Passed` test to `Failed`.

We previously tried to "mirror" our authoritative results onto the shadow
(translating real → shadow IDs by parsing `[TC-N]` from each shadow case
name) so the counts would match. It works mechanically — but BS then
labels the shadow with a **"Manually Overridden"** badge in the UI, which
is more confusing for QA leads than the stat mismatch. So the reporter
*does not* mirror by default.

Empirically:

```
Explicit TR-224:  60 cases, IDs TC-1..TC-96   → 55 Passed,  5 Failed
Shadow   TR-225:  60 cases, IDs TC-318..TC-347 → 55 Passed, 4 Failed, 1 Skipped
                                                                         ^ BS's view of failOnSetupHook
```

**Trust the explicit run** (`wdio-…`) as the source of truth for catalog
status. The shadow is BS's parallel rollup; treat it as informational
only. Until BS exposes a way to suppress shadow creation (see
`docs/email-to-bs-support.md`), there's no way to make both views agree
without the override badge.

For deterministic cleanup, use the bundled CLI:

```bash
# Single pass (catches whatever is currently active):
npx wdio-bstack-reporter sweep --project PR-1

# RECOMMENDED: poll-and-close for up to 5 min, exit early when done.
# Right after WDIO finishes, the shadow may take seconds to minutes to appear —
# this keeps polling every 10s until it's caught and the next poll is empty.
npx wdio-bstack-reporter sweep --project PR-1 \
  --build-name "$BUILD_NAME" \
  --wait 5m --interval 10s

# Daily cron-style (only close runs older than 1h):
npx wdio-bstack-reporter sweep --project PR-1 --max-age 1h

# Preview without closing:
npx wdio-bstack-reporter sweep --project PR-1 --dry-run
```

Auth: same `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` env vars as the reporter.

GitHub Actions example:
```yaml
- name: Run tests
  run: npm test

- name: Sweep BS auto-shadow runs (poll until found)
  if: always()        # run even when tests fail
  run: |
    npx wdio-bstack-reporter sweep \
      --project ${{ env.BSTACK_TM_PROJECT_ID }} \
      --build-name "$BUILD_NAME" \
      --wait 5m --interval 10s
```

The `--wait` loop exits early once it has closed at least one run AND the next
poll comes back empty — so on a fast-provisioning run it's seconds, on a
slow-provisioning run it uses up to the budget.

### `preflight` CLI — check spec IDs against the catalog standalone

The same TC-id-vs-catalog check the launcher service runs in `onPrepare` is
also available as a standalone command. Useful in pre-commit hooks or as a PR
gate without spinning up a full WDIO run.

```bash
# Human-readable report
npx wdio-bstack-reporter preflight \
  --project PR-1 \
  --specs "tests/specs/**/*.spec.ts"

# Custom regex (first capture group is the ID)
npx wdio-bstack-reporter preflight \
  --project PR-1 \
  --specs "tests/specs/**/*.spec.ts" \
  --pattern "@(TC-\\d+)"

# CI gate: exit 1 if any spec ID is missing from the project catalog
npx wdio-bstack-reporter preflight \
  --project PR-1 \
  --specs "tests/specs/**/*.spec.ts" \
  --strict

# Machine-readable
npx wdio-bstack-reporter preflight -p PR-1 -s "..." --json
```

Sample output:

```
Project PR-1 (pattern: \[(TC-\d+)\])

  Total in specs       : 69
  Available on BS      : 60
  Missing on BS        : 9
  Catalog size (project): 187

✗ 9 of 69 ID(s) missing from project PR-1:
  TC-101, TC-102, TC-103, TC-104, TC-105, TC-201, TC-202, TC-203, TC-204

  Results posted for these will be silently dropped by the TM API.
  Pre-create them via the dashboard or CSV import before the next run.
```

Exit codes: `0` ok (or warnings without `--strict`), `1` missing IDs found
under `--strict`, `2` bad args / missing env / fatal.

### CLI auto-loads `.env`

Both the `sweep` and `preflight` commands look for a `.env` file in the
current working directory at startup and load it into `process.env` if found.
A line like:

```
[wdio-bstack-reporter] loaded .env from cwd
```

is printed when this happens. Existing shell variables are **never**
overwritten — your shell wins, so CI overrides keep working. If no `.env`
file exists, the CLI runs against whatever's in your shell environment as
usual.

Recognised `.env` syntax: `KEY=value`, quoted values (single or double),
`export KEY=value`, `# comments`, and inline `# trailing comments` on
unquoted values.

### Closed runs reject all subsequent POSTs with 404

`POST /test-runs/{id}/results` against a closed run returns `404 Test Run ID
is invalid`. If you want to keep adding results in a downstream job, set
`autoCloseTestRun: false`.

### Auto-created cases get internal numeric IDs

When BrowserStack does auto-create a case from a `POST results`, it assigns a
fresh numeric identifier (e.g. `4`, `6`, `7`) — not the `TC-XXX` value you
sent. The result row's `test_case_id` reflects the auto-assigned numeric ID;
the case's *name* preserves your test title (which contains `[TC-XXX]`).

### Observability builds can't be programmatically "closed"

After `PUT /api/v1/builds/{id}/stop` with `{ stop_time }`, the build reaches
**`completed`** state on the dashboard with the correct `Passed`/`Failed`
result. There's a separate `closed` state — reachable via the dashboard's
"Close build" button — that this reporter (and the official
`@wdio/browserstack-service`) **cannot reach programmatically.** Why:

- The "Close" button calls `POST https://api-observability.browserstack.com/api/v1/builds/{uuid}/close`
- That endpoint **only accepts dashboard session cookies** (`bs_token` JWT +
  `_session` Rails cookie). Probed every alternative auth scheme:
  - `Basic <username>:<access_key>` → 401
  - `Bearer <build-jwt>` → 401
  - `x-api-key`, `Token`, raw access_key, browserstack-username/key headers → all 401
- There's no documented public endpoint for closing builds (verified against
  the BS Test Reporting reference docs and the official service's bundled
  source — neither calls `/close` either).

So `completed` is the terminal state reachable from CI; `closed` is a
**dashboard-only manual archival action**. This matches how the official
`@wdio/browserstack-service` behaves — its builds also stay in
`completed` until manually closed.

If/when BS exposes public-auth on `/close`, we'll add a `closeBuildAfterStop`
option. Until then, the result on the dashboard (`Failed`/`Passed`) is the
meaningful signal; "closed" is cosmetic metadata.

---

## Recipe: post-run notifications (Google Chat / Slack / anywhere)

This package deliberately does **not** ship its own chat/Slack/Teams
integration — that's scope creep for a BrowserStack reporter, and the
ecosystem of webhooks is large enough that one hardcoded integration
won't fit everyone. Instead, the service exposes the run's dashboard URLs
as **stable env vars** that any user-defined service can read in its own
`onComplete` hook. That's all you need.

**Stable env vars** (treat as part of the public API):

| Env var | Set when | Contents |
| --- | --- | --- |
| `BSTACK_REPORTER_DASHBOARD_URL` | Observability is enabled | `https://observability.browserstack.com/builds/<id>` |
| `BSTACK_REPORTER_TM_DASHBOARD_URL` | TM is configured | `https://test-management.browserstack.com/projects/<PR>/test-runs/<TR>` |

Both stay populated through the user's `onComplete`, so a downstream
service can read them after `BstackService` finishes its work.

### Example: post a run summary to Google Chat

In your Chat space, create an **Incoming Webhook** (Apps & integrations
→ Manage webhooks → Add webhook), copy the URL, then:

```ts
// wdio.conf.ts
import 'dotenv/config';
import { BstackService } from 'wdio-bstack-reporter';

class GoogleChatNotifier {
  async onComplete(
    exitCode: number,
    _config: unknown,
    _capabilities: unknown,
    results: { finished?: number; passed?: number; failed?: number; retries?: number },
  ): Promise<void> {
    const webhook = process.env.GCHAT_WEBHOOK_URL;
    if (!webhook) return;

    const total = results?.finished ?? 0;
    const passed = results?.passed ?? 0;
    const failed = results?.failed ?? 0;
    const status = exitCode === 0 ? '✅ Passed' : '❌ Failed';
    const tmUrl = process.env.BSTACK_REPORTER_TM_DASHBOARD_URL;
    const obsUrl = process.env.BSTACK_REPORTER_DASHBOARD_URL;

    const lines = [
      `${status} — ${passed}/${total} passed, ${failed} failed`,
      tmUrl ? `Test Management: ${tmUrl}` : null,
      obsUrl ? `Observability: ${obsUrl}` : null,
    ].filter(Boolean);

    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: lines.join('\n') }),
      });
    } catch (err) {
      // Never crash the run on a chat failure.
      console.warn('[notify] Google Chat post failed:', (err as Error).message);
    }
  }
}

export const config: WebdriverIO.Config = {
  services: [
    // Order matters slightly: register the notifier BEFORE BstackService so
    // its onComplete reads the env vars while they're still set, regardless
    // of clearance ordering. (BstackService keeps the URL env vars set
    // either way, but putting the notifier first is defensive.)
    [GoogleChatNotifier],
    [BstackService, { /* your options */ }],
  ],
  // ...
};
```

If you'd rather pretty-render with a Cards V2 message, swap the `text`
body for the JSON shape from the [Google Chat REST docs](https://developers.google.com/workspace/chat/api/reference/rest/v1/cards-v2). The same pattern works for Slack (use Slack's [incoming webhook
URL](https://api.slack.com/messaging/webhooks) and `{ text }` payload),
Microsoft Teams, Discord, or your own status server.

### Why this isn't a built-in feature

- Webhook payloads differ by platform; each one would be its own integration.
- Teams have varied requirements (templates, threading, mention rules, throttling).
- A 30-line user-owned class is more flexible than 200 lines of optional config.
- Keeps the package focused on what its name promises: BrowserStack reporting.

---

## Offline spooling

When the HTTP layer exhausts its retry budget (default: 3 attempts on 5xx/429
with exponential backoff), the failed batch would normally be dropped. Set
`spoolDir` to keep it on disk instead:

```ts
services: [[BstackService, {
  spoolDir: './.wdio-bstack-spool',
  // ...
}]];
```

What happens:

- Each undelivered batch becomes one JSONL line in
  `<spoolDir>/<timestamp>-<kind>.jsonl` (kind = `events` or `tm-results`).
- The path propagates to workers via `BSTACK_REPORTER_SPOOL_DIR`, so all
  workers spool to the same dir.
- Files are append-only; subsequent runs add new files without touching
  earlier ones.

Replay is **manual** — there's no built-in command. The intended use is one
of: (a) ship the directory to ops as a forensic artifact when something
breaks, (b) `cat` the files and POST them yourself with `curl` once the
network is back, or (c) write a tiny script that calls the same `Client`
interface (`src/client/types.ts`) the reporter uses. We don't auto-replay
because the JWT may have expired or the build may have been closed by the
time the network recovers.

If you don't set `spoolDir`, undelivered batches are simply dropped after
retries — same behavior as not setting it on `@wdio/browserstack-service`.

---

## Failure modes

| Failure | Behavior |
| --- | --- |
| **Bad credentials** | Service logs an error in `onPrepare` and skips build creation. Reporter no-ops. WDIO run continues. |
| **Network blip** | HTTP layer retries 5xx/429 with exponential backoff (3 attempts default). |
| **JWT expired mid-run** (long suites > 1h) | Collector client drops the JWT on 401 and retries once with HTTP Basic. |
| **Ctrl-C / SIGTERM** | Service catches the signal, finalizes the build with `result: 'failed'` and `meta.aborted: true`, then re-raises the signal. No orphaned "running" builds. |
| **Test retries** (`onTestRetry`) | Synth `TestRunFinished(failed)` for the prior attempt; the next attempt's `TestRunStarted` carries `retries: N`. |
| **Total network outage** | Set `spoolDir` to write undelivered batches as JSONL for offline replay. |
| **`apiMode: 'rest'`** | Same dashboard view, just chattier traffic; screenshots are skipped (no public endpoint). |
| **Worker killed** | `onComplete` still runs in the launcher; events that made it before the crash are visible. In-flight tests will be missing their finish events. |
| **`beforeEach` fails** | Reporter synthesizes a finish event for the orphaned test → Observability gets `skipped`, TM gets `Blocked` (or `Failed` with `failOnSetupHook: true`). |
| **`beforeAll` fails** | Mocha never reports the suite's tests. Without `failOnSetupHook: true` they vanish from TM (mitigation: `includeAll: true` keeps them `Untested`). With `failOnSetupHook: true` the spec is statically parsed and each affected TC is reported `Failed`. |
| **`afterEach` / `afterAll` fails** | Test status flips to `Failed` (default). Hook reason in `description` (TM) and `failure[]` (Observability). Set `failedAfterHook: false` to preserve `Passed`. |

---

## What's NOT included

**No BrowserStack session linking.** This package is for teams running tests on
their own infrastructure (local Selenium grid, SauceLabs, etc.) and reporting
to BrowserStack Test Observability separately. There is no `session_id` to link
to a video replay because the test isn't running on `hub.browserstack.com`.

If you do run on BrowserStack, use [`@wdio/browserstack-service`](https://webdriver.io/docs/wdio-browserstack-service)
with `testObservability: true` instead — that integration plumbs session IDs
through automatically.

---

## Development

```sh
npm install
npm run typecheck
npm test          # vitest, ~160 tests
npm run build     # tsup → dist/ (ESM + CJS + d.ts)
```

The `sample/` directory next door is a working WDIO project that exercises
every feature against a live BrowserStack project. See `sample/README.md`.

---

## Publishing

Releases are published to npm via the **`Publish` GitHub Actions workflow**,
which is **manually triggered only**. There is no auto-publish on push.

1. Bump the version in `package.json` and add an entry to `CHANGELOG.md` on
   `main`.
2. Push the commit.
3. Go to **Actions → Publish → Run workflow** in GitHub.
   - Leave `dry_run` unchecked to publish for real.
   - Tick `dry_run` to do a publish-rehearsal that runs every step except
     the npm upload (useful when validating workflow changes).
4. The workflow:
   - Verifies the version isn't already on npm (fails fast if it is).
   - Runs `typecheck`, `test`, and `build`.
   - Publishes with [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
     attestation.
   - Creates a git tag `v<version>` and a GitHub release.

**Authentication: Trusted Publishing (OIDC)**, not a long-lived token. The
workflow declares `id-token: write` and the npm CLI exchanges a short-lived
GitHub Actions OIDC token for publish authorization at run time. Configure
the trusted publisher once on npmjs.com → Packages → Trusted Publishers:

- Publisher type: **GitHub Actions**
- Organization or user: `jemishgopani`
- Repository: `wdio-bstack-reporter`
- Workflow filename: `publish.yml`

No secrets to rotate, no 2FA-bypass tokens to leak, no `NPM_TOKEN` repo
secret needed. The provenance signature is also part of the same OIDC
flow, so npmjs.com shows a verified GitHub Actions provenance badge on
the package page.

---

## License

MIT
