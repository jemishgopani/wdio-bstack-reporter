import { describe, expect, it } from 'vitest';
import { describeCap, sanitizeCapabilities } from '../src/capabilities.js';

describe('sanitizeCapabilities', () => {
  it('handles a single plain capabilities object', () => {
    expect(
      sanitizeCapabilities({ browserName: 'chrome', browserVersion: '120', platformName: 'mac' }),
    ).toEqual([{ browser: 'chrome', browserVersion: '120', platform: 'mac' }]);
  });

  it('unwraps W3C alwaysMatch envelopes', () => {
    expect(
      sanitizeCapabilities({
        alwaysMatch: { browserName: 'firefox', browserVersion: '124' },
      }),
    ).toEqual([{ browser: 'firefox', browserVersion: '124' }]);
  });

  it('flattens an array of capabilities', () => {
    expect(
      sanitizeCapabilities([
        { browserName: 'chrome' },
        { browserName: 'firefox' },
      ]),
    ).toEqual([{ browser: 'chrome' }, { browser: 'firefox' }]);
  });

  it('detects multi-remote and tags each slot', () => {
    expect(
      sanitizeCapabilities({
        admin: { capabilities: { browserName: 'chrome' } },
        user: { capabilities: { browserName: 'firefox' } },
      }),
    ).toEqual([
      { browser: 'chrome', remote: 'admin' },
      { browser: 'firefox', remote: 'user' },
    ]);
  });

  it('returns empty array for nullish input', () => {
    expect(sanitizeCapabilities(undefined)).toEqual([]);
    expect(sanitizeCapabilities(null)).toEqual([]);
  });

  it('describeCap renders a useful one-liner', () => {
    expect(describeCap({ browser: 'chrome', browserVersion: '120', platform: 'mac' })).toBe(
      'chrome 120 on mac',
    );
  });
});
