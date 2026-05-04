#!/usr/bin/env node
/**
 * Standalone CLI for the same preflight check the launcher service runs in
 * `onPrepare`: scan spec files for TC IDs, list the project's case catalog,
 * and report any IDs that are present in specs but missing from the
 * catalog (the BS TM API silently drops POSTs to unknown IDs, so without
 * this check missing cases are invisible).
 *
 * Useful for: pre-commit hooks, PR CI checks, "is my catalog drift bad
 * enough that I should pre-create cases before the next run?" sanity checks.
 *
 *   npx wdio-bstack-reporter preflight --project PR-1 --specs "tests/specs/**\/*.spec.ts"
 *   npx wdio-bstack-reporter preflight --project PR-1 --specs "..." --pattern "@(TC-\d+)"
 *   npx wdio-bstack-reporter preflight --project PR-1 --specs "..." --json
 *   npx wdio-bstack-reporter preflight --project PR-1 --specs "..." --strict
 *
 * Auth: BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY env vars.
 *
 * Exit codes:
 *   0 — all spec IDs found in catalog (or --strict not set and no IDs found)
 *   1 — IDs missing from catalog and --strict set
 *   2 — bad arguments / missing env / fatal error
 */
import { TestManagementClient } from '../client/test-management.js';
import { extractTcIdsFromSpecs } from '../spec-discovery.js';

interface PreflightOptions {
  projectId: string;
  /** Glob patterns matching spec files. Required. */
  specs: string[];
  /** Regex with first capture group as the ID. Default: /\[(TC-\d+)\]/ */
  pattern: RegExp;
  /** When true, exit non-zero if any IDs are missing from the catalog. */
  strict: boolean;
  /** When true, emit JSON instead of human-readable output. */
  json: boolean;
}

interface ParseResult {
  ok: true;
  options: PreflightOptions;
}
interface ParseError {
  ok: false;
  message: string;
}

const HELP = `wdio-bstack-reporter preflight — check spec TC IDs against TM catalog

Usage:
  wdio-bstack-reporter preflight --project PR-1 --specs <glob> [options]

Options:
  --project, -p <PR-####>   TM project id (required)
  --specs, -s <glob>        Spec file glob, e.g. "tests/specs/**/*.spec.ts".
                            Can be passed multiple times.
  --pattern <regex>         Regex to extract IDs from test titles. The first
                            capture group is the ID. Default: \\[(TC-\\d+)\\]
  --strict                  Exit non-zero if any IDs are missing from catalog
  --json                    Emit JSON instead of human-readable output
  --help, -h                Print this help

Auth: BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY env vars.

Exit codes:
  0  ok (or warnings without --strict)
  1  missing IDs found and --strict set
  2  bad arguments / missing env / fatal error`;

export function parseArgs(argv: string[]): ParseResult | ParseError {
  let projectId: string | undefined;
  const specs: string[] = [];
  let patternSrc: string | undefined;
  let strict = false;
  let json = false;

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
        case '--specs':
        case '-s':
          specs.push(next());
          break;
        case '--pattern':
          patternSrc = next();
          break;
        case '--strict':
          strict = true;
          break;
        case '--json':
          json = true;
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
    return {
      ok: false,
      message: `--project must look like PR-1234 (got ${JSON.stringify(projectId)})`,
    };
  }
  if (specs.length === 0) {
    return { ok: false, message: `--specs is required (pass at least one glob)\n\n${HELP}` };
  }

  let pattern: RegExp;
  try {
    pattern = patternSrc ? new RegExp(patternSrc) : /\[(TC-\d+)\]/;
  } catch (err) {
    return { ok: false, message: `Invalid --pattern regex: ${(err as Error).message}` };
  }

  return { ok: true, options: { projectId, specs, pattern, strict, json } };
}

export interface PreflightResult {
  /** TC IDs the regex extracted from spec files. */
  expected: string[];
  /** IDs that exist in the project catalog. */
  found: string[];
  /** IDs in specs but missing from the catalog. */
  missing: string[];
  /** Total count of cases in the project catalog. */
  catalogSize: number;
}

