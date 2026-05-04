import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal dotenv loader for the CLI. If `<cwd>/.env` exists, parse it and
 * merge into `process.env` (without overriding values already set by the
 * shell — the shell wins, same as `dotenv` library default).
 *
 * Returns `true` if a file was found and loaded so the caller can log it.
 *
 * Intentionally tiny — we don't take a runtime dep on `dotenv` for a CLI
 * niceness. Supports `KEY=value`, quoted values (`KEY="v"` / `KEY='v'`),
 * `export KEY=value`, comments (`# ...`), and blank lines. Doesn't expand
 * `${VAR}` references.
 */
export function loadEnvFile(cwd: string = process.cwd()): boolean {
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const parsed = parseEnv(raw);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

export function parseEnv(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const lineRaw of input.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    // Strip a trailing inline comment when the value isn't quoted.
    if (!/^["']/.test(value)) {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
