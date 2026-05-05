import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TestManagementClient,
  extractTcId,
  statusFromObservability,
} from '../src/client/test-management.js';

describe('TestManagementClient', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createRun POSTs to the project endpoint and returns runId', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ test_run: { identifier: 'TR-42' } }), { status: 200 }),
    );
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-7',
      maxRetries: 0,
    });
    const r = await c.createRun({ name: 'sample', include_all: true, run_state: 'in_progress' });
    expect(r.runId).toBe('TR-42');
    expect(r.dashboardUrl).toContain('PR-7');
    expect(r.dashboardUrl).toContain('TR-42');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://test-management.browserstack.com/api/v2/projects/PR-7/test-runs');
    const body = JSON.parse(init.body);
    expect(body.test_run.name).toBe('sample');
    expect(body.test_run.include_all).toBe(true);
  });

  it('createRun uses the canonical urls.self from the API response and appends /folder', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          test_run: {
            identifier: 'TR-258',
            urls: {
              self: 'https://test-management.browserstack.com/projects/232091/test-runs/TR-258',
            },
          },
        }),
        { status: 200 },
      ),
    );
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-1',
      maxRetries: 0,
    });
    const r = await c.createRun({ name: 'sample' });
    expect(r.runId).toBe('TR-258');
    expect(r.dashboardUrl).toBe(
      'https://test-management.browserstack.com/projects/232091/test-runs/TR-258/folder',
    );
  });

  it('createRun does not double the /folder suffix when the API already includes it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          test_run: {
            identifier: 'TR-9',
            urls: {
              self: 'https://test-management.browserstack.com/projects/123/test-runs/TR-9/folder',
            },
          },
        }),
        { status: 200 },
      ),
    );
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-1',
      maxRetries: 0,
    });
    const r = await c.createRun({ name: 'x' });
    expect(r.dashboardUrl).toBe(
      'https://test-management.browserstack.com/projects/123/test-runs/TR-9/folder',
    );
  });

  it('createRun falls back to a synthesized URL when urls.self is missing (numericProjectId set)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ test_run: { identifier: 'TR-42' } }), { status: 200 }),
    );
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-7',
      numericProjectId: '232091',
      maxRetries: 0,
    });
    const r = await c.createRun({ name: 'sample' });
    expect(r.dashboardUrl).toBe(
      'https://test-management.browserstack.com/projects/232091/test-runs/TR-42/folder',
    );
  });

  it('createRun falls back to identifier-based dashboard URL when nothing else is available', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ test_run: { identifier: 'TR-42' } }), { status: 200 }),
    );
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-7',
      maxRetries: 0,
    });
    const r = await c.createRun({ name: 'sample' });
    expect(r.dashboardUrl).toBe(
      'https://test-management.browserstack.com/projects/PR-7/test-runs/TR-42',
    );
  });

  it('postResults chunks at 300 per request', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-1',
      maxRetries: 0,
    });
    c.attachRun('TR-1');
    const results = Array.from({ length: 700 }, (_, i) => ({
      test_case_id: `TC-${i + 1}`,
      test_result: { status: 'Passed' as const },
    }));
    await c.postResults(results);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 300 + 300 + 100
    const sizes = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).results.length);
    expect(sizes).toEqual([300, 300, 100]);
  });

  it('postResults throws when no run is attached', async () => {
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-1',
    });
    await expect(c.postResults([{ test_case_id: 'TC-1', test_result: { status: 'Passed' } }])).rejects.toThrow();
  });

  it('closeRun POSTs to the close endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-7',
      maxRetries: 0,
    });
    c.attachRun('TR-9');
    await c.closeRun({ run_state: 'done' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://test-management.browserstack.com/api/v2/projects/PR-7/test-runs/TR-9/close',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ test_run: { run_state: 'done' } });
  });

  it('uses HTTP Basic auth on every call', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ test_run: { identifier: 'TR-1' } }), { status: 200 }),
    );
    const c = new TestManagementClient({
      username: 'u',
      accessKey: 'k',
      projectId: 'PR-1',
      maxRetries: 0,
    });
    await c.createRun({ name: 'x' });
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toMatch(/^Basic /);
  });
});

describe('extractTcId / statusFromObservability', () => {
  it('extractTcId only matches TC-NNN', () => {
    expect(extractTcId('TC-82')).toBe('TC-82');
    expect(extractTcId('TC-1')).toBe('TC-1');
    expect(extractTcId('foo/bar.spec.ts::test')).toBeUndefined();
    expect(extractTcId('JIRA-12')).toBeUndefined();
  });

  it('statusFromObservability maps Observability statuses to TM statuses', () => {
    expect(statusFromObservability('passed')).toBe('Passed');
    expect(statusFromObservability('failed')).toBe('Failed');
    expect(statusFromObservability('timeout')).toBe('Failed');
    expect(statusFromObservability('skipped')).toBe('Skipped');
    expect(statusFromObservability('pending')).toBe('Skipped');
  });
});
