import type { ServiceOptions as _ServiceOptions } from './config.js';

export { default } from './reporter.js';
export { default as BstackReporter } from './reporter.js';
export { default as BstackService } from './service.js';

// Augment WDIO's global ServiceOption so our service class is assignable to
// `[ServiceClass, ServiceOption]` in user wdio.conf.ts files, while users
// still get autocomplete on our specific options.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace WebdriverIO {
    interface ServiceOption extends _ServiceOptions {}
  }
}

export type {
  ApiMode,
  ReporterOptions,
  ServiceOptions,
  SharedOptions,
  IdentifiedTest,
  IdentifierContext,
} from './config.js';
export type {
  Client,
  Event,
  EventType,
  TestStatus,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  HookRunStartedEvent,
  HookRunFinishedEvent,
  LogCreatedEvent,
  BuildCreateInput,
  BuildCreateResult,
  BuildStopInput,
} from './client/index.js';
export { TestManagementClient } from './client/test-management.js';
export type {
  TmStatus,
  TmCreateRunInput,
  TmCreateRunResult,
  TmTestResult,
} from './client/test-management.js';
export { ENV } from './env.js';
