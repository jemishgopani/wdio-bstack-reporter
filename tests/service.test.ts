import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BstackService from '../src/service.js';
import { ENV } from '../src/env.js';

describe('BstackService', () => {
  const fetchMock = vi.fn();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';
    delete process.env[ENV.BUILD_ID];
    delete process.env[ENV.JWT];
    delete process.env[ENV.API_MODE];
    delete process.env[ENV.BATCH_ID];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('creates a build in onPrepare and writes env vars', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ build_hashed_id: 'BHX', jwt: 'JWT-1', allow_screenshots: true }),
        { status: 200 },
      ),
    );

    const svc = new BstackService({
      projectName: 'p',
      buildName: 'b',
      batchId: 'batch-9',
      preventTmAutoCreate: false,
    });
    await svc.onPrepare();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/api/v1/builds');
    const body = JSON.parse(init.body);
    expect(body.build_identifier).toBe('batch-9');
    expect(body.project_name).toBe('p');

    expect(process.env[ENV.BUILD_ID]).toBe('BHX');
    expect(process.env[ENV.JWT]).toBe('JWT-1');
    expect(process.env[ENV.API_MODE]).toBe('collector');
  });

  it('reuses an existing build in env when present', async () => {
    process.env[ENV.BUILD_ID] = 'EXISTING';
    process.env[ENV.API_MODE] = 'collector';
    const svc = new BstackService({});
    await svc.onPrepare();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips build creation gracefully when credentials are missing', async () => {
    delete process.env[ENV.USERNAME];
    delete process.env[ENV.ACCESS_KEY];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = new BstackService({});
    await svc.onPrepare();
    expect(err).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('preventTmAutoCreate', () => {
    it('exits when projectName does not match any TM project', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ projects: [{ identifier: 'PR-1', name: 'Demo Project' }] }),
          { status: 200 },
        ),
      );
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation((code?) => {
          throw new Error(`exit:${code}`);
        });
      const svc = new BstackService({
        projectName: 'sandbox-123',
        preventTmAutoCreate: true,
      });
      await expect(svc.onPrepare()).rejects.toThrow(/exit:1/);
      expect(
        err.mock.calls.some((c) =>
          String(c[0]).includes('does not match any existing Test Management project'),
        ),
      ).toBe(true);
      expect(exit).toHaveBeenCalledWith(1);
      // Only the GET /projects call — no /api/v1/builds.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toContain('/api/v2/projects');
      exit.mockRestore();
    });

    it('proceeds when projectName matches an existing TM project', async () => {
      fetchMock
        // GET /api/v2/projects → match exists.
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ projects: [{ identifier: 'PR-1', name: 'Demo Project' }] }),
            { status: 200 },
          ),
        )
        // POST /api/v1/builds → normal createBuild.
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ build_hashed_id: 'B1' }), { status: 200 }),
        );

      const svc = new BstackService({
        projectName: 'Demo Project',
        preventTmAutoCreate: true,
      });
      await svc.onPrepare();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]![0]).toContain('/api/v2/projects');
      expect(fetchMock.mock.calls[1]![0]).toContain('/api/v1/builds');
    });
  });

  describe('projectId/projectName cross-check', () => {
    it('exits when projectId points at a project whose name differs from projectName', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            projects: [
              { identifier: 'PR-1', name: 'Demo Project' },
              { identifier: 'PR-2', name: 'Other Project' },
            ],
          }),
          { status: 200 },
        ),
      );
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = vi.spyOn(process, 'exit').mockImplementation((code?) => {
        throw new Error(`exit:${code}`);
      });
      const svc = new BstackService({
        projectName: 'Demo Project',
        testManagement: { projectId: 'PR-2' },
      });
      await expect(svc.onPrepare()).rejects.toThrow(/exit:1/);
      expect(
        err.mock.calls.some((c) =>
          String(c[0]).includes('Mismatch: testManagement.projectId'),
        ),
      ).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      exit.mockRestore();
    });

    it('exits when projectId does not exist at all', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ projects: [{ identifier: 'PR-1', name: 'Demo Project' }] }),
          { status: 200 },
        ),
      );
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = vi.spyOn(process, 'exit').mockImplementation((code?) => {
        throw new Error(`exit:${code}`);
      });
      const svc = new BstackService({
        projectName: 'Demo Project',
        testManagement: { projectId: 'PR-99' },
      });
      await expect(svc.onPrepare()).rejects.toThrow(/exit:1/);
      expect(
        err.mock.calls.some((c) =>
          String(c[0]).includes('does not exist in this account'),
        ),
      ).toBe(true);
      exit.mockRestore();
    });

    it('proceeds when projectId and projectName both reference the same TM project', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              projects: [{ identifier: 'PR-1', name: 'Demo Project' }],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ build_hashed_id: 'B1' }), { status: 200 }),
        )
        // TM run create
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ test_run: { identifier: 'TR-1' } }),
            { status: 200 },
          ),
        )
        // preflight test-cases listing
        .mockResolvedValue(
          new Response(
            JSON.stringify({ test_cases: [], info: { next: null } }),
            { status: 200 },
          ),
        );

      const svc = new BstackService({
        projectName: 'Demo Project',
        testManagement: { projectId: 'PR-1' },
      });
      await svc.onPrepare({}, undefined);

      const calls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(calls[0]).toContain('/api/v2/projects');
      expect(calls.some((u) => u.includes('/api/v1/builds'))).toBe(true);
    });
  });

  it('finalizes the build in onComplete with result based on failures', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ build_hashed_id: 'B1' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const svc = new BstackService({ preventTmAutoCreate: false });
    await svc.onPrepare();
    await svc.onComplete(1, {}, {}, { failed: 2, passed: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [stopUrl, stopInit] = fetchMock.mock.calls[1]!;
    expect(stopUrl).toContain('/api/v1/builds/B1/stop');
    expect(stopInit.method).toBe('PUT');
    const body = JSON.parse(stopInit.body);
    // Match the official service shape: stop_time (NOT finished_at).
    expect(body.stop_time).toBeDefined();
    expect(body.finished_at).toBeUndefined();
    expect(body.result).toBe('failed');
  });

  describe('autoCloseTestRun', () => {
    beforeEach(() => {
      // Common: createBuild, createTmRun, list-cases, stopBuild responses.
      // Tests below append the TM-close response only when expected.
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/api/v2/projects')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                projects: [{ identifier: 'PR-7', name: 'PR-7-Project' }],
              }),
              { status: 200 },
            ),
          );
        }
        if (url.includes('/api/v1/builds') && url.endsWith('/stop')) {
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        if (url.includes('/api/v1/builds')) {
          return Promise.resolve(
            new Response(JSON.stringify({ build_hashed_id: 'B1' }), { status: 200 }),
          );
        }
        if (url.includes('test-management.browserstack.com') && url.includes('/test-runs') && !url.endsWith('/close')) {
          // POST /test-runs (create) — return identifier
          if (!url.match(/test-runs\/TR-/)) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ test_run: { identifier: 'TR-99' } }),
                { status: 200 },
              ),
            );
          }
        }
        if (url.includes('/test-cases')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ test_cases: [], info: { next: null } }),
              { status: 200 },
            ),
          );
        }
        // closeRun and anything else
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
    });

    it('closes the TM run by default (autoCloseTestRun=true)', async () => {
      const svc = new BstackService({
        projectName: 'PR-7-Project',
        testManagement: { projectId: 'PR-7' },
        preventTmAutoCreate: false,
      });
      await svc.onPrepare({}, undefined);
      await svc.onComplete(0, {}, {}, { failed: 0 });
      const closeCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/test-runs/TR-99/close'),
      );
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0]?.[1].method).toBe('POST');
    });

    it('leaves the TM run open when autoCloseTestRun=false', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const svc = new BstackService({
        projectName: 'PR-7-Project',
        testManagement: { projectId: 'PR-7', autoCloseTestRun: false },
        preventTmAutoCreate: false,
      });
      await svc.onPrepare({}, undefined);
      await svc.onComplete(0, {}, {}, { failed: 0 });
      const closeCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/test-runs/TR-99/close'),
      );
      expect(closeCalls).toHaveLength(0);
      expect(
        log.mock.calls.some((c) => String(c[0]).includes('TM run left open')),
      ).toBe(true);
    });
  });

  describe('observability + testManagement independence', () => {
    beforeEach(() => {
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/api/v2/projects')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ projects: [{ identifier: 'PR-7', name: 'PR-7-Project' }] }),
              { status: 200 },
            ),
          );
        }
        if (url.includes('/api/v1/builds') && url.endsWith('/stop')) {
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        if (url.includes('/api/v1/builds')) {
          return Promise.resolve(
            new Response(JSON.stringify({ build_hashed_id: 'B1' }), { status: 200 }),
          );
        }
        if (
          url.includes('test-management.browserstack.com') &&
          url.includes('/test-runs') &&
          !url.endsWith('/close') &&
          !url.match(/test-runs\?p=/) &&
          !url.match(/test-runs\/TR-/)
        ) {
          return Promise.resolve(
            new Response(JSON.stringify({ test_run: { identifier: 'TR-99' } }), { status: 200 }),
          );
        }
        if (url.includes('/test-cases')) {
          return Promise.resolve(
            new Response(JSON.stringify({ test_cases: [], info: { next: null } }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
    });

    it('observability=false + TM configured → creates TM run, no Observability build', async () => {
      const svc = new BstackService({
        projectName: 'PR-7-Project',
        observability: { enabled: false },
        testManagement: { projectId: 'PR-7' },
        preventTmAutoCreate: false,
      });
      await svc.onPrepare({}, undefined);
      await svc.onComplete(0, {}, {}, { failed: 0 });
      const buildCreate = fetchMock.mock.calls.filter(
        ([url]) => String(url).includes('/api/v1/builds') && !String(url).endsWith('/stop'),
      );
      const buildStop = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/v1/builds') && String(url).endsWith('/stop'),
      );
      expect(buildCreate).toHaveLength(0);
      expect(buildStop).toHaveLength(0);
      // TM run created and closed
      const tmCreate = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).match(/test-management.*\/test-runs$/) && init?.method === 'POST',
      );
      const tmClose = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/test-runs/TR-99/close'),
      );
      expect(tmCreate.length).toBeGreaterThan(0);
      expect(tmClose).toHaveLength(1);
      // No env vars for Observability — reporter will no-op cleanly
      expect(process.env[ENV.BUILD_ID]).toBeUndefined();
    });

    it('observability=false + no TM → no-ops with warning, makes no API calls', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const svc = new BstackService({
        projectName: 'p',
        observability: { enabled: false },
      });
      await svc.onPrepare({}, undefined);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes('Both Observability and Test Management are disabled'),
        ),
      ).toBe(true);
    });

    it('observability default + no TM → creates Observability build only (existing behavior)', async () => {
      const svc = new BstackService({
        projectName: 'PR-7-Project',
        preventTmAutoCreate: false,
      });
      await svc.onPrepare({}, undefined);
      await svc.onComplete(0, {}, {}, { failed: 0 });
      const buildCreate = fetchMock.mock.calls.filter(
        ([url]) => String(url).includes('/api/v1/builds') && !String(url).endsWith('/stop'),
      );
      expect(buildCreate.length).toBe(1);
      const tmCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('test-management.browserstack.com'),
      );
      expect(tmCalls).toHaveLength(0);
    });
  });

  describe('user-readable env vars', () => {
    it('keeps DASHBOARD_URL and TM_DASHBOARD_URL set after onComplete (for user-defined notifier services)', async () => {
      fetchMock.mockImplementation((url: string) => {
        if (String(url).endsWith('/api/v2/projects')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ projects: [{ identifier: 'PR-7', name: 'PR-7-Project' }] }),
              { status: 200 },
            ),
          );
        }
        if (String(url).includes('/api/v1/builds') && String(url).endsWith('/stop')) {
          return Promise.resolve(new Response('{}', { status: 200 }));
        }
        if (String(url).includes('/api/v1/builds')) {
          return Promise.resolve(
            new Response(JSON.stringify({ build_hashed_id: 'BURL' }), { status: 200 }),
          );
        }
        if (
          String(url).includes('test-management.browserstack.com') &&
          String(url).includes('/test-runs') &&
          !String(url).endsWith('/close') &&
          !String(url).match(/test-runs\/TR-/)
        ) {
          return Promise.resolve(
            new Response(JSON.stringify({ test_run: { identifier: 'TR-9' } }), { status: 200 }),
          );
        }
        if (String(url).includes('/test-cases')) {
          return Promise.resolve(
            new Response(JSON.stringify({ test_cases: [], info: { next: null } }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const svc = new BstackService({
        projectName: 'PR-7-Project',
        testManagement: { projectId: 'PR-7' },
        preventTmAutoCreate: false,
      });
      await svc.onPrepare({}, undefined);
      await svc.onComplete(0, {}, {}, { finished: 1, passed: 1, failed: 0 });
      // These two URL env vars MUST persist after onComplete so that user-
      // defined services can read them in their own onComplete (recipe in
      // README). Treat as part of the public API.
      expect(process.env[ENV.DASHBOARD_URL]).toContain('https://observability.browserstack.com');
      expect(process.env[ENV.TM_DASHBOARD_URL]).toContain('https://test-management.browserstack.com');
      // These ones are still cleared (sensitive/behavioral).
      expect(process.env[ENV.BUILD_ID]).toBeUndefined();
      expect(process.env[ENV.TM_RUN_ID]).toBeUndefined();
    });
  });
});
