import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapClientWithSpool } from '../src/spool.js';
import type { Client } from '../src/client/types.js';

function makeFailing(): Client {
  return {
    mode: 'collector',
    buildId: 'b',
    attachBuild: vi.fn(),
    createBuild: vi.fn() as never,
    sendEvents: vi.fn().mockRejectedValue(new Error('network down')),
    stopBuild: vi.fn().mockRejectedValue(new Error('network down')),
  };
}

describe('wrapClientWithSpool', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bstack-spool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes failed events to JSONL and rethrows', async () => {
    const client = wrapClientWithSpool(makeFailing(), dir);
    await expect(
      client.sendEvents([
        {
          event_type: 'TestRunStarted',
          test_run: {
            uuid: '1',
            name: 't',
            scope: '',
            scopes: [],
            identifier: 't',
            file_name: '',
            location: '',
            started_at: new Date().toISOString(),
          },
        },
      ]),
    ).rejects.toThrow('network down');

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const fname = files[0]!;
    expect(fname).toContain('events');
    const line = JSON.parse(readFileSync(join(dir, fname), 'utf8').trim());
    expect(line.events).toHaveLength(1);
    expect(line.events[0].event_type).toBe('TestRunStarted');
  });

  it('writes failed stopBuild calls', async () => {
    const client = wrapClientWithSpool(makeFailing(), dir);
    await expect(
      client.stopBuild({ finished_at: new Date().toISOString(), result: 'passed' }),
    ).rejects.toThrow();
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes('stop'))).toBe(true);
  });

  it('passes through optional methods like sendScreenshot', async () => {
    const sendScreenshot = vi.fn().mockResolvedValue(undefined);
    const inner = { ...makeFailing(), sendScreenshot } as Client & {
      sendScreenshot: typeof sendScreenshot;
    };
    const wrapped = wrapClientWithSpool(inner, dir) as Client & {
      sendScreenshot: typeof sendScreenshot;
    };
    await wrapped.sendScreenshot({ testTitle: 'x', dataUrl: 'data:image/png;base64,abc' });
    expect(sendScreenshot).toHaveBeenCalledOnce();
  });
});
