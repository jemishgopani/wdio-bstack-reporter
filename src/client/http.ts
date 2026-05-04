export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  /** Override sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public override readonly message: string,
    public readonly body?: string,
  ) {
    super(`HTTP ${status} ${message} for ${url}`);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  const jitter = Math.random() * 250;
  return base + jitter;
}

export async function httpRequest<T = unknown>(opts: HttpRequestOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: opts.method,
        headers,
        signal: ctrl.signal,
      };
      if (body !== undefined) init.body = body;
      const res = await fetch(opts.url, init);
      clearTimeout(timer);

      if (res.ok) {
        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }

      const text = await res.text().catch(() => '');
      if (shouldRetry(res.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new HttpError(res.status, opts.url, res.statusText, text);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err instanceof HttpError) throw err;
      // Network/abort error — retry
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('httpRequest: exhausted retries');
}

export function basicAuth(username: string, accessKey: string): string {
  return 'Basic ' + Buffer.from(`${username}:${accessKey}`).toString('base64');
}
