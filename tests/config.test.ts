import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, resolveApiMode, resolveAuth, resolveBatchId } from '../src/config.js';
import { ENV } from '../src/env.js';

describe('config', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env[ENV.USERNAME];
    delete process.env[ENV.ACCESS_KEY];
    delete process.env[ENV.BATCH_ID];
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_RUN_ID;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('resolveAuth prefers options over env', () => {
    process.env[ENV.USERNAME] = 'env-u';
    process.env[ENV.ACCESS_KEY] = 'env-k';
    expect(resolveAuth({ username: 'opt-u', accessKey: 'opt-k' })).toEqual({
      username: 'opt-u',
      accessKey: 'opt-k',
    });
  });

  it('resolveAuth falls back to env', () => {
    process.env[ENV.USERNAME] = 'u';
    process.env[ENV.ACCESS_KEY] = 'k';
    expect(resolveAuth({})).toEqual({ username: 'u', accessKey: 'k' });
  });

  it('resolveAuth throws ConfigError when missing', () => {
    expect(() => resolveAuth({})).toThrow(ConfigError);
  });

  it('resolveApiMode defaults to collector', () => {
    expect(resolveApiMode({})).toBe('collector');
    expect(resolveApiMode({ apiMode: 'rest' })).toBe('rest');
  });

  it('resolveBatchId picks option > env > ci > generated', () => {
    expect(resolveBatchId({ batchId: 'opt' })).toEqual({ batchId: 'opt', source: 'option' });

    process.env[ENV.BATCH_ID] = 'env-batch';
    expect(resolveBatchId({})).toEqual({ batchId: 'env-batch', source: 'env' });

    delete process.env[ENV.BATCH_ID];
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_RUN_ID = 'gh-1';
    expect(resolveBatchId({})).toEqual({ batchId: 'gh-1', source: 'ci:github-actions' });

    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_RUN_ID;
    const r = resolveBatchId({});
    expect(r.source).toBe('generated');
    expect(r.batchId).toMatch(/^wdio-/);
  });
});
