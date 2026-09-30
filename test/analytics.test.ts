import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseBucket,
  compareWindows,
  discoverValues,
  timeline,
} from '@/domains/sumologic/analytics.js';
import { estimateScan } from '@/domains/sumologic/catalog.js';
import { RateLimiter } from '@/lib/sumologic/limiter.js';
import { done, fakeClient, jobRoutes } from './fakeSumo.js';

const H = 3600e3;
const T0 = Date.UTC(2026, 8, 29, 10);
const slice = (t: number, n: number, extra: Record<string, string> = {}) => ({
  map: { _timeslice: String(t), _count: String(n), ...extra },
});

test('chooses buckets and rejects oversized grids', () => {
  assert.equal(chooseBucket(H).label, '1m');
  assert.equal(chooseBucket(3 * H).label, '1m');
  assert.equal(chooseBucket(24 * H).label, '15m');
  assert.equal(chooseBucket(60 * 24 * H).label, '12h');
  assert.equal(chooseBucket(H, '5m').label, '5m');
  assert.equal(chooseBucket(14 * 24 * H, '7d').label, '7d');
  assert.throws(() => chooseBucket(60 * 24 * H, '1m'), /max 5000/);
});

test('timeline zero-fills and summarizes', async () => {
  let jobBody: any;
  const { client } = fakeClient(
    jobRoutes({
      status: done({ recordCount: 2 }),
      records: [slice(T0 + 15 * 60e3, 4), slice(T0 + 30 * 60e3, 9)],
      onJob: (b) => (jobBody = b),
    }),
  );
  const res = await timeline(client, {
    query: '_index=Production "lock timeout"',
    from: '2026-09-29T10:00:00Z',
    to: '2026-09-29T11:00:00Z',
    bucket: '15m',
  });
  assert.equal(
    jobBody.query,
    '_index=Production "lock timeout" | timeslice 15m | count by _timeslice',
  );
  assert.equal(res.bucketCount, 4);
  assert.deepEqual(res.buckets, [
    ['2026-09-29T10:00:00.000Z', 0],
    ['2026-09-29T10:15:00.000Z', 4],
    ['2026-09-29T10:30:00.000Z', 9],
    ['2026-09-29T10:45:00.000Z', 0],
  ]);
  assert.equal(res.total, 13);
  assert.equal(res.firstSeen, '2026-09-29T10:15:00.000Z');
  assert.equal(res.lastSeen, '2026-09-29T10:30:00.000Z');
  assert.deepEqual(res.peak, { at: '2026-09-29T10:30:00.000Z', count: 9 });
});

test('timeline groups and folds the long tail', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({ recordCount: 3 }),
      records: [
        slice(T0, 10, { _sourcecategory: 'a' }),
        slice(T0, 5, { _sourcecategory: 'b' }),
        slice(T0, 1, { _sourcecategory: 'c' }),
      ],
    }),
  );
  const res = await timeline(client, {
    query: 'x',
    from: String(T0),
    to: String(T0 + H),
    groupBy: '_sourceCategory',
    topGroups: 2,
    includeBuckets: false,
  });
  assert.deepEqual(
    res.series!.map((s) => [s.group, s.total]),
    [
      ['a', 10],
      ['b', 5],
      ['(other: 1 groups)', 1],
    ],
  );
  assert.equal(res.total, 16);
});

test('timeline refuses aggregate input and unsafe field names', async () => {
  const { client } = fakeClient([]);
  await assert.rejects(
    timeline(client, { query: 'x | count' }),
    /non-aggregate/,
  );
  await assert.rejects(
    timeline(client, { query: 'x', groupBy: 'a | delete' }),
    /Invalid groupBy/,
  );
});

test('compare_windows applies spike / drop / zero-baseline rules', async () => {
  const run = (current: number, baseline: number) => {
    const { client } = fakeClient(
      jobRoutes({
        status: done({ recordCount: 1 }),
        // Baseline windows start before T0; the current window starts at T0.
        records: (job) => [
          slice(job.from, job.from >= T0 ? current : baseline),
        ],
      }),
    );
    return compareWindows(client, {
      query: 'x',
      from: String(T0),
      to: String(T0 + H),
    });
  };
  const spike = await run(60, 10);
  assert.equal(spike.verdict, 'spike');
  assert.equal(spike.comparisons[0].ratio, 6);
  assert.equal((await run(11, 0)).verdict, 'spike');
  assert.equal((await run(8, 0)).verdict, 'normal');
  assert.equal((await run(1, 100)).verdict, 'drop');
  assert.equal((await run(12, 10)).verdict, 'normal');
});

test('discover_sources builds a count-by query', async () => {
  let jobBody: any;
  const { client } = fakeClient(
    jobRoutes({
      status: done({ recordCount: 2 }),
      records: [
        { map: { _sourcecategory: 'prod/portal/web', _count: '900' } },
        { map: { _sourcecategory: 'prod/portal/worker', _count: '40' } },
      ],
      onJob: (b) => (jobBody = b),
    }),
  );
  const res = await discoverValues(client, {
    scope: '_index=Production',
    from: '-1h',
  });
  assert.equal(
    jobBody.query,
    '_index=Production | count by _sourceCategory | sort by _count | limit 100',
  );
  assert.deepEqual(res.values[0], { value: 'prod/portal/web', count: 900 });
});

test('estimate_scan posts a bounded epoch time range', async () => {
  let body: any;
  const { client } = fakeClient([
    [
      /^\/logSearches\/estimatedUsageByMeteringType$/,
      'post',
      (c) => {
        body = c.body;
        return {
          estimatedUsageDetails: [
            {
              tier: 'Continuous',
              meteringType: 'Continuous',
              dataScannedInBytes: 2 * 1024 ** 3,
              scanCreditAccounted: false,
            },
            {
              tier: 'Infrequent',
              meteringType: 'Infrequent',
              dataScannedInBytes: 512 * 1024 ** 2,
              scanCreditAccounted: true,
            },
          ],
        };
      },
    ],
  ]);
  const res = await estimateScan(client, {
    query: 'x',
    from: String(T0),
    to: String(T0 + H),
  });
  assert.deepEqual(body.timeRange.from, {
    type: 'EpochTimeRangeBoundary',
    epochMillis: T0,
  });
  assert.equal(body.timezone, 'UTC');
  assert.equal(res.totalScan, '2.5 GB');
  assert.equal(res.chargedPerScan, '512 MB');
});

test('rate limiter spaces calls and caps concurrency', async () => {
  const limiter = new RateLimiter({ maxPerSecond: 20, maxInFlight: 2 });
  const starts: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limiter.run(async () => {
        starts.push(Date.now() - t0);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
      }),
    ),
  );
  assert.ok(peak <= 2, `peak in flight ${peak}`);
  // 6 calls at 20/s need at least ~250ms between first and last start.
  assert.ok(starts[5] >= 240, `last start at ${starts[5]}ms`);
});
