import { basicAuth, httpRequest } from './http.js';

const BASE = 'https://test-management.browserstack.com/api/v2';

export type TmStatus = 'Passed' | 'Failed' | 'Blocked' | 'Skipped' | 'Untested';

export interface TmCreateRunInput {
  name: string;
  /** When true, the run includes every test case in the project. */
  include_all?: boolean;
  /** Otherwise, the explicit list of TC IDs the run should include. */
  test_cases?: string[];
  run_state?: 'new_run' | 'in_progress' | 'done' | 'closed';
  description?: string;
  tags?: string[];
  folder_ids?: number[];
  configurations?: Array<{ id: number }>;
  assignee?: string;
  meta?: Record<string, unknown>;
}

export interface TmCreateRunResult {
  /** Identifier form (TR-NNN), used by the API for posting results / closing. */
  runId: string;
  /**
   * Canonical dashboard URL. Sourced from BS's `test_run.urls.self` response
   * field when present (preserves the numeric project id BS uses in its UI),
   * with `/folder` appended to land on the default tab.
   */
  dashboardUrl: string;
}

export interface TmTestResult {
  test_case_id: string;
  test_result: {
    status: TmStatus;
    /**
     * Free-text note attached to the result. Surfaces as the result's
     * description on the TM dashboard. NOTE: the BS TM API field name is
     * `description` (a `comment` field is silently dropped).
     */
    description?: string;
    duration_in_ms?: number;
  };
  step_results?: Array<{ description: string; status: TmStatus }>;
}

interface TmCreateRunResponse {
  test_run?: {
    id?: string | number;
    identifier?: string;
    /**
     * BS embeds the canonical web-dashboard URL here, with the numeric
     * project id already in the path. Format observed in practice:
     * `https://test-management.browserstack.com/projects/<numericProjectId>/test-runs/<TR-NNN>`
     */
    urls?: { self?: string };
  };
  identifier?: string;
  id?: string | number;
}

export class TestManagementClient {
  #username: string;
  #accessKey: string;
  #projectId: string;
  /**
   * Numeric project id (resolved from `listTmProjects`). When set, dashboard
   * URLs use the numeric form `/projects/${numericId}/test-runs/${numericRunId}/folder`
   * — that's the format the BrowserStack TM web dashboard actually generates
   * in its address bar. The identifier-based URL (`PR-N` / `TR-N`) works at
   * the API level but doesn't always render correctly in the UI.
   */
  #numericProjectId: string | undefined;
  #runId: string | undefined;
  #timeoutMs: number | undefined;
  #maxRetries: number | undefined;

  constructor(opts: {
    username: string;
    accessKey: string;
    projectId: string;
    numericProjectId?: string | number;
    timeoutMs?: number;
    maxRetries?: number;
  }) {
    this.#username = opts.username;
    this.#accessKey = opts.accessKey;
    this.#projectId = opts.projectId;
    if (opts.numericProjectId !== undefined) {
      this.#numericProjectId = String(opts.numericProjectId);
    }
    this.#timeoutMs = opts.timeoutMs;
    this.#maxRetries = opts.maxRetries;
  }

  get runId(): string | undefined {
    return this.#runId;
  }

  attachRun(runId: string): void {
    this.#runId = runId;
  }

