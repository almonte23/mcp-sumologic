import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '@/domains/sumologic/client.js';
import {
  formatToolError,
  SumoSearchError,
} from '@/domains/sumologic/errors.js';
import { done, fakeClient, httpError, jobRoutes } from './fakeSumo.js';

const msg = (i: number, extra: Record<string, string> = {}) => ({
  map: {
    _messagetime: String(1000 + i),
    _sourcecategory: 'prod/api',
    _raw: `line ${i}`,
    ...extra,
  },
});

test('raw search keeps its original shape and adds meta', async () => {
  let jobBody: any;
  const { client, calls } = fakeClient(
    jobRoutes({
      status: done({ messageCount: 3, pendingWarnings: ['slow shard'] }),
      messages: [msg(1), msg(2), msg(3, { _raw: 'user bob@example.com' })],
      onJob: (b) => (jobBody = b),
    }),
  );
  const res = await search(client, '_index=Production error', {
    from: '2026-09-29T10:00:00',
    to: '2026-09-29T11:00:00',
  });

  assert.equal(res.type, 'messages');
  assert.equal(res.messages!.length, 3);
  assert.ok(
    !res.messages![2].map._raw.includes('bob@example.com'),
    'PII masked',
  );
  // Wall-clock strings pass through unchanged, as before.
  assert.equal(jobBody.from, '2026-09-29T10:00:00');
  assert.equal(jobBody.timeZone, 'UTC');
  assert.equal(res.meta.jobId, 'JOB1');
  assert.deepEqual(res.meta.totals, { messages: 3, records: 0 });
  assert.equal(res.meta.truncated, false);
  assert.equal(res.meta.completeness, 'partial', 'warnings make it partial');
  assert.deepEqual(res.meta.warnings, ['slow shard']);
  assert.equal(res.meta.window.from, '2026-09-29T10:00:00.000Z');
  assert.match(
    res.meta.links!.ui!,
    /^https:\/\/service\.sumologic\.com\/ui\/#\/search\/create\?query=/,
  );
  assert.equal(res.note, undefined, 'no cap note when nothing was capped');
  assert.ok(
    calls.some((c) => c.verb === 'delete'),
    'job cleaned up',
  );
});

test('default window is sent as epoch millis (independent of server TZ)', async () => {
  let jobBody: any;
  const { client } = fakeClient(
    jobRoutes({ status: done(), onJob: (b) => (jobBody = b) }),
  );
  const before = Date.now();
  const res = await search(client, 'x');
  assert.equal(typeof jobBody.from, 'number');
  assert.ok(Math.abs(jobBody.to - before) < 5000);
  assert.equal(jobBody.to - jobBody.from, 86400e3);
  assert.equal(res.meta.completeness, 'complete');
});

test('relative and around inputs resolve to epoch millis', async () => {
  const bodies: any[] = [];
  const { client } = fakeClient(
    jobRoutes({ status: done(), onJob: (b) => bodies.push(b) }),
  );
  await search(client, 'x', { from: '-2h' });
  assert.ok(Math.abs(bodies[0].to - bodies[0].from - 7200e3) < 50);
  await search(client, 'x', { around: '2026-09-29T12:00:00Z' });
  assert.equal(bodies[1].from, Date.UTC(2026, 8, 29, 11, 55));
  assert.equal(bodies[1].to, Date.UTC(2026, 8, 29, 12, 5));
});

test('flags truncation and projects returnFields', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({ messageCount: 50 }),
      messages: Array.from({ length: 50 }, (_, i) => msg(i)),
      fields: [
        { name: '_messagetime' },
        { name: '_raw' },
        { name: '_sourcecategory' },
      ],
    }),
  );
  const res = await search(client, 'x', { limit: 10, returnFields: ['_RAW'] });
  assert.equal(res.messages!.length, 10);
  assert.deepEqual(Object.keys(res.messages![0].map), ['_raw']);
  assert.deepEqual(res.fields, [{ name: '_raw' }], 'fields match the rows');
  assert.equal(res.meta.truncated, true);
  assert.deepEqual(res.meta.returned, { messages: 10, records: 0 });
  assert.equal(res.meta.completeness, 'partial');
});

test('zero-result aggregate still returns records', async () => {
  const { client, calls } = fakeClient(jobRoutes({ status: done() }));
  const res = await search(client, 'x | count by _sourceCategory');
  assert.equal(res.type, 'records');
  assert.deepEqual(res.records, []);
  assert.ok(!calls.some((c) => c.url.includes('/messages')));
});