export async function preflight(
  opts: PreflightOptions,
  deps: { username: string; accessKey: string; cwd?: string },
): Promise<PreflightResult> {
  const cwd = deps.cwd ?? process.cwd();
  const expected = await extractTcIdsFromSpecs(opts.specs, opts.pattern, cwd);
  const tm = new TestManagementClient({
    username: deps.username,
    accessKey: deps.accessKey,
    projectId: opts.projectId,
  });
  const catalog = await tm.listAllCaseIdentifiers();
  const found = [...expected].filter((id) => catalog.has(id));
  const missing = [...expected].filter((id) => !catalog.has(id));
  const sortByTcNum = (a: string, b: string): number => {
    const ai = parseInt(a.replace(/^[^\d]*/, ''), 10) || 0;
    const bi = parseInt(b.replace(/^[^\d]*/, ''), 10) || 0;
    return ai - bi || a.localeCompare(b);
  };
  return {
    expected: [...expected].sort(sortByTcNum),
    found: found.sort(sortByTcNum),
    missing: missing.sort(sortByTcNum),
    catalogSize: catalog.size,
  };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
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

  let result: PreflightResult;
  try {
    result = await preflight(parsed.options, { username, accessKey });
  } catch (err) {
    console.error('preflight failed:', (err as Error).message);
    return 2;
  }

  if (parsed.options.json) {
    console.log(
      JSON.stringify(
        {
          ...result,
          counts: {
            totalInSpecs: result.expected.length,
            availableOnBs: result.found.length,
            missing: result.missing.length,
            catalogSize: result.catalogSize,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Project ${parsed.options.projectId} — preflight check`);
    console.log(`Pattern: ${parsed.options.pattern.source}`);
    console.log('');
    console.log(
      renderTable(
        ['Metric', 'Count'],
        [
          ['Total in specs', String(result.expected.length)],
          ['Available on BS', String(result.found.length)],
          ['Missing on BS', String(result.missing.length)],
          ['Catalog size (project)', String(result.catalogSize)],
        ],
        ['left', 'right'],
      ),
    );
    console.log('');
    if (result.expected.length === 0) {
      console.log('(no IDs extracted — check --pattern and --specs)');
    } else if (result.missing.length === 0) {
      console.log(`✓ all ${result.expected.length} spec ID(s) exist in the catalog`);
    } else {
      console.log(
        `✗ ${result.missing.length} of ${result.expected.length} ID(s) missing from project ${parsed.options.projectId}:`,
      );
      console.log('');
      console.log(renderIdList(result.missing));
      console.log('');
      console.log(`Results posted for these will be silently dropped by the TM API.`);
      console.log(`Pre-create them via the dashboard or CSV import before the next run.`);
    }
  }

  if (parsed.options.strict && result.missing.length > 0) return 1;
  return 0;
}

type Align = 'left' | 'right';

/**
 * Render a Unicode box-drawing table. Width per column = max(header, max
 * cell) + 2 padding. ASCII fallback isn't worth it — every modern terminal
 * renders these glyphs, and the JSON mode covers any pipe-into-script use.
 */
export function renderTable(
  header: string[],
  rows: string[][],
  align: Align[] = [],
): string {
  const cols = header.length;
  const widths = new Array<number>(cols);
  for (let i = 0; i < cols; i++) {
    widths[i] = (header[i] ?? '').length;
    for (const r of rows) widths[i] = Math.max(widths[i]!, (r[i] ?? '').length);
  }
  const pad = (s: string, w: number, a: Align): string =>
    a === 'right' ? s.padStart(w) : s.padEnd(w);
  const horiz = (l: string, m: string, r: string): string =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const cells = (vals: string[]): string =>
    '│ ' +
    vals
      .map((v, i) => pad(v, widths[i]!, align[i] ?? 'left'))
      .join(' │ ') +
    ' │';
  const out: string[] = [];
  out.push(horiz('┌', '┬', '┐'));
  out.push(cells(header));
  out.push(horiz('├', '┼', '┤'));
  for (const r of rows) out.push(cells(r));
  out.push(horiz('└', '┴', '┘'));
  return out.join('\n');
}

/**
 * Render a list of TC IDs as a single right-padded box, wrapped to the
 * terminal width so long lists don't fall off the right edge.
 */
export function renderIdList(ids: string[], termWidth: number = process.stdout.columns || 80): string {
  if (ids.length === 0) return '';
  const cellW = Math.max(...ids.map((s) => s.length));
  const usable = Math.max(20, termWidth - 4);
  const perLine = Math.max(1, Math.floor((usable + 2) / (cellW + 2)));
  const lines: string[] = [];
  for (let i = 0; i < ids.length; i += perLine) {
    const chunk = ids.slice(i, i + perLine);
    lines.push('  ' + chunk.map((s) => s.padEnd(cellW)).join('  '));
  }
  return lines.join('\n');
}
