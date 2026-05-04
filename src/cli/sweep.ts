#!/usr/bin/env node
/**
 * Standalone CLI to close BrowserStack-auto-created TM "shadow" runs that
 * pile up in `done/active` because BS provisions them server-side
 * (asynchronously, sometimes minutes after WDIO finishes) and never closes
 * them. The reporter's inline sweep catches the fast cases; this CLI is
 * for the slow ones — run it as a delayed CI step or a periodic cron job.
 *
 *   npx wdio-bstack-reporter sweep --project PR-1
 *   npx wdio-bstack-reporter sweep --project PR-1 --build-name "local-2026-..."
 *   npx wdio-bstack-reporter sweep --project PR-1 --max-age 1h --dry-run
 *
 * Auth: same env vars as the reporter — BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY.
 */
import { TestManagementClient } from '../client/test-management.js';
import { pollAndClose } from '../sweep-loop.js';

interface SweepOptions {
  projectId: string;
  buildName?: string;
  maxAgeMs?: number;
  dryRun: boolean;
  /** Total time to keep polling, in ms. Default 0 (single pass). */
  waitMs?: number;
  /** Time between polls when --wait is set, in ms. Default 10s. */
  intervalMs?: number;
}

interface ParseResult {
  ok: true;
  options: SweepOptions;
}
interface ParseError {
  ok: false;
  message: string;
}

const HELP = `wdio-bstack-reporter sweep — close stuck BrowserStack TM "active" runs

Usage:
  wdio-bstack-reporter sweep --project PR-1 [options]

Options:
  --project, -p <PR-####>   TM project id (required)
  --build-name <prefix>     Only close runs whose name starts with <prefix>
  --max-age <duration>      Only close runs older than this (e.g. 1h, 30m, 2d)
  --wait <duration>         Keep polling for this long, closing as new
                            shadow runs appear. Useful right after WDIO
                            finishes since BS auto-creates the shadow with
                            a non-deterministic delay (sometimes minutes).
  --interval <duration>     Poll cadence under --wait. Default 10s.
  --dry-run                 List candidates without closing
  --help, -h                Print this help

Auth: BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY env vars.`;