test('retries a 429 then succeeds', async () => {
  let n = 0;
  const routes = jobRoutes({ status: done() });
  routes.unshift([
    /^\/search\/jobs$/,
    'post',
    () => {
      n += 1;
      if (n === 1)
        throw httpError(429, {
          code: 'rate.limit.exceeded',
          message: 'slow down',
        });
      return { id: 'JOB1' };
    },
  ]);
  const { client } = fakeClient(routes);
  const res = await search(client, 'x');
  assert.equal(n, 2);
  assert.equal(res.type, 'messages');
});

test('failures are classified, clean up the job, and never look empty', async () => {
  const routes = jobRoutes({ status: done() });
  routes.unshift([
    /^\/search\/jobs\/JOB1\/messages/,
    'get',
    () => {
      throw httpError(400, {
        code: 'searchjob.query.invalid',
        message: 'bad parse',
      });
    },
  ]);
  const { client, calls } = fakeClient(routes);
  await assert.rejects(search(client, 'x'), (err: any) => {
    assert.ok(err instanceof SumoSearchError);
    assert.equal(err.kind, 'invalid_query');
    assert.equal(err.retryable, false);
    const text = formatToolError(err);
    assert.match(text, /^Error: /);
    assert.match(text, /not an empty result/);
    return true;
  });
  assert.ok(calls.some((c) => c.verb === 'delete'));
});

test('cancelled job surfaces Sumo pending errors', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: {
        ...done(),
        state: 'CANCELLED',
        pendingErrors: ['query too broad'],
      },
    }),
  );
  await assert.rejects(search(client, 'x'), /cancelled: query too broad/);
});

test('bad time input is invalid_input without calling Sumo', async () => {
  const { client, calls } = fakeClient([]);
  await assert.rejects(
    search(client, 'x', { from: 'tuesday' }),
    (e: any) => e.kind === 'invalid_input',
  );
  assert.equal(calls.length, 0);
});

test('ignores the cookie notice Sumo sends on every status', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({
        messageCount: 1,
        warning:
          'You must enable cookies for subsequent requests to the search job. A 404 status (Page Not Found) on a follow-up request may be due to a cookie not accompanying the request.',
      }),
      messages: [msg(1)],
    }),
  );
  const res = await search(client, '_index=Production', { from: '-1h' });

  assert.deepEqual(res.meta.warnings, []);
  assert.equal(res.meta.completeness, 'complete');
  assert.equal(res.meta.totalsAreLowerBound, false);
});

test('flags totals as a lower bound when Sumo hits its result cap', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({
        messageCount: 200000,
        pendingWarnings: ['Max results reached'],
      }),
      messages: [msg(1)],
    }),
  );
  const res = await search(client, '_index=Production', {
    from: '-24h',
    limit: 1,
  });

  assert.equal(res.meta.totalsAreLowerBound, true);
  assert.equal(res.meta.completeness, 'partial');
  assert.ok(res.meta.warnings.some((w) => /lower bound/.test(w)));
});

test('flags capped raw messages behind an aggregate even without a Sumo warning', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({ messageCount: 200000, recordCount: 2 }),
      records: [{ map: { _count: '37' } }, { map: { _count: '1' } }],
      messages: [msg(1)],
    }),
  );
  const res = await search(client, '_index=Production | count by _sourceHost', {
    requiresRawMessages: true,
    limit: 5,
  });

  assert.equal(res.meta.totalsAreLowerBound, true);
  assert.equal(res.meta.completeness, 'partial');
  assert.ok(
    res.meta.warnings.some(
      (w) =>
        /records cover the whole window/i.test(w) && /raw messages/i.test(w),
    ),
    'says the records are complete and only the raw messages are capped',
  );
  assert.ok(
    !res.meta.warnings.some((w) => /use an aggregate/i.test(w)),
    'does not tell the caller to aggregate when it already did',
  );
});

test('warns that a capped histogram only covers the gathered messages', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({
        messageCount: 200000,
        histogramBuckets: [
          { startTimestamp: 3000, length: 900, count: 150000 },
          { startTimestamp: 2000, length: 1000, count: 50000 },
          { startTimestamp: 1000, length: 1000, count: 0 },
          { startTimestamp: 0, length: 1000, count: 0 },
        ],
      }),
      messages: [msg(1)],
    }),
  );
  const res = await search(client, '_index=Production', {
    includeHistogram: true,
    limit: 1,
  });

  assert.equal(res.meta.totalsAreLowerBound, true);
  assert.deepEqual(
    res.histogram!.map((b: any) => b.count),
    [150000, 50000],
    'drops the empty buckets older than the gathered messages',
  );
  assert.ok(
    res.meta.warnings.some(
      (w) =>
        /histogram/i.test(w) &&
        /sumologic_timeline/.test(w) &&
        /2 empty older buckets/.test(w),
    ),
  );
});

