import { CollectorClient } from './collector.js';
import { RestClient } from './rest.js';
import type { Client } from './types.js';
import type { ApiMode } from '../config.js';

export interface CreateClientArgs {
  apiMode: ApiMode;
  username: string;
  accessKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export function createClient(args: CreateClientArgs): Client {
  const opts = {
    username: args.username,
    accessKey: args.accessKey,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
  };
  if (args.apiMode === 'collector') return new CollectorClient(opts);
  return new RestClient(opts);
}

export { CollectorClient, RestClient };
export type { Client };
export type {
  Event,
  TestRunStartedEvent,
  TestRunFinishedEvent,
  HookRunStartedEvent,
  HookRunFinishedEvent,
  LogCreatedEvent,
  BuildCreateInput,
  BuildCreateResult,
  BuildStopInput,
  TestStatus,
  EventType,
} from './types.js';
