import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, preflight } from '../src/cli/preflight.js';
import { clearSpecCache } from '../src/spec-parser.js';

describe('cli/preflight parseArgs', () => {
  it('parses --project --specs + defaults', () => {
    const r = parseArgs(['--project', 'PR-1', '--specs', 'a.spec.ts']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.projectId).toBe('PR-1');
    expect(r.options.specs).toEqual(['a.spec.ts']);
    expect(r.options.pattern.source).toBe('\\[(TC-\\d+)\\]');
    expect(r.options.strict).toBe(false);
    expect(r.options.json).toBe(false);
  });

  it('accepts multiple --specs', () => {
    const r = parseArgs([
      '-p',
      'PR-1',
      '-s',
      'a.spec.ts',
      '-s',
      'b/**/*.spec.ts',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.specs).toEqual(['a.spec.ts', 'b/**/*.spec.ts']);
  });

  it('parses custom --pattern', () => {
    const r = parseArgs([
      '-p',
      'PR-1',
      '-s',
      'a.spec.ts',
      '--pattern',
      '@(TC-\\d+)',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.pattern.source).toBe('@(TC-\\d+)');
  });

  it('rejects bad --pattern', () => {
    const r = parseArgs(['-p', 'PR-1', '-s', 'a.ts', '--pattern', '(']);
    expect(r.ok).toBe(false);
  });

  it('rejects missing --specs', () => {
    const r = parseArgs(['-p', 'PR-1']);
    expect(r.ok).toBe(false);
  });

  it('rejects bad --project format', () => {
    const r = parseArgs(['-p', 'demo', '-s', 'a.ts']);
    expect(r.ok).toBe(false);
  });

  it('parses --strict and --json', () => {
    const r = parseArgs(['-p', 'PR-1', '-s', 'a.ts', '--strict', '--json']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.strict).toBe(true);
    expect(r.options.json).toBe(true);
  });
});

describe('cli/preflight preflight()', () => {
  const fetchMock = vi.fn();
  let tmpRoot: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    clearSpecCache();
    tmpRoot = mkdtempSync(join(tmpdir(), 'bstack-preflight-'));
    mkdirSync(join(tmpRoot, 'specs'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'specs', 'a.spec.ts'),
      `
        describe('s', () => {
          it('[TC-1] one', () => {});
          it('[TC-2] two', () => {});
          it('[TC-99] not in catalog', () => {});
        });
      `,
      'utf8',
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns expected/found/missing split based on catalog', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          test_cases: [{ identifier: 'TC-1' }, { identifier: 'TC-2' }, { identifier: 'TC-50' }],
          info: { next: null },
        }),
        { status: 200 },
      ),
    );
    const result = await preflight(
      {
        projectId: 'PR-1',
        specs: ['specs/**/*.spec.ts'],
        pattern: /\[(TC-\d+)\]/,
        strict: false,
        json: false,
      },
      { username: 'u', accessKey: 'k', cwd: tmpRoot },
    );
    expect(result.expected).toEqual(['TC-1', 'TC-2', 'TC-99']);
    expect(result.found).toEqual(['TC-1', 'TC-2']);
    expect(result.missing).toEqual(['TC-99']);
    expect(result.catalogSize).toBe(3);
  });

  it('main() exit code 0 when nothing is missing', async () => {
    process.env.BROWSERSTACK_USERNAME = 'u';
    process.env.BROWSERSTACK_ACCESS_KEY = 'k';
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          test_cases: [
            { identifier: 'TC-1' },
            { identifier: 'TC-2' },
            { identifier: 'TC-99' },
          ],
          info: { next: null },
        }),
        { status: 200 },
      ),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const code = await main([
        '-p',
        'PR-1',
        '-s',
        'specs/**/*.spec.ts',
        '--strict',
      ]);
      expect(code).toBe(0);
      expect(log.mock.calls.some((c) => String(c[0]).includes('all 3 spec ID'))).toBe(true);
      expect(
        log.mock.calls.some((c) => String(c[0]).includes('Available on BS')),
      ).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it('main() exit code 1 when --strict and IDs are missing', async () => {
    process.env.BROWSERSTACK_USERNAME = 'u';
    process.env.BROWSERSTACK_ACCESS_KEY = 'k';
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          test_cases: [{ identifier: 'TC-1' }],
          info: { next: null },
        }),
        { status: 200 },
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const code = await main([
        '-p',
        'PR-1',
        '-s',
        'specs/**/*.spec.ts',
        '--strict',
      ]);
      expect(code).toBe(1);
    } finally {
      process.chdir(cwd);
    }
  });

  it('main() exit code 0 when missing IDs but no --strict', async () => {
    process.env.BROWSERSTACK_USERNAME = 'u';
    process.env.BROWSERSTACK_ACCESS_KEY = 'k';
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ test_cases: [{ identifier: 'TC-1' }], info: { next: null } }),
        { status: 200 },
      ),
    );
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const code = await main(['-p', 'PR-1', '-s', 'specs/**/*.spec.ts']);
      expect(code).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it('main() exit code 2 when env vars missing', async () => {
    delete process.env.BROWSERSTACK_USERNAME;
    delete process.env.BROWSERSTACK_ACCESS_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await main(['-p', 'PR-1', '-s', 'a.ts']);
    expect(code).toBe(2);
  });
});
