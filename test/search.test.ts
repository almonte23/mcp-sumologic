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
    }),
  );
  const res = await search(client, 'x', { limit: 10, returnFields: ['_RAW'] });
  assert.equal(res.messages!.length, 10);
  assert.deepEqual(Object.keys(res.messages![0].map), ['_raw']);
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