test('a plain aggregate over many messages is not capped', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({ messageCount: 160698250, recordCount: 1 }),
      records: [{ map: { _count: '160698250' } }],
    }),
  );
  const res = await search(client, '_index=Production | count', {
    includeHistogram: true,
  });

  assert.equal(res.meta.totalsAreLowerBound, false);
  assert.equal(res.meta.completeness, 'complete');
  assert.deepEqual(res.meta.warnings, []);
});

test('keeps empty histogram buckets when the search is not capped', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({
        messageCount: 10,
        histogramBuckets: [
          { startTimestamp: 2000, length: 1000, count: 10 },
          { startTimestamp: 1000, length: 1000, count: 0 },
        ],
      }),
      messages: [msg(1)],
    }),
  );
  const res = await search(client, '_index=Production', {
    includeHistogram: true,
    limit: 1,
  });

  assert.equal(res.histogram!.length, 2, 'a quiet period is real data here');
});

test('reports the time span the returned raw messages cover', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({ messageCount: 3 }),
      messages: [
        msg(0, { _messagetime: '1790872113895' }),
        msg(1, { _messagetime: '1790872110000' }),
        msg(2, { _messagetime: '1790872105290' }),
      ],
    }),
  );
  const res = await search(client, '_index=Production', {
    returnFields: ['_raw'],
  });

  assert.deepEqual(res.meta.returnedSpan, {
    newest: '2026-10-01T16:28:33.895Z',
    oldest: '2026-10-01T16:28:25.290Z',
  });
});

test('aggregates without raw messages have no returned span', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({ messageCount: 10, recordCount: 1 }),
      records: [{ map: { _count: '10' } }],
    }),
  );
  const res = await search(client, '_index=Production | count');
  assert.equal(res.meta.returnedSpan, undefined);
  assert.deepEqual(res.meta.partialReasons, []);
  assert.equal(res.meta.completeness, 'complete');
});

test('names each reason a result is partial', async () => {
  const limited = await search(
    fakeClient(
      jobRoutes({
        status: done({ messageCount: 50 }),
        messages: Array.from({ length: 50 }, (_, i) => msg(i)),
      }),
    ).client,
    'x',
    { limit: 10 },
  );
  assert.deepEqual(limited.meta.partialReasons, ['limit']);

  const rawCapped = await search(
    fakeClient(
      jobRoutes({
        status: done({ messageCount: 5000 }),
        messages: Array.from({ length: 5000 }, (_, i) => msg(i)),
      }),
    ).client,
    'x',
    { limit: 3000 },
  );
  assert.deepEqual(rawCapped.meta.partialReasons, ['rawMessageCap']);

  const sumoCapped = await search(
    fakeClient(
      jobRoutes({
        status: done({
          messageCount: 200000,
          pendingWarnings: ['Max results reached'],
        }),
        messages: [msg(1)],
      }),
    ).client,
    'x',
    { limit: 1 },
  );
  assert.deepEqual(sumoCapped.meta.partialReasons, ['limit', 'sumoCap']);

  const warned = await search(
    fakeClient(
      jobRoutes({
        status: done({ messageCount: 1, pendingWarnings: ['slow shard'] }),
        messages: [msg(1)],
      }),
    ).client,
    'x',
  );
  assert.deepEqual(warned.meta.partialReasons, ['sumoWarning']);
  assert.equal(warned.meta.completeness, 'partial');
});

// 300 messages, newest first, one every 10ms ending at base + 3000.
const base = 1790872000000;
const timed = Array.from({ length: 300 }, (_, i) =>
  msg(i, { _messagetime: String(base + 3000 - i * 10) }),
);
const thirds = [
  { startTimestamp: base + 2000, length: 1000, count: 100 },
  { startTimestamp: base + 1000, length: 1000, count: 100 },
  { startTimestamp: base, length: 1000, count: 100 },
];

test('around returns the messages next to the event, not the newest', async () => {
  const { client } = fakeClient(
    jobRoutes({
      status: done({ messageCount: 300, histogramBuckets: thirds }),
      messages: timed,
    }),
  );
  const around = base + 1500;
  const res = await search(client, '_index=Production', {
    around: String(around),
    aroundMinutes: 2,
    limit: 20,
  });

  const times = res.messages!.map((m: any) => Number(m.map._messagetime));
  assert.equal(times.length, 20);
  assert.ok(Math.max(...times) >= around, 'includes messages after the event');
  assert.ok(Math.min(...times) <= around, 'includes messages before the event');
  assert.equal(
    res.meta.window.from,
    new Date(around - 2 * 60 * 1000).toISOString(),
    'window stays centered',
  );
  assert.ok(!res.meta.warnings.some((w) => /around time/.test(w)));
});