  async createRun(input: TmCreateRunInput): Promise<TmCreateRunResult> {
    const res = await httpRequest<TmCreateRunResponse>({
      method: 'POST',
      url: `${BASE}/projects/${this.#projectId}/test-runs`,
      headers: { authorization: this.#auth() },
      body: { test_run: input },
      ...this.#requestOverrides(),
    });
    const runId =
      res.test_run?.identifier ??
      res.identifier ??
      (res.test_run?.id != null ? String(res.test_run.id) : undefined) ??
      (res.id != null ? String(res.id) : undefined);
    if (!runId) {
      throw new Error(
        `TestManagementClient.createRun: no run id in response (${JSON.stringify(res).slice(0, 200)})`,
      );
    }
    this.#runId = runId;
    return {
      runId,
      dashboardUrl: this.#buildDashboardUrl(runId, res.test_run?.urls?.self),
    };
  }

  #buildDashboardUrl(runId: string, urlsSelf: string | undefined): string {
    // BS already returns the canonical dashboard URL in `test_run.urls.self`
    // with the numeric project id baked in — just append `/folder` to land
    // on the default tab in the dashboard. (Without `/folder` the URL
    // sometimes redirects, sometimes lands on a stale tab.)
    if (urlsSelf) {
      return urlsSelf.endsWith('/folder') ? urlsSelf : `${urlsSelf}/folder`;
    }
    // Fallback when BS didn't include urls.self (older API behavior or a
    // future shape change). Constructed-from-id form, identifier-based.
    if (this.#numericProjectId) {
      return `https://test-management.browserstack.com/projects/${this.#numericProjectId}/test-runs/${runId}/folder`;
    }
    return `https://test-management.browserstack.com/projects/${this.#projectId}/test-runs/${runId}`;
  }

