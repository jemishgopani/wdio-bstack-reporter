/**
 * Loose shape that covers W3C capabilities, plain caps, and the W3C
 * `alwaysMatch` envelope. We only read what we need, defensively.
 */
export interface RawCaps {
  browserName?: string;
  browserVersion?: string;
  version?: string;
  platformName?: string;
  platform?: string;
  deviceName?: string;
  alwaysMatch?: RawCaps;
  capabilities?: { alwaysMatch?: RawCaps };
  [key: string]: unknown;
}

export interface SanitizedCap {
  browser?: string;
  browserVersion?: string;
  platform?: string;
  device?: string;
  /** Multi-remote slot name, if present (e.g. 'browserA'). */
  remote?: string;
}

function unwrap(c: RawCaps | undefined): RawCaps {
  if (!c) return {};
  if (c.alwaysMatch) return c.alwaysMatch;
  if (c.capabilities?.alwaysMatch) return c.capabilities.alwaysMatch;
  // Multi-remote slots have the form `{ capabilities: { browserName: ... } }`.
  if (c.capabilities && typeof c.capabilities === 'object') {
    return c.capabilities as unknown as RawCaps;
  }
  return c;
}

function sanitizeOne(raw: RawCaps): SanitizedCap {
  const c = unwrap(raw);
  const out: SanitizedCap = {};
  const browser = c.browserName;
  if (typeof browser === 'string') out.browser = browser;
  const bv = c.browserVersion ?? c.version;
  if (typeof bv === 'string') out.browserVersion = bv;
  const plat = c.platformName ?? c.platform;
  if (typeof plat === 'string') out.platform = plat;
  if (typeof c.deviceName === 'string') out.device = c.deviceName;
  return out;
}

/**
 * Normalize launcher-provided capabilities into a flat list. Handles:
 *   - single capabilities object
 *   - array (parallel) of capabilities
 *   - multi-remote (object map of name → caps)
 */
export function sanitizeCapabilities(input: unknown): SanitizedCap[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap((c) => sanitizeCapabilities(c));
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    // Multi-remote: keys are arbitrary names whose values are capability objects.
    // Heuristic: if values are objects without browserName at top-level OR
    // they nest under `capabilities`, treat as multi-remote.
    const looksMultiRemote =
      !('browserName' in obj) &&
      !('alwaysMatch' in obj) &&
      Object.values(obj).some(
        (v) => typeof v === 'object' && v !== null && ('browserName' in v || 'capabilities' in v),
      );
    if (looksMultiRemote) {
      return Object.entries(obj).map(([name, caps]) => ({
        ...sanitizeOne(caps as RawCaps),
        remote: name,
      }));
    }
    return [sanitizeOne(obj as RawCaps)];
  }
  return [];
}

export function describeCap(c: SanitizedCap): string {
  const parts: string[] = [];
  if (c.browser) parts.push(c.browser);
  if (c.browserVersion) parts.push(c.browserVersion);
  if (c.platform) parts.push(`on ${c.platform}`);
  if (c.device) parts.push(`(${c.device})`);
  if (c.remote) parts.push(`[${c.remote}]`);
  return parts.join(' ') || 'unknown';
}
