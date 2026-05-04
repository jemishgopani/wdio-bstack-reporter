import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BstackService from '../src/service.js';
import { ENV } from '../src/env.js';
import { makeSessionEmitter, setSessionEmitter } from '../src/session.js';
import type { Client, Event } from '../src/client/types.js';
import { Batcher } from '../src/batcher.js';

function fakeClient(): Client & { sendEvents: ReturnType<typeof vi.fn>; sendScreenshot: ReturnType<typeof vi.fn> } {
  return {
    mode: 'collector',
    buildId: 'b',
    attachBuild: vi.fn(),
    createBuild: vi.fn() as never,
    sendEvents: vi.fn().mockResolvedValue(undefined),
    stopBuild: vi.fn().mockResolvedValue(undefined),
    sendScreenshot: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe('BstackService worker hooks', () => {
  const originalEnv = { ...process.env };
  let captured: Event[] = [];

  beforeEach(() => {
    captured = [];
    process.env[ENV.BUILD_ID] = 'b';
    process.env[ENV.API_MODE] = 'collector';
    process.env[ENV.ALLOW_SCREENSHOTS] = 'true';
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';
    const client = fakeClient();
    const batcher = new Batcher(client, { maxBatchSize: 1, intervalMs: 100_000 });
    // Spy on enqueue by replacing it.
    const orig = batcher.enqueue.bind(batcher);
    batcher.enqueue = (e: Event) => {
      captured.push(e);
      orig(e);
    };
    setSessionEmitter(makeSessionEmitter({ batcher, client, allowScreenshots: true }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setSessionEmitter(undefined);
  });

  it('captureLogs=true pushes browser console logs as LogCreated events', async () => {
    const svc = new BstackService({ captureLogs: true });
    const browser = {
      getLogs: vi.fn().mockResolvedValue([
        { level: 'SEVERE', message: 'oops', timestamp: 1000 },
        { level: 'INFO', message: 'hello', timestamp: 1500 },
      ]),
    };
    svc.before(undefined, [], browser as never);
    await svc.afterCommand('click', [], undefined);
    expect(browser.getLogs).toHaveBeenCalledWith('browser');
    const log = captured.find((e) => e.event_type === 'LogCreated');
    expect(log).toBeDefined();
    if (log && log.event_type === 'LogCreated') {
      expect(log.logs).toHaveLength(2);
      expect(log.logs[0]!.kind).toBe('ERROR');
      expect(log.logs[1]!.kind).toBe('INFO');
    }
  });

  it('captureLogs=false (default) skips getLogs', async () => {
    const svc = new BstackService({});
    const browser = { getLogs: vi.fn().mockResolvedValue([]) };
    svc.before(undefined, [], browser as never);
    await svc.afterCommand('click', [], undefined);
    expect(browser.getLogs).not.toHaveBeenCalled();
  });

  it('takes a screenshot in afterTest when test failed', async () => {
    const svc = new BstackService({ captureScreenshotsOnFailure: true });
    const browser = {
      takeScreenshot: vi.fn().mockResolvedValue('aGVsbG8='),
    };
    svc.before(undefined, [], browser as never);
    await svc.afterTest({ title: 't', fullTitle: 'g > t' }, undefined, { passed: false });
    expect(browser.takeScreenshot).toHaveBeenCalled();
    const log = captured.find((e) => e.event_type === 'LogCreated');
    expect(log).toBeDefined();
  });

  it('skips screenshot when test passed', async () => {
    const svc = new BstackService({ captureScreenshotsOnFailure: true });
    const browser = { takeScreenshot: vi.fn() };
    svc.before(undefined, [], browser as never);
    await svc.afterTest({ title: 't' }, undefined, { passed: true });
    expect(browser.takeScreenshot).not.toHaveBeenCalled();
  });
});

describe('BstackService signal handler', () => {
  const fetchMock = vi.fn();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';
    delete process.env[ENV.BUILD_ID];
    delete process.env[ENV.API_MODE];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('finalizes the build on SIGINT and re-raises the signal', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ build_hashed_id: 'B' }), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT /stop

    const svc = new BstackService({ preventTmAutoCreate: false });
    await svc.onPrepare(undefined, undefined);
    // Spy on process.kill to intercept the re-raise.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    process.emit('SIGINT');
    // Allow the async finalize to resolve.
    await new Promise((res) => setTimeout(res, 50));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const stopCall = fetchMock.mock.calls[1]!;
    expect(stopCall[0]).toContain('/stop');
    const body = JSON.parse(stopCall[1].body);
    expect(body.stop_time).toBeDefined();
    expect(body.result).toBe('failed');
    expect(body.meta.aborted).toBe(true);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    kill.mockRestore();
  });
});
