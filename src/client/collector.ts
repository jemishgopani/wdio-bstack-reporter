import { basicAuth, httpRequest, HttpError } from './http.js';
import type {
  BuildCreateInput,
  BuildCreateResult,
  BuildStopInput,
  Client,
  Event,
} from './types.js';

const BASE = 'https://collector-observability.browserstack.com';

interface CollectorOpts {
  username: string;
  accessKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface CreateBuildResponse {
  jwt?: string;
  build_hashed_id: string;
  allow_screenshots?: boolean;
}

export class CollectorClient implements Client {
  readonly mode = 'collector' as const;
  private _buildId: string | undefined;
  private jwt: string | undefined;

  constructor(private readonly opts: CollectorOpts) {}

  get buildId(): string | undefined {
    return this._buildId;
  }

  attachBuild(args: { buildId: string; jwt?: string }): void {
    this._buildId = args.buildId;
    this.jwt = args.jwt;
  }

  async createBuild(input: BuildCreateInput): Promise<BuildCreateResult> {
    const res = await httpRequest<CreateBuildResponse>({
      method: 'POST',
      url: `${BASE}/api/v1/builds`,
      headers: { authorization: basicAuth(this.opts.username, this.opts.accessKey) },
      body: input,
      ...this.requestOverrides(),
    });
    this._buildId = res.build_hashed_id;
    if (res.jwt) this.jwt = res.jwt;
    const result: BuildCreateResult = {
      buildId: res.build_hashed_id,
      allowScreenshots: res.allow_screenshots ?? false,
      dashboardUrl: `https://observability.browserstack.com/builds/${res.build_hashed_id}`,
    };
    if (res.jwt) result.jwt = res.jwt;
    return result;
  }

  async sendEvents(events: Event[]): Promise<void> {
    if (events.length === 0) return;
    await this.withAuthRetry(() =>
      httpRequest({
        method: 'POST',
        url: `${BASE}/api/v1/batch`,
        headers: { authorization: this.authHeader() },
        body: events,
        ...this.requestOverrides(),
      }),
    );
  }

  async sendScreenshot(input: { testTitle: string; dataUrl: string }): Promise<void> {
    if (!this._buildId) return;
    await this.withAuthRetry(() =>
      httpRequest({
        method: 'POST',
        url: `${BASE}/api/v1/screenshots`,
        headers: { authorization: this.authHeader() },
        body: {
          build_hashed_id: this._buildId,
          test_title: input.testTitle,
          image: input.dataUrl,
        },
        ...this.requestOverrides(),
      }),
    );
  }

  async stopBuild(input: BuildStopInput): Promise<void> {
    if (!this._buildId) throw new Error('CollectorClient.stopBuild: no build attached');
    await this.withAuthRetry(() =>
      httpRequest({
        method: 'PUT',
        url: `${BASE}/api/v1/builds/${this._buildId}/stop`,
        headers: { authorization: this.authHeader() },
        body: {
          stop_time: input.stop_time,
          ...(input.result ? { result: input.result } : {}),
          ...(input.meta ? { meta: input.meta } : {}),
        },
        ...this.requestOverrides(),
      }),
    );
  }

  /**
   * Run an HTTP call. If it fails with 401 (JWT expired), drop the JWT, fall
   * back to Basic auth and try once more.
   */
  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError && err.status === 401 && this.jwt) {
        this.jwt = undefined;
        return await fn();
      }
      throw err;
    }
  }

  private authHeader(): string {
    return this.jwt
      ? `Bearer ${this.jwt}`
      : basicAuth(this.opts.username, this.opts.accessKey);
  }

  private requestOverrides(): { timeoutMs?: number; maxRetries?: number } {
    const out: { timeoutMs?: number; maxRetries?: number } = {};
    if (this.opts.timeoutMs !== undefined) out.timeoutMs = this.opts.timeoutMs;
    if (this.opts.maxRetries !== undefined) out.maxRetries = this.opts.maxRetries;
    return out;
  }
}
