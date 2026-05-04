import { readFileSync } from 'node:fs';

export interface DiscoveredTest {
  title: string;
  /** Title of the closest enclosing describe block (best-effort). */
  suite: string;
}

/**
 * Static analysis of a Mocha-style spec file: returns `it()` titles paired
 * with the most-recently-seen `describe()` title. Best-effort and only
 * handles literal string / template-without-expression titles. Dynamic
 * titles (`it(\`TC-${i}\`, ...)`, `forEach`-generated tests, helper
 * functions that wrap `it`) cannot be discovered this way.
 *
 * Caveat: this assumes each `it()` belongs to the most-recently-opened
 * `describe()`. For nested describes where an outer describe also has
 * direct `it()` children placed AFTER an inner describe block, the
 * association may be wrong. Single-describe specs work perfectly.
 */
export function parseSpec(content: string): DiscoveredTest[] {
  // Strip block + line comments so commented-out it() calls don't pollute.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const tokens =
    /\b(describe(?:\.(?:only|skip))?|context(?:\.(?:only|skip))?|xdescribe|xcontext|it(?:\.(?:only|skip))?|specify(?:\.(?:only|skip))?|xit)\s*\(\s*(?:(['"])((?:\\.|[^\\])*?)\2|`((?:\\.|[^\\`])*?)`)/g;

  const out: DiscoveredTest[] = [];
  let currentSuite = '';
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(stripped))) {
    const kw = m[1] ?? '';
    const title = m[3] ?? m[4] ?? '';
    if (!title) continue;
    if (
      kw.startsWith('describe') ||
      kw.startsWith('context') ||
      kw.startsWith('xdescribe') ||
      kw.startsWith('xcontext')
    ) {
      currentSuite = title;
    } else {
      out.push({ title, suite: currentSuite });
    }
  }
  return out;
}

const cache = new Map<string, DiscoveredTest[]>();

export function discoverSpecTests(specFile: string): DiscoveredTest[] {
  const cached = cache.get(specFile);
  if (cached) return cached;
  try {
    const content = readFileSync(specFile, 'utf8');
    const tests = parseSpec(content);
    cache.set(specFile, tests);
    return tests;
  } catch {
    cache.set(specFile, []);
    return [];
  }
}

export function clearSpecCache(): void {
  cache.clear();
}
