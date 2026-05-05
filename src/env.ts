export const ENV = {
  BUILD_ID: 'BSTACK_REPORTER_BUILD_ID',
  JWT: 'BSTACK_REPORTER_JWT',
  API_MODE: 'BSTACK_REPORTER_API_MODE',
  BATCH_ID: 'BSTACK_BATCH_ID',
  USERNAME: 'BROWSERSTACK_USERNAME',
  ACCESS_KEY: 'BROWSERSTACK_ACCESS_KEY',
  ALLOW_SCREENSHOTS: 'BSTACK_REPORTER_ALLOW_SCREENSHOTS',
  DASHBOARD_URL: 'BSTACK_REPORTER_DASHBOARD_URL',
  SPOOL_DIR: 'BSTACK_REPORTER_SPOOL_DIR',
  TM_PROJECT_ID: 'BSTACK_REPORTER_TM_PROJECT_ID',
  TM_RUN_ID: 'BSTACK_REPORTER_TM_RUN_ID',
  TM_DASHBOARD_URL: 'BSTACK_REPORTER_TM_DASHBOARD_URL',
  /**
   * Comma-separated TC IDs the launcher's preflight resolved as "missing
   * from the project catalog". When the user opts into `enforceTcCatalog`,
   * the reporter reads this set and drops every Observability event for
   * tests whose extracted TC ID is in it — keeping the BS shadow run
   * scope-consistent with our explicit TM run.
   */
  DROPPED_TC_IDS: 'BSTACK_REPORTER_DROPPED_TC_IDS',
} as const;

export interface BuildContext {
  buildId: string | undefined;
  jwt: string | undefined;
  apiMode: 'collector' | 'rest' | undefined;
  allowScreenshots: boolean;
}

export function readBuildContext(): BuildContext {
  const apiMode = process.env[ENV.API_MODE];
  return {
    buildId: process.env[ENV.BUILD_ID],
    jwt: process.env[ENV.JWT],
    apiMode: apiMode === 'collector' || apiMode === 'rest' ? apiMode : undefined,
    allowScreenshots: process.env[ENV.ALLOW_SCREENSHOTS] === 'true',
  };
}

export function writeBuildContext(ctx: {
  buildId: string;
  jwt?: string;
  apiMode: 'collector' | 'rest';
  allowScreenshots: boolean;
  dashboardUrl: string;
}): void {
  process.env[ENV.BUILD_ID] = ctx.buildId;
  if (ctx.jwt) process.env[ENV.JWT] = ctx.jwt;
  process.env[ENV.API_MODE] = ctx.apiMode;
  process.env[ENV.ALLOW_SCREENSHOTS] = String(ctx.allowScreenshots);
  process.env[ENV.DASHBOARD_URL] = ctx.dashboardUrl;
}

export function clearBuildContext(): void {
  delete process.env[ENV.BUILD_ID];
  delete process.env[ENV.JWT];
  delete process.env[ENV.API_MODE];
  delete process.env[ENV.ALLOW_SCREENSHOTS];
  // DASHBOARD_URL is intentionally left set: it's a non-sensitive, stable
  // public surface that user-defined services in wdio.conf.ts can read in
  // their own onComplete hook (e.g. to post a chat notification with the
  // run link). The process exits shortly after onComplete anyway, so there
  // is no leak risk.
}
