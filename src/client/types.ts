export type TestStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'timeout';

export type EventType =
  | 'TestRunStarted'
  | 'TestRunFinished'
  | 'HookRunStarted'
  | 'HookRunFinished'
  | 'LogCreated';

export interface TestRunStartedEvent {
  event_type: 'TestRunStarted';
  test_run: {
    uuid: string;
    name: string;
    scope: string;
    scopes: string[];
    identifier: string;
    file_name: string;
    location: string;
    started_at: string;
    framework?: string;
    vc_filepath?: string;
    tags?: string[];
    retries?: number;
    meta?: Record<string, unknown>;
  };
}

export interface TestRunFinishedEvent {
  event_type: 'TestRunFinished';
  test_run: {
    uuid: string;
    name: string;
    scope: string;
    scopes: string[];
    identifier: string;
    file_name: string;
    location: string;
    started_at: string;
    finished_at: string;
    duration_in_ms: number;
    result: TestStatus;
    failure?: { backtrace: string[]; reason: string }[] | undefined;
    framework?: string;
    tags?: string[];
    retries?: number;
    meta?: Record<string, unknown>;
  };
}

export interface HookRunStartedEvent {
  event_type: 'HookRunStarted';
  hook_run: {
    uuid: string;
    name: string;
    hook_type: 'BEFORE_ALL' | 'BEFORE_EACH' | 'AFTER_ALL' | 'AFTER_EACH' | 'GLOBAL';
    test_run_uuid?: string;
    started_at: string;
  };
}

export interface HookRunFinishedEvent {
  event_type: 'HookRunFinished';
  hook_run: {
    uuid: string;
    name: string;
    hook_type: 'BEFORE_ALL' | 'BEFORE_EACH' | 'AFTER_ALL' | 'AFTER_EACH' | 'GLOBAL';
    test_run_uuid?: string;
    started_at: string;
    finished_at: string;
    duration_in_ms: number;
    result: TestStatus;
    failure?: { backtrace: string[]; reason: string }[] | undefined;
  };
}

export interface LogCreatedEvent {
  event_type: 'LogCreated';
  logs: Array<{
    test_run_uuid?: string;
    timestamp: string;
    kind: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'HTTP';
    message: string;
  }>;
}

export type Event =
  | TestRunStartedEvent
  | TestRunFinishedEvent
  | HookRunStartedEvent
  | HookRunFinishedEvent
  | LogCreatedEvent;

export interface BuildCreateInput {
  name: string;
  project_name: string;
  build_identifier?: string;
  started_at: string;
  framework: string;
  framework_version?: string;
  sdk_version: string;
  language: 'javascript' | 'typescript';
  language_version?: string;
  ci_info?: {
    name: string;
    build_url?: string;
    branch?: string;
    commit?: string;
  };
  platforms?: Array<{
    browser?: string;
    browser_version?: string;
    platform?: string;
    device?: string;
  }>;
  tags?: string[];
  meta?: Record<string, unknown>;
}

export interface BuildCreateResult {
  buildId: string;
  jwt?: string;
  allowScreenshots: boolean;
  dashboardUrl: string;
  reused?: boolean;
}

export interface BuildStopInput {
  /**
   * BS collector field name is `stop_time` (NOT `finished_at`); the latter
   * is silently ignored and the dashboard never flips the build out of
   * "running". Confirmed against @wdio/browserstack-service v9.27.1
   * stopBuildUpstream (build/index.js ~line 3958).
   */
  stop_time: string;
  /**
   * Aggregate run result. The official service doesn't include this in the
   * stop body — the dashboard derives result from the streamed test events.
   * We keep emitting it because the collector accepts it without error and
   * older API versions documented it.
   */
  result?: 'passed' | 'failed';
  meta?: Record<string, unknown>;
}

export interface Client {
  readonly mode: 'collector' | 'rest';
  /** Build ID the client is currently bound to (set by createBuild or attachBuild). */
  readonly buildId: string | undefined;
  /** Bind this client to a build that already exists (e.g. created by the launcher). */
  attachBuild(args: { buildId: string; jwt?: string }): void;
  createBuild(input: BuildCreateInput): Promise<BuildCreateResult>;
  sendEvents(events: Event[]): Promise<void>;
  stopBuild(input: BuildStopInput): Promise<void>;
}