export function parseArgs(argv: string[]): ParseResult | ParseError {
  let projectId: string | undefined;
  let buildName: string | undefined;
  let maxAgeMs: number | undefined;
  let waitMs: number | undefined;
  let intervalMs: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${a} requires a value`);
      }
      i += 1;
      return v;
    };
    try {
      switch (a) {
        case '--project':
        case '-p':
          projectId = next();
          break;
        case '--build-name':
          buildName = next();
          break;
        case '--max-age': {
          const ms = parseDuration(next());
          if (ms === undefined) return { ok: false, message: `Invalid --max-age (use 30m, 1h, 2d)` };
          maxAgeMs = ms;
          break;
        }
        case '--wait': {
          const ms = parseDuration(next());
          if (ms === undefined) return { ok: false, message: `Invalid --wait (use 5m, 10m, 1h)` };
          waitMs = ms;
          break;
        }
        case '--interval': {
          const ms = parseDuration(next());
          if (ms === undefined) return { ok: false, message: `Invalid --interval (use 10s, 30s, 1m)` };
          intervalMs = ms;
          break;
        }
        case '--dry-run':
          dryRun = true;
          break;
        case '--help':
        case '-h':
          return { ok: false, message: HELP };
        default:
          return { ok: false, message: `Unknown arg: ${a}\n\n${HELP}` };
      }
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  if (!projectId) return { ok: false, message: `--project is required\n\n${HELP}` };
  if (!/^PR-\d+$/.test(projectId)) {
    return { ok: false, message: `--project must look like PR-1234 (got ${JSON.stringify(projectId)})` };
  }

  const options: SweepOptions = { projectId, dryRun };
  if (buildName !== undefined) options.buildName = buildName;
  if (maxAgeMs !== undefined) options.maxAgeMs = maxAgeMs;
  if (waitMs !== undefined) options.waitMs = waitMs;
  if (intervalMs !== undefined) options.intervalMs = intervalMs;
  return { ok: true, options };
}

export function parseDuration(s: string): number | undefined {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(s.trim());
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * mult[unit]!;
}

export interface SweepResult {
  scanned: number;
  matched: number;
  closed: number;
  failed: number;
  dryRun: boolean;
}

export async function sweep(
  opts: SweepOptions,
  deps: {
    username: string;
    accessKey: string;
    now?: () => number;
    log?: (msg: string) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<SweepResult> {
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tm = new TestManagementClient({
    username: deps.username,
    accessKey: deps.accessKey,
    projectId: opts.projectId,
  });

  if (opts.waitMs && opts.waitMs > 0 && !opts.dryRun) {
    return runWithWait(opts, deps, tm, log, sleep);
  }
  return singlePass(opts, deps, tm, log);
}

async function singlePass(
  opts: SweepOptions,
  deps: { username: string; accessKey: string; now?: () => number },
  tm: TestManagementClient,
  log: (msg: string) => void,
): Promise<SweepResult> {
  const now = deps.now ? deps.now() : Date.now();
  const listOpts: { nameStartsWith?: string } = {};
  if (opts.buildName) listOpts.nameStartsWith = opts.buildName;
  const candidates = await tm.listActiveRuns(listOpts);

  let filtered = candidates;
  if (opts.maxAgeMs !== undefined) {
    const cutoff = now - opts.maxAgeMs;
    const passes: typeof candidates = [];
    for (const c of candidates) {
      const meta = await fetchRunMeta(deps.username, deps.accessKey, opts.projectId, c.identifier);
      const created = meta?.created_at ? Date.parse(meta.created_at) : NaN;
      if (Number.isFinite(created) && created < cutoff) passes.push(c);
    }
    filtered = passes;
  }

  log(`scanned ${candidates.length} active run(s); ${filtered.length} match filter`);
  if (opts.dryRun) {
    for (const r of filtered) log(`  [dry-run] would close ${r.identifier}  ${JSON.stringify(r.name)}`);
    return { scanned: candidates.length, matched: filtered.length, closed: 0, failed: 0, dryRun: true };
  }

  let closed = 0;
  let failed = 0;
  for (const r of filtered) {
    try {
      await tm.closeRunById(r.identifier, { run_state: 'done' });
      closed += 1;
      log(`  ✓ closed ${r.identifier}  ${JSON.stringify(r.name)}`);
    } catch (err) {
      failed += 1;
      log(`  ✗ failed ${r.identifier}  ${(err as Error).message}`);
    }
  }
  return { scanned: candidates.length, matched: filtered.length, closed, failed, dryRun: false };
}

/**
 * Poll-and-close loop. Delegates to the shared `pollAndClose` helper from
 * src/sweep-loop.ts so the CLI and the in-service inline sweep share a
 * single codepath.
 *
 * Requires --build-name so the prefix filter is non-trivial — without it
 * we'd risk closing other CI jobs' runs in the same project.
 */
async function runWithWait(
  opts: SweepOptions,
  deps: { username: string; accessKey: string; now?: () => number },
  tm: TestManagementClient,
  log: (msg: string) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<SweepResult> {
  const intervalMs = opts.intervalMs ?? 10_000;
  const waitMs = opts.waitMs ?? 0;
  const prefix = opts.buildName ?? '';
  if (!prefix) {
    log(
      'WARN: --wait without --build-name. The poll loop will close every active run that ' +
        'matches the empty prefix (i.e. ALL active runs in the project). To restrict to one ' +
        "build's shadows, pass --build-name.",
    );
  }
  log(
    `waiting up to ${Math.round(waitMs / 1000)}s, polling every ${Math.round(intervalMs / 1000)}s`,
  );
  const result = await pollAndClose(
    tm,
    { nameStartsWith: prefix, waitMs, intervalMs },
    {
      log: (msg) => log(`[poll] ${msg}`),
      sleep,
      ...(deps.now ? { now: deps.now } : {}),
    },
  );
  log(`wait complete: ${result.closed} closed across ${result.polls} poll(s)`);
  return {
    scanned: result.closed + result.failed,
    matched: result.closed + result.failed,
    closed: result.closed,
    failed: result.failed,
    dryRun: false,
  };
}

async function fetchRunMeta(
  username: string,
  accessKey: string,
  projectId: string,
  runId: string,
): Promise<{ created_at?: string } | undefined> {
  const auth = 'Basic ' + Buffer.from(`${username}:${accessKey}`).toString('base64');
  const url = `https://test-management.browserstack.com/api/v2/projects/${projectId}/test-runs/${runId}`;
  const res = await fetch(url, { headers: { authorization: auth, accept: 'application/json' } });
  if (!res.ok) return undefined;
  const j = (await res.json()) as { test_run?: { created_at?: string } };
  return j.test_run;
}

export async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP);
    return 0;
  }
  if (sub !== 'sweep') {
    console.error(`Unknown subcommand: ${sub}\n\n${HELP}`);
    return 2;
  }

  const parsed = parseArgs(argv.slice(1));
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }

  const username = process.env.BROWSERSTACK_USERNAME;
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY;
  if (!username || !accessKey) {
    console.error('Missing BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY env vars.');
    return 2;
  }

  try {
    const result = await sweep(parsed.options, { username, accessKey });
    console.log(
      `Done. scanned=${result.scanned} matched=${result.matched} closed=${result.closed} failed=${result.failed}${result.dryRun ? ' (dry-run)' : ''}`,
    );
    return result.failed > 0 ? 1 : 0;
  } catch (err) {
    console.error('sweep failed:', (err as Error).message);
    return 1;
  }
}

