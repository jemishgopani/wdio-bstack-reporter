import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import { discoverSpecTests } from './spec-parser.js';

function normalizePath(p: string): string {
  return p.startsWith('file://') ? fileURLToPath(p) : p;
}

/**
 * Expand WDIO's `config.specs` (an array of glob patterns or grouped
 * arrays) into a flat list of absolute file paths.
 */
export async function expandSpecs(
  specs: ReadonlyArray<string | string[]> | undefined,
  cwd: string = process.cwd(),
): Promise<string[]> {
  if (!specs || specs.length === 0) return [];
  const patterns: string[] = [];
  for (const entry of specs) {
    if (Array.isArray(entry)) {
      for (const e of entry) patterns.push(normalizePath(e));
    } else {
      patterns.push(normalizePath(entry));
    }
  }
  const found = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
      try {
        const matches = await glob(pattern, { cwd, absolute: true, posix: true });
        for (const file of matches) found.add(resolvePath(file));
      } catch {
        /* malformed pattern → skip */
      }
    } else {
      found.add(resolvePath(cwd, pattern));
    }
  }
  return [...found];
}

/**
 * Statically extract every TC ID (or whatever the regex captures) from
 * every `it()` title across the resolved spec files.
 */
export async function extractTcIdsFromSpecs(
  specs: ReadonlyArray<string | string[]> | undefined,
  pattern: RegExp,
  cwd: string = process.cwd(),
): Promise<Set<string>> {
  const files = await expandSpecs(specs, cwd);
  const ids = new Set<string>();
  for (const file of files) {
    const tests = discoverSpecTests(file);
    for (const t of tests) {
      const m = pattern.exec(t.title);
      if (m && m[1]) ids.add(m[1]);
    }
  }
  return ids;
}
