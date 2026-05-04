import type { TestManagementClient } from './client/test-management.js';

export interface PollSweepInput {
  /**
   * Required prefix filter — only runs whose name starts with this string
   * will be considered. The service passes `buildName` so we never touch
   * runs that belong to other CI jobs / earlier WDIO invocations.
   */
  nameStartsWith: string;
  /** Total wait budget in ms. */
  waitMs: number;
  /** Interval between polls in ms. */
  intervalMs: number;
}

export interface PollSweepDeps {
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PollSweepResult {
  /** Total runs closed across all polls. */
  closed: number;
  /** Runs the close call rejected. */
  failed: number;
  /** How many polls we ran (1 = single pass, no waiting). */
  polls: number;
  /** Whether we stopped because of the deadline (true) or empty exit (false). */
  timedOut: boolean;
  /** Identifiers we closed. */
  closedIds: string[];
}

/**
 * Polls the TM project for active runs whose name starts with the given
 * prefix, closes each one, and keeps polling until either:
 *   - we've closed at least one AND a follow-up poll comes back empty
 *     (BS finished provisioning), or
 *   - the wait budget is exhausted.
 *
 * Scope safety: ALL filtering happens via `nameStartsWith`. We never close
 * a run that doesn't match the prefix, so concurrent CI jobs and earlier
 * runs in the same project are untouched.
 */
export async function pollAndClose(
  tm: TestManagementClient,
  input: PollSweepInput,
  deps: PollSweepDeps = {},
): Promise<PollSweepResult> {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowFn = deps.now ?? Date.now;

  const startedAt = nowFn();
  const deadline = startedAt + input.waitMs;
  const closedIds: string[] = [];
  let closed = 0;
  let failed = 0;
  let polls = 0;
  let closedAtLeastOne = false;
  let consecutiveEmpty = 0;

  for (;;) {
    polls += 1;
    let candidates;
    try {
      candidates = await tm.listActiveRuns({ nameStartsWith: input.nameStartsWith });
    } catch (err) {
      log(`poll ${polls}: list failed (${(err as Error).message})`);
      const t = nowFn();
      if (t >= deadline) return { closed, failed, polls, timedOut: true, closedIds };
      await sleep(Math.min(input.intervalMs, deadline - t));
      continue;
    }

    if (candidates.length === 0) {
      consecutiveEmpty += 1;
      // Exit the moment we've closed at least one and seen an empty poll.
      if (closedAtLeastOne) break;
    } else {
      consecutiveEmpty = 0;
      for (const r of candidates) {
        // Defensive: prefix is enforced server-side via the list filter, but
        // double-check before any /close call so nothing else can slip through.
        if (!r.name.startsWith(input.nameStartsWith)) continue;
        try {
          await tm.closeRunById(r.identifier, { run_state: 'done' });
          closed += 1;
          closedIds.push(r.identifier);
          closedAtLeastOne = true;
          log(`poll ${polls}: closed ${r.identifier} (${r.name})`);
        } catch (err) {
          failed += 1;
          log(`poll ${polls}: close ${r.identifier} failed (${(err as Error).message})`);
        }
      }
    }

    const t = nowFn();
    if (t >= deadline) {
      return { closed, failed, polls, timedOut: true, closedIds };
    }
    await sleep(Math.min(input.intervalMs, deadline - t));
  }

  return { closed, failed, polls, timedOut: false, closedIds };
}
