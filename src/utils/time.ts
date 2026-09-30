// Time helpers shared by every tool. Callers (usually AI skills) pass times in
// whatever shape is handiest: ISO with or without an offset, epoch millis, or a
// relative expression like `-90m` / `-60d`. These resolve all of them to epoch
// millis so windows, baselines and UI links can be computed exactly.

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const DURATION_RE = /^(\d+[smhdw])+$/i;
const RELATIVE_RE = /^-?(\d+[smhdw])+$/i;
const EPOCH_RE = /^\d{10}$|^\d{13}$/;
// ISO 8601 carrying an explicit zone: trailing Z or ±HH:MM / ±HHMM.
const ISO_WITH_OFFSET_RE = /T.*(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;

// Parse a duration like `15m`, `24h`, `2w5d` into milliseconds.
export function parseDuration(input: string): number {
  const value = input.trim().replace(/^-/, '');
  if (!DURATION_RE.test(value)) {
    throw new Error(
      `Invalid duration "${input}". Use <number><unit> pairs with units ` +
        's, m, h, d, w (e.g. "15m", "24h", "7d", "2w5d").',
    );
  }
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+)([smhdw])/gi)) {
    total += Number(amount) * UNIT_MS[unit.toLowerCase()];
  }
  return total;
}

// Offset (ms) of `timeZone` from UTC at instant `epochMs`.
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - (epochMs - (epochMs % 1000));
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(
      `Invalid timeZone "${timeZone}". Use an IANA name such as "UTC" or "America/New_York".`,
    );
  }
}

// Interpret a wall-clock ISO string (no offset) in `timeZone`.
function localIsoToEpoch(input: string, timeZone: string): number | undefined {
  const m = ISO_LOCAL_RE.exec(input.trim());
  if (!m) {
    return undefined;
  }
  const [, y, mo, d, h = '0', mi = '0', s = '0', ms = '0'] = m;
  const wall = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms.padEnd(3, '0')),
  );
  // Two passes settle the offset across DST transitions.
  let epoch = wall - zoneOffsetMs(wall, timeZone);
  epoch = wall - zoneOffsetMs(epoch, timeZone);
  return epoch;
}

export type TimeInputKind = 'epoch' | 'relative' | 'iso-offset' | 'iso-local';

export interface ResolvedTime {
  epochMs: number;
  kind: TimeInputKind;
}

// Resolve any accepted time input to epoch millis.
export function resolveTime(
  input: string | number,
  timeZone = 'UTC',
  now = Date.now(),
): ResolvedTime {
  if (typeof input === 'number') {
    return { epochMs: input < 1e12 ? input * 1000 : input, kind: 'epoch' };
  }
  const value = input.trim();
  if (value.toLowerCase() === 'now') {
    return { epochMs: now, kind: 'relative' };
  }
  if (EPOCH_RE.test(value)) {
    const n = Number(value);
    return { epochMs: value.length === 10 ? n * 1000 : n, kind: 'epoch' };
  }
  if (RELATIVE_RE.test(value)) {
    return { epochMs: now - parseDuration(value), kind: 'relative' };
  }
  if (ISO_WITH_OFFSET_RE.test(value)) {
    const epochMs = Date.parse(value);
    if (!Number.isNaN(epochMs)) {
      return { epochMs, kind: 'iso-offset' };
    }
  }
  const local = localIsoToEpoch(value, timeZone);
  if (local !== undefined && !Number.isNaN(local)) {
    return { epochMs: local, kind: 'iso-local' };
  }
  throw new Error(
    `Unrecognised time "${input}". Use ISO 8601 (e.g. "2026-09-29T17:00:00", ` +
      'optionally with Z or an offset), epoch millis, "now", or a relative ' +
      'time such as "-15m", "-24h", "-60d".',
  );
}

export interface ResolvedWindow {
  fromMs: number;
  toMs: number;
}

export interface WindowInput {
  from?: string;
  to?: string;
  // Center the window on this instant instead of using from/to.
  around?: string;
  aroundMinutes?: number;
  timeZone?: string;
  // Used when neither from nor around is given.
  defaultLookbackMs?: number;
}

export function resolveWindow(
  input: WindowInput,
  now = Date.now(),
): ResolvedWindow {
  const tz = input.timeZone || 'UTC';
  assertTimeZone(tz);
  let fromMs: number;
  let toMs: number;
  if (input.around) {
    const center = resolveTime(input.around, tz, now).epochMs;
    const half = (input.aroundMinutes ?? 5) * UNIT_MS.m;
    fromMs = center - half;
    toMs = center + half;
  } else {
    toMs = input.to ? resolveTime(input.to, tz, now).epochMs : now;
    fromMs = input.from
      ? resolveTime(input.from, tz, now).epochMs
      : toMs - (input.defaultLookbackMs ?? UNIT_MS.d);
  }
  if (fromMs >= toMs) {
    throw new Error(
      `Invalid time range: from (${new Date(fromMs).toISOString()}) must be ` +
        `before to (${new Date(toMs).toISOString()}).`,
    );
  }
  return { fromMs, toMs };
}

export const toIso = (epochMs: number): string =>
  new Date(epochMs).toISOString();

// Human-friendly byte count for scan estimates.
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  for (const unit of ['w', 'd', 'h', 'm', 's']) {
    if (ms % UNIT_MS[unit] === 0) {
      return `${ms / UNIT_MS[unit]}${unit}`;
    }
  }
  return `${ms}ms`;
}
