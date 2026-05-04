import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandSpecs, extractTcIdsFromSpecs } from '../src/spec-discovery.js';
import { clearSpecCache } from '../src/spec-parser.js';

describe('expandSpecs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bstack-discover-'));
    mkdirSync(join(dir, 'tests/specs/sub'), { recursive: true });
    writeFileSync(join(dir, 'tests/specs/a.spec.ts'), '', 'utf8');
    writeFileSync(join(dir, 'tests/specs/b.spec.ts'), '', 'utf8');
    writeFileSync(join(dir, 'tests/specs/sub/c.spec.ts'), '', 'utf8');
    clearSpecCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('expands a single glob pattern', async () => {
    const out = await expandSpecs(['./tests/specs/*.spec.ts'], dir);
    expect(out.sort()).toEqual([
      join(dir, 'tests/specs/a.spec.ts'),
      join(dir, 'tests/specs/b.spec.ts'),
    ]);
  });

  it('expands recursive glob', async () => {
    const out = await expandSpecs(['./tests/specs/**/*.spec.ts'], dir);
    expect(out.sort()).toEqual([
      join(dir, 'tests/specs/a.spec.ts'),
      join(dir, 'tests/specs/b.spec.ts'),
      join(dir, 'tests/specs/sub/c.spec.ts'),
    ]);
  });

  it('preserves literal file paths', async () => {
    const out = await expandSpecs(['./tests/specs/a.spec.ts'], dir);
    expect(out).toEqual([join(dir, 'tests/specs/a.spec.ts')]);
  });

  it('flattens grouped (nested) arrays', async () => {
    const out = await expandSpecs(
      [['./tests/specs/a.spec.ts', './tests/specs/b.spec.ts']],
      dir,
    );
    expect(out.sort()).toEqual([
      join(dir, 'tests/specs/a.spec.ts'),
      join(dir, 'tests/specs/b.spec.ts'),
    ]);
  });
});

describe('extractTcIdsFromSpecs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bstack-extract-'));
    mkdirSync(join(dir, 'tests/specs'), { recursive: true });
    writeFileSync(
      join(dir, 'tests/specs/login.spec.ts'),
      `describe('login', () => {
        it('[TC-1] valid', () => {});
        it('[TC-2] invalid', () => {});
      });`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'tests/specs/account.spec.ts'),
      `describe('account', () => {
        it('[TC-99] settings', () => {});
        it('no tag', () => {});
      });`,
      'utf8',
    );
    clearSpecCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the union of TC IDs across all matched specs', async () => {
    const ids = await extractTcIdsFromSpecs(
      ['./tests/specs/*.spec.ts'],
      /\[(TC-\d+)\]/,
      dir,
    );
    expect([...ids].sort()).toEqual(['TC-1', 'TC-2', 'TC-99']);
  });

  it('skips titles with no tag match', async () => {
    const ids = await extractTcIdsFromSpecs(
      ['./tests/specs/account.spec.ts'],
      /\[(TC-\d+)\]/,
      dir,
    );
    expect([...ids]).toEqual(['TC-99']); // 'no tag' excluded
  });

  it('returns empty for unmatched patterns', async () => {
    const ids = await extractTcIdsFromSpecs(
      ['./tests/specs/missing/*.spec.ts'],
      /\[(TC-\d+)\]/,
      dir,
    );
    expect(ids.size).toBe(0);
  });
});
