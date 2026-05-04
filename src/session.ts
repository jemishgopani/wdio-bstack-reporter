import { Batcher } from './batcher.js';
import type { Client, Event } from './client/types.js';

/**
 * Per-worker shared object: the reporter creates it during construction so the
 * service hooks (running in the same worker process) can enqueue extra events
 * (browser logs, screenshot pointers) into the same batcher.
 *
 * Why a module-level singleton: the reporter and the service are both
 * instantiated by WDIO inside the same Node process for each spec worker,
 * but they don't see each other's instances. A singleton on the worker
 * process is the simplest reliable handoff.
 */
export interface SessionEmitter {
  enqueue(event: Event): void;
  uploadScreenshot(input: { testTitle: string; dataUrl: string }): Promise<void>;
}

let current: SessionEmitter | undefined;

export function setSessionEmitter(e: SessionEmitter | undefined): void {
  current = e;
}

export function getSessionEmitter(): SessionEmitter | undefined {
  return current;
}

export function makeSessionEmitter(args: {
  batcher: Batcher;
  client: Client;
  allowScreenshots: boolean;
}): SessionEmitter {
  return {
    enqueue: (e) => args.batcher.enqueue(e),
    uploadScreenshot: async ({ testTitle, dataUrl }) => {
      if (!args.allowScreenshots) return;
      // Best-effort: only the collector client implements the screenshots
      // endpoint; the REST client doesn't (no public endpoint exists).
      const c = args.client as Client & {
        sendScreenshot?: (b: { testTitle: string; dataUrl: string }) => Promise<void>;
      };
      if (typeof c.sendScreenshot === 'function') {
        try {
          await c.sendScreenshot({ testTitle, dataUrl });
        } catch (err) {
          console.warn('[wdio-bstack-reporter] screenshot upload failed:', err);
        }
      }
    },
  };
}

/**
 * Take a screenshot via the WebDriver session if the browser supports it.
 * Returns a `data:image/png;base64,…` URL or undefined.
 */
export async function takeScreenshotIfPossible(browser: {
  takeScreenshot?: () => Promise<string>;
}): Promise<string | undefined> {
  if (!browser?.takeScreenshot) return undefined;
  try {
    const b64 = await browser.takeScreenshot();
    if (!b64) return undefined;
    return b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
  } catch {
    return undefined;
  }
}
