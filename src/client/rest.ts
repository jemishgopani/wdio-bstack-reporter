import { basicAuth, httpRequest } from './http.js';
import type {
  BuildCreateInput,
  BuildCreateResult,
  BuildStopInput,
  Client,
  Event,
} from './types.js';

const BASE = 'https://api-observability.browserstack.com';

interface RestOpts {
  username: string;
  accessKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface CreateBuildResponse {
  build_hashed_id: string;
  build_id?: string;
  allow_screenshots?: boolean;
}

export class RestClient implements Client {
  readonly mode = 'rest' as const;
  private _buildId: string | undefined;

  constructor(private readonly opts: RestOpts) {}

  get buildId(): string | undefined {
    return this._buildId;
  }

  attachBuild(args: { buildId: string }): void {
    this._buildId = args.buildId;
  }

  async createBuild(input: BuildCreateInput): Promise<BuildCreateResult> {
    const res = await httpRequest<CreateBuildResponse>({
      method: 'POST',
      url: `${BASE}/start-build`,
      headers: { authorization: basicAuth(this.opts.username, this.opts.accessKey) },
      body: input,
      ...this.requestOverrides(),
    });
    const buildId = res.build_hashed_id ?? res.build_id;
    if (!buildId) throw new Error('RestClient.createBuild: server did not return a build id');
    this._buildId = buildId;
    return {
      buildId,
      allowScreenshots: res.allow_screenshots ?? false,
      dashboardUrl: `https://observability.browserstack.com/builds/${buildId}`,
    };
  }

  async sendEvents(events: Event[]): Promise<void> {
    if (events.length === 0) return;
    if (!this._buildId) throw new Error('RestClient.sendEvents: no build attached');
    // Public REST API doesn't support a batch endpoint — fan out per-event in parallel.
    await Promise.all(events.map((e) => this.sendOne(e)));
  }

  async stopBuild(input: BuildStopInput): Promise<void> {
    if (!this._buildId) throw new Error('RestClient.stopBuild: no build attached');
    await httpRequest({
      method: 'POST',
      url: `${BASE}/finish-build`,
      headers: { authorization: basicAuth(this.opts.username, this.opts.accessKey) },
      body: { build_hashed_id: this._buildId, ...input },
      ...this.requestOverrides(),
    });
  }

  private async sendOne(event: Event): Promise<void> {
    const url = this.urlFor(event);
    if (!url) return;
    await httpRequest({
      method: 'POST',
      url,
      headers: { authorization: basicAuth(this.opts.username, this.opts.accessKey) },
      body: { build_hashed_id: this._buildId, ...this.bodyFor(event) },
      ...this.requestOverrides(),
    });
  }

  private urlFor(event: Event): string | undefined {
    switch (event.event_type) {
      case 'TestRunStarted':
        return `${BASE}/start-test-run`;
      case 'TestRunFinished':
        return `${BASE}/finish-test-run`;
      case 'HookRunStarted':
        return `${BASE}/start-hook-run`;
      case 'HookRunFinished':
        return `${BASE}/finish-hook-run`;
      case 'LogCreated':
        return undefined; // public REST has no per-event log endpoint
    }
  }

  private bodyFor(event: Event): Record<string, unknown> {
    switch (event.event_type) {
      case 'TestRunStarted':
      case 'TestRunFinished':
        return event.test_run as unknown as Record<string, unknown>;
      case 'HookRunStarted':
      case 'HookRunFinished':
        return event.hook_run as unknown as Record<string, unknown>;
      case 'LogCreated':
        return { logs: event.logs };
    }
  }

  private requestOverrides(): { timeoutMs?: number; maxRetries?: number } {
    const out: { timeoutMs?: number; maxRetries?: number } = {};
    if (this.opts.timeoutMs !== undefined) out.timeoutMs = this.opts.timeoutMs;
    if (this.opts.maxRetries !== undefined) out.maxRetries = this.opts.maxRetries;
    return out;
  }
}
