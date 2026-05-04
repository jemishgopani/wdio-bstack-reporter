import { BstackService } from 'wdio-bstack-reporter';

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./test/specs/**/*.ts'],
  maxInstances: 3,

  capabilities: [
    {
      browserName: 'chrome',
      'bstack:options': {
        os: 'OS X',
        osVersion: 'Sonoma',
        projectName: 'my-app',
        buildName: process.env.GITHUB_RUN_ID ?? 'local',
      },
    },
  ],

  hostname: 'hub.browserstack.com',

  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 60_000 },

  // The launcher service creates the BrowserStack Test Observability build in
  // onPrepare and finalizes it in onComplete. It runs once in the main process.
  services: [
    [
      BstackService,
      {
        projectName: 'my-app',
        buildName: process.env.GITHUB_RUN_ID
          ? `gh-${process.env.GITHUB_RUN_ID}`
          : `local-${new Date().toISOString()}`,
        apiMode: 'collector', // 'collector' (default, live) | 'rest'
        // batchId is auto-detected from CI env vars; override if needed:
        // batchId: process.env.MY_BATCH_ID,
        tags: ['regression'],
        captureLogs: true,                  // browser console → LogCreated events
        captureScreenshotsOnFailure: true,  // screenshot in afterTest on failure
        spoolDir: './.wdio-bstack-spool',   // JSONL fallback for offline mode
      },
    ],
  ],

  // The reporter runs in each worker and streams live test events. The 'bstack'
  // short name is resolved by WDIO to the package name 'wdio-bstack-reporter'.
  reporters: [
    'spec',
    [
      'bstack',
      {
        // Defaults are fine; tweak if your suite is large.
        // flushIntervalMs: 2000,
        // flushBatchSize: 1000,
      },
    ],
  ],
};
