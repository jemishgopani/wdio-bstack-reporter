import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, Event, BuildStopInput } from './client/types.js';

/**
 * Wraps a Client so that failed `sendEvents` and `stopBuild` calls are
 * appended as JSONL to a file under `spoolDir`. The wrapper is best-effort
 * (it doesn't throw on file I/O errors). It does not retry uploading the
 * spooled file — that's a job for an out-of-band tool reading the JSONL.
 */
export function wrapClientWithSpool(inner: Client, spoolDir: string): Client {
  let prepared = false;
  const ensureDir = () => {
    if (prepared) return;
    try {
      mkdirSync(spoolDir, { recursive: true });
      prepared = true;
    } catch {
      /* ignore */
    }
  };

  const file = (kind: 'events' | 'stop') =>
    join(
      spoolDir,
      `${new Date().toISOString().slice(0, 10)}-${kind}-${process.pid}.jsonl`,
    );

  const writeLine = (kind: 'events' | 'stop', payload: unknown) => {
    try {
      ensureDir();
      appendFileSync(file(kind), JSON.stringify(payload) + '\n', 'utf8');
    } catch {
      /* ignore: spool is best-effort */
    }
  };

  const wrapped: Client = {
    get mode() {
      return inner.mode;
    },
    get buildId() {
      return inner.buildId;
    },
    attachBuild: (a) => inner.attachBuild(a),
    createBuild: (i) => inner.createBuild(i),
    async sendEvents(events: Event[]) {
      try {
        await inner.sendEvents(events);
      } catch (err) {
        writeLine('events', {
          ts: new Date().toISOString(),
          buildId: inner.buildId,
          error: (err as Error).message,
          events,
        });
        throw err;
      }
    },
    async stopBuild(input: BuildStopInput) {
      try {
        await inner.stopBuild(input);
      } catch (err) {
        writeLine('stop', {
          ts: new Date().toISOString(),
          buildId: inner.buildId,
          error: (err as Error).message,
          input,
        });
        throw err;
      }
    },
  };

  // Pass through optional methods (e.g. sendScreenshot on the collector).
  for (const k of ['sendScreenshot'] as const) {
    const fn = (inner as unknown as Record<string, unknown>)[k];
    if (typeof fn === 'function') {
      (wrapped as unknown as Record<string, unknown>)[k] = (...args: unknown[]) =>
        (fn as (...a: unknown[]) => unknown).apply(inner, args);
    }
  }

  return wrapped;
}
