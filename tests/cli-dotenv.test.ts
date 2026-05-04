import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile, parseEnv } from '../src/cli/dotenv.js';

describe('cli/dotenv parseEnv', () => {
  it('parses KEY=value', () => {
    expect(parseEnv('A=1\nB=2')).toEqual({ A: '1', B: '2' });
  });

  it('strips quotes', () => {
    expect(parseEnv(`A="quoted"\nB='single'`)).toEqual({ A: 'quoted', B: 'single' });
  });

  it('handles export prefix', () => {
    expect(parseEnv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('skips comments and blanks', () => {
    expect(parseEnv('# comment\n\nA=1\n# more')).toEqual({ A: '1' });
  });

  it('strips trailing comments on unquoted values', () => {
    expect(parseEnv('A=hello # not part of value')).toEqual({ A: 'hello' });
  });

  it('keeps `#` inside quoted values', () => {
    expect(parseEnv('A="hash#inside"')).toEqual({ A: 'hash#inside' });
  });

  it('rejects invalid keys', () => {
    expect(parseEnv('1BAD=x\n!=y\nGOOD=z')).toEqual({ GOOD: 'z' });
  });

  it('handles equals signs inside values', () => {
    expect(parseEnv('TOKEN=abc=def==')).toEqual({ TOKEN: 'abc=def==' });
  });
});

describe('cli/dotenv loadEnvFile', () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bstack-dotenv-'));
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when no .env exists', () => {
    expect(loadEnvFile(dir)).toBe(false);
  });

  it('loads .env into process.env', () => {
    delete process.env.PREFLIGHT_TEST_KEY;
    writeFileSync(join(dir, '.env'), 'PREFLIGHT_TEST_KEY=hello\n', 'utf8');
    expect(loadEnvFile(dir)).toBe(true);
    expect(process.env.PREFLIGHT_TEST_KEY).toBe('hello');
  });

  it('does not overwrite already-set vars (shell wins)', () => {
    process.env.PREFLIGHT_TEST_KEY = 'from-shell';
    writeFileSync(join(dir, '.env'), 'PREFLIGHT_TEST_KEY=from-file\n', 'utf8');
    expect(loadEnvFile(dir)).toBe(true);
    expect(process.env.PREFLIGHT_TEST_KEY).toBe('from-shell');
  });
});
