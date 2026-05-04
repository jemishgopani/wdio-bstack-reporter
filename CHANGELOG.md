# Changelog

All notable changes to `wdio-bstack-reporter` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-05-04

Initial public release.

### Added

- WebdriverIO reporter + launcher service that streams test events live to
  BrowserStack Test Observability (`collector` and `rest` API modes).
- Independent BrowserStack Test Management integration: create a TM run in
  `onPrepare`, post per-test results in batches of 300, close in
  `onComplete`. Toggle Observability and TM independently via
  `observability: { enabled: false }` and `testManagement.projectId`.
- Spec-level static parser for `[TC-NNN]`-tagged test discovery
  (`scopeFromSpecs`, `failOnSetupHook`, `enforceTcCatalog`).
- Pre-flight catalog check that reports TC IDs missing from the TM project
  before workers spawn (drops auto-applied via `BSTACK_REPORTER_DROPPED_TC_IDS`
  for `enforceTcCatalog`).
- Hook-failure handling: setup-hook failures synthesize `Failed` events for
  hook-blocked tests in both Observability and TM dashboards (symmetric);
  teardown-hook failures flip `Passed` to `Failed` (`failedAfterHook`).
- Inline shadow-run sweep on `onComplete` and standalone `wdio-bstack-reporter
  sweep` CLI for the slow-provisioning case.
- `wdio-bstack-reporter preflight` CLI for catalog checks outside a WDIO run,
  with human-readable table, `--json`, and `--strict` exit-code modes.
- Auto-loads `.env` from cwd in CLI commands (shell vars take precedence).
- Spool-to-disk for undelivered batches (`spoolDir`) for forensic replay.
- Optional `captureLogs` (browser console → LogCreated events) and
  `captureScreenshotsOnFailure` (afterTest hook → `/api/v1/screenshots`).
- Cross-validation: `preventTmAutoCreate` halts the run if `projectName` would
  cause BrowserStack to auto-provision a new TM project, and `projectId`/
  `projectName` are checked to point at the same project.

[0.1.0]: https://github.com/jemishgopani/wdio-bstack-reporter/releases/tag/v0.1.0