  async postResults(results: TmTestResult[]): Promise<void> {
    if (results.length === 0) return;
    if (!this.#runId) throw new Error('TestManagementClient.postResults: no run attached');
    // API caps each request at 300 results.
    const CHUNK = 300;
    for (let i = 0; i < results.length; i += CHUNK) {
      const chunk = results.slice(i, i + CHUNK);
      await httpRequest({
        method: 'POST',
        url: `${BASE}/projects/${this.#projectId}/test-runs/${this.#runId}/results`,
        headers: { authorization: this.#auth() },
        body: { results: chunk },
        ...this.#requestOverrides(),
      });
    }
  }

  /**
   * Page through `/test-cases` and return the set of every existing case
   * identifier in the project. Used by the pre-flight check to detect
   * missing TC IDs before the run starts. Note: TM uses `p=N` (NOT
   * `page=N`) for pagination, with a server-side `per_page` cap of ~30.
   */
  async listAllCaseIdentifiers(): Promise<Set<string>> {
    const ids = new Set<string>();
    let page = 1;
    while (page <= 100) {
      const res = await httpRequest<{
        test_cases?: Array<{ identifier?: string }>;
        info?: { next?: number | null };
      }>({
        method: 'GET',
        url: `${BASE}/projects/${this.#projectId}/test-cases?p=${page}&per_page=200`,
        headers: { authorization: this.#auth() },
        ...this.#requestOverrides(),
      });
      const cases = res.test_cases ?? [];
      for (const c of cases) if (c.identifier) ids.add(c.identifier);
      if (!res.info?.next) break;
      page = res.info.next;
    }
    return ids;
  }

  async closeRun(input?: { run_state?: 'done' | 'closed' }): Promise<void> {
    if (!this.#runId) throw new Error('TestManagementClient.closeRun: no run attached');
    await this.closeRunById(this.#runId, input);
  }

  /**
   * Close a specific run by id. Same endpoint as `closeRun`, but doesn't
   * require the run to be attached. Used to sweep BS-auto-created shadow
   * TM runs (named after `buildName`) that pile up in `done/active` because
   * BS provisions them server-side and never closes them.
   */
  async closeRunById(
    runId: string,
    input?: { run_state?: 'done' | 'closed' },
  ): Promise<void> {
    await httpRequest({
      method: 'POST',
      url: `${BASE}/projects/${this.#projectId}/test-runs/${runId}/close`,
      headers: { authorization: this.#auth() },
      body: { test_run: { run_state: input?.run_state ?? 'done' } },
      ...this.#requestOverrides(),
    });
  }

  /**
   * List active (non-closed) test runs. Returns every result the listing
   * endpoint serves; pass `nameStartsWith` to filter client-side. Used to
   * find the BS-auto-created `<buildName> #N` shadow runs at finalize.
   */
  async listActiveRuns(opts?: {
    nameStartsWith?: string;
  }): Promise<Array<{ identifier: string; name: string; run_state: string; active_state: string }>> {
    const out: Array<{ identifier: string; name: string; run_state: string; active_state: string }> = [];
    let page = 1;
    while (page <= 100) {
      const res = await httpRequest<{
        test_runs?: Array<{
          identifier?: string;
          name?: string;
          run_state?: string;
          active_state?: string;
        }>;
        info?: { next?: number | null };
      }>({
        method: 'GET',
        url: `${BASE}/projects/${this.#projectId}/test-runs?p=${page}&per_page=200`,
        headers: { authorization: this.#auth() },
        ...this.#requestOverrides(),
      });
      for (const r of res.test_runs ?? []) {
        if (!r.identifier || !r.name) continue;
        if (r.active_state === 'closed') continue;
        if (opts?.nameStartsWith && !r.name.startsWith(opts.nameStartsWith)) continue;
        out.push({
          identifier: r.identifier,
          name: r.name,
          run_state: r.run_state ?? '',
          active_state: r.active_state ?? '',
        });
      }
      if (!res.info?.next) break;
      page = res.info.next;
    }
    return out;
  }

  #auth(): string {
    return basicAuth(this.#username, this.#accessKey);
  }

  #requestOverrides(): { timeoutMs?: number; maxRetries?: number } {
    const out: { timeoutMs?: number; maxRetries?: number } = {};
    if (this.#timeoutMs !== undefined) out.timeoutMs = this.#timeoutMs;
    if (this.#maxRetries !== undefined) out.maxRetries = this.#maxRetries;
    return out;
  }
}

export interface TmProjectSummary {
  identifier: string;
  name: string;
  /**
   * Numeric form, used to build dashboard URLs. The TM web UI uses
   * `/projects/<numeric>/test-runs/<numeric>/folder`. Older API responses
   * may not include this — consumers should fall back to identifier-based
   * URLs when undefined.
   */
  numericId?: string;
}

/**
 * List every TM project visible to these credentials, with both `identifier`
 * (PR-####) and `name`. Used by BstackService to (a) detect when an
 * Observability `projectName` would trigger BS to auto-provision a new TM
 * project, and (b) cross-validate `testManagement.projectId` against
 * `projectName` so a mismatched config can't silently land results in the
 * wrong project. Account-scoped, so not a method on the project-scoped
 * TestManagementClient.
 */
export async function listTmProjects(opts: {
  username: string;
  accessKey: string;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<TmProjectSummary[]> {
  const res = await httpRequest<{
    projects?: Array<{
      identifier?: string;
      name?: string;
      id?: string | number;
      urls?: { self?: string };
    }>;
  }>({
    method: 'GET',
    url: `${BASE}/projects`,
    headers: { authorization: basicAuth(opts.username, opts.accessKey) },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  });
  const out: TmProjectSummary[] = [];
  for (const p of res.projects ?? []) {
    if (p.identifier && p.name) {
      // BS's `/projects` response embeds the numeric id in `urls.self`
      // (e.g. `.../projects/232091`). Extract it so callers can build
      // dashboard URLs that match the BS web UI.
      const numericFromUrl = p.urls?.self
        ? p.urls.self.match(/\/projects\/(\d+)(?:\/|$)/)?.[1]
        : undefined;
      const numericId =
        p.id != null ? String(p.id) : numericFromUrl !== undefined ? numericFromUrl : undefined;
      out.push({
        identifier: p.identifier,
        name: p.name,
        ...(numericId !== undefined ? { numericId } : {}),
      });
    }
  }
  return out;
}

export function statusFromObservability(
  s: 'passed' | 'failed' | 'skipped' | 'pending' | 'timeout',
): TmStatus {
  switch (s) {
    case 'passed':
      return 'Passed';
    case 'failed':
    case 'timeout':
      return 'Failed';
    case 'skipped':
    case 'pending':
      return 'Skipped';
    default:
      return 'Failed';
  }
}

/** Extract a TC ID from an Observability identifier; returns undefined if not a TC ID. */
export function extractTcId(identifier: string): string | undefined {
  const m = identifier.match(/^(TC-\d+)$/);
  return m ? m[1] : undefined;
}
