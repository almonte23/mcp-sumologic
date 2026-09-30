import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, resolveTime, resolveWindow } from '@/utils/time.js';

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0); // 2026-09-29T12:00:00Z

test('parses durations', () => {
  assert.equal(parseDuration('15m'), 15 * 60e3);
  assert.equal(parseDuration('-2h'), 2 * 3600e3);
  assert.equal(parseDuration('1w2d'), 9 * 86400e3);
  assert.throws(() => parseDuration('soon'));
});

test('resolves relative, epoch, offset and wall-clock inputs', () => {
  assert.deepEqual(resolveTime('-90m', 'UTC', NOW), {
    epochMs: NOW - 90 * 60e3,
    kind: 'relative',
  });
  assert.equal(resolveTime('60d', 'UTC', NOW).epochMs, NOW - 60 * 86400e3);
  assert.equal(resolveTime('now', 'UTC', NOW).epochMs, NOW);
  assert.deepEqual(resolveTime('1790000000000'), {
    epochMs: 1790000000000,
    kind: 'epoch',
  });
  assert.equal(resolveTime('1790000000').epochMs, 1790000000000);
  assert.deepEqual(resolveTime('2026-09-29T17:00:00Z'), {
    epochMs: Date.UTC(2026, 8, 29, 17),
    kind: 'iso-offset',
  });
  assert.equal(
    resolveTime('2026-09-29T17:00:00-04:00').epochMs,
    Date.UTC(2026, 8, 29, 21),
  );
});

test('interprets wall-clock ISO in the given zone, across DST', () => {
  // September: New York is UTC-4.
  const edt = resolveTime('2026-09-29T17:00:00', 'America/New_York');
  assert.equal(edt.kind, 'iso-local');
  assert.equal(edt.epochMs, Date.UTC(2026, 8, 29, 21));
  // January: New York is UTC-5.
  assert.equal(
    resolveTime('2026-01-15T17:00', 'America/New_York').epochMs,
    Date.UTC(2026, 0, 15, 22),
  );
  assert.equal(resolveTime('2026-09-29', 'UTC').epochMs, Date.UTC(2026, 8, 29));
});

test('rejects garbage times and inverted windows', () => {
  assert.throws(() => resolveTime('yesterday-ish'), /Unrecognised time/);
  assert.throws(
    () => resolveWindow({ from: '-1h', to: '-2h' }, NOW),
    /must be before/,
  );
  assert.throws(
    () => resolveWindow({ timeZone: 'Mars/Olympus' }, NOW),
    /Invalid timeZone/,
  );
});

test('around centers the window', () => {
  const w = resolveWindow(
    { around: '2026-09-29T12:00:00Z', aroundMinutes: 10 },
    NOW,
  );
  assert.equal(w.fromMs, NOW - 10 * 60e3);
  assert.equal(w.toMs, NOW + 10 * 60e3);
  const d = resolveWindow({}, NOW);
  assert.equal(d.toMs - d.fromMs, 86400e3);
});
