import { describe, expect, it } from 'vitest';
import { parseSpec } from '../src/spec-parser.js';

describe('parseSpec', () => {
  it('parses one describe with multiple it blocks', () => {
    const out = parseSpec(`
      describe('group', () => {
        it('[TC-1] first', async () => {});
        it('[TC-2] second', async () => {});
        it('[TC-3] third', async () => {});
      });
    `);
    expect(out).toEqual([
      { title: '[TC-1] first', suite: 'group' },
      { title: '[TC-2] second', suite: 'group' },
      { title: '[TC-3] third', suite: 'group' },
    ]);
  });

  it('handles double-quoted, single-quoted, and template-literal titles', () => {
    const out = parseSpec(`
      describe("d", () => {
        it("a", () => {});
        it('b', () => {});
        it(\`c\`, () => {});
      });
    `);
    expect(out.map((t) => t.title)).toEqual(['a', 'b', 'c']);
  });

  it('handles describe.skip / it.only / xit / specify', () => {
    const out = parseSpec(`
      describe.skip('skipped group', () => {
        it('still listed', () => {});
      });
      describe('g', () => {
        it.only('focused', () => {});
        xit('disabled', () => {});
        specify('alias', () => {});
      });
    `);
    expect(out.map((t) => t.title)).toEqual([
      'still listed',
      'focused',
      'disabled',
      'alias',
    ]);
  });

  it('strips block + line comments so commented-out it() does not pollute', () => {
    const out = parseSpec(`
      describe('g', () => {
        // it('commented', () => {});
        /* it('also commented', () => {}); */
        it('real', () => {});
      });
    `);
    expect(out.map((t) => t.title)).toEqual(['real']);
  });

  it('returns empty for files with no it() calls', () => {
    expect(parseSpec(`describe('only', () => {});`)).toEqual([]);
    expect(parseSpec('')).toEqual([]);
  });

  it('escaped quotes in titles are handled', () => {
    const out = parseSpec(`describe('g', () => { it('it\\'s fine', () => {}); });`);
    expect(out[0]?.title).toBe("it\\'s fine");
  });
});