test('warns when the returned messages do not reach the around time', async () => {
  const { client } = fakeClient(
    jobRoutes({
      // Sumo capped the job after the newest 100 messages.
      status: done({
        messageCount: 100,
        pendingWarnings: ['Max results reached'],
        histogramBuckets: [thirds[0]],
      }),
      messages: timed.slice(0, 100),
    }),
  );
  const res = await search(client, '_index=Production', {
    around: String(base + 500),
    limit: 20,
  });

  assert.ok(
    res.meta.warnings.some(
      (w) => /around time/.test(w) && /_sourceCategory/.test(w),
    ),
  );
});

test('a capped around search that misses retries once with a narrower window', async () => {
  const around = base + 150000;
  const jobs: any[] = [];
  const { client } = fakeClient(
    jobRoutes({
      onJob: (b) => jobs.push(b),
      // First job: +-2m, capped, and Sumo only got back to base + 240000.
      // Second job: narrow enough to be complete.
      status: (job) =>
        job.to - job.from >= 4 * 60 * 1000
          ? done({
              messageCount: 200000,
              pendingWarnings: ['Max results reached'],
              histogramBuckets: [
                { startTimestamp: base + 240000, length: 30000, count: 200000 },
              ],
            })
          : done({
              messageCount: 300,
              histogramBuckets: [
                { startTimestamp: around, length: 3000, count: 150 },
                { startTimestamp: around - 3000, length: 3000, count: 150 },
              ],
            }),
      messages: (job) =>
        job.to - job.from >= 4 * 60 * 1000
          ? Array.from({ length: 100 }, (_, i) =>
              msg(i, { _messagetime: String(base + 270000 - i) }),
            )
          : Array.from({ length: 300 }, (_, i) =>
              msg(i, { _messagetime: String(around + 3000 - i * 20) }),
            ),
    }),
  );
  const res = await search(client, '_index=Production', {
    around: String(around),
    aroundMinutes: 2,
    limit: 20,
  });

  assert.equal(jobs.length, 2, 'one retry, no more');
  const times = res.messages!.map((m: any) => Number(m.map._messagetime));
  assert.ok(Math.min(...times) <= around && Math.max(...times) >= around);
  assert.ok(
    res.meta.warnings.some((w) => /Narrowed the around window/.test(w)),
  );
  assert.ok(
    !res.meta.warnings.some((w) => /do not reach the around time/.test(w)),
  );
  assert.ok(
    Date.parse(res.meta.window.to) - Date.parse(res.meta.window.from) <
      4 * 60 * 1000,
  );
});

test('a capped around search that lands near the event does not warn', async () => {
  const { client, calls } = fakeClient(
    jobRoutes({
      status: done({
        messageCount: 300,
        pendingWarnings: ['Max results reached'],
        // Coarse buckets: the estimate lands a little after the event.
        histogramBuckets: [
          { startTimestamp: base + 1000, length: 2000, count: 250 },
          { startTimestamp: base, length: 1000, count: 50 },
        ],
      }),
      messages: timed,
    }),
  );
  const around = base + 1095;
  const res = await search(client, '_index=Production', {
    around: String(around),
    limit: 20,
  });
  assert.ok(!res.meta.warnings.some((w) => /around time/.test(w)));
  const times = res.messages!.map((m: any) => Number(m.map._messagetime));
  assert.ok(
    Math.min(...times) <= around && Math.max(...times) >= around,
    'refines the coarse estimate onto the event',
  );
  const probes = calls.filter((c) => /\/messages/.test(c.url)).length;
  assert.ok(probes <= 9, `bounded extra requests (${probes})`);
});

test('around lands on the event in a large window with uneven traffic', async () => {
  // 200k messages, newest first, bunched toward the newest end.
  const n = 200000;
  const span = 120000;
  const timeOf = (i: number) =>
    base + span - Math.floor(span * Math.pow(i / n, 0.5));
  const many = Array.from({ length: n }, (_, i) =>
    msg(i, { _messagetime: String(timeOf(i)) }),
  );
  const { client, calls } = fakeClient(
    jobRoutes({
      status: done({
        messageCount: n,
        histogramBuckets: [
          { startTimestamp: base + 60000, length: 60000, count: n / 2 },
          { startTimestamp: base, length: 60000, count: n / 2 },
        ],
      }),
      messages: many,
    }),
  );
  const around = base + 100000;
  const res = await search(client, '_index=Production', {
    around: String(around),
    aroundMinutes: 1,
    limit: 20,
  });

  const times = res.messages!.map((m: any) => Number(m.map._messagetime));
  assert.ok(
    Math.min(...times) <= around && Math.max(...times) >= around,
    `span ${Math.min(...times) - base}..${Math.max(...times) - base} misses ${around - base}`,
  );
  const reads = calls.filter((c) => /\/messages/.test(c.url)).length;
  assert.ok(reads <= 16, `bounded extra requests (${reads})`);
});
