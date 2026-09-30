import * as Sumo from '@/lib/sumologic/client.js';
import { maskSensitiveInfo } from '@/utils/pii.js';
import {
  resolveTime,
  resolveWindow,
  toIso,
  assertTimeZone,
} from '@/utils/time.js';
import {
  SumoSearchError,
  classifyError,
  isNetworkError,
  statusCodeOf,
} from '@/domains/sumologic/errors.js';
import { searchUiLink } from '@/domains/sumologic/links.js';

export interface SearchMeta {
  // Unique per search, so two results can never be confused for one another.
  jobId: string;
  query: string;
  window: {
    from: string;
    to: string;
    timeZone: string;
    timeBasis: 'messageTime' | 'receiptTime' | 'searchableTime';
  };
  // Final Sumo job state (`DONE GATHERING RESULTS` or `FORCE PAUSED`).
  state: string;
  // What Sumo matched in total vs. what this response carries.
  totals: { messages: number; records: number };
  returned: { messages: number; records: number };
  truncated: boolean;
  // `complete` only when nothing was capped, paused, warned or errored.
  completeness: 'complete' | 'partial';
  warnings: string[];
  errors: string[];
  elapsedMs: number;
  links?: { ui?: string };
}

export interface SearchResult {
  // 'messages' for raw log searches, 'records' for aggregate queries
  // (queries containing operators like `count`, `sum`, `avg`, `by`, `timeslice`).
  type: 'messages' | 'records';
  // Column definitions returned by Sumo Logic (present for aggregate results).
  fields?: any[];
  // Raw log messages. Populated when type === 'messages', and also for an
  // aggregate query when `requiresRawMessages` asked Sumo to keep them.
  messages?: any[];
  // Aggregate result rows (populated when type === 'records').
  records?: any[];
  // Volume-over-time buckets, when `includeHistogram` is set.
  histogram?: any[];
  // Set when the raw-message payload was capped for transport safety.
  note?: string;
  // Provenance and trust signals for the result.
  meta: SearchMeta;
}

// Sumo Logic caps a single results page at 10000 rows, so paginate above that.
const MAX_ROWS_PER_PAGE = 10000;
// Overall ceiling on rows a single search may return. Sumo limits a search to
// 100K messages, so match that.
const MAX_TOTAL_ROWS = 100000;
// Default number of rows to return when the caller doesn't specify a limit.
const DEFAULT_LIMIT = 100;
// Raw log messages are large; returning tens of thousands of them produces a
// multi-megabyte payload that can drop the MCP stdio connection. Cap raw
// messages here unless the caller explicitly opts in with allowLargeResult.
// Aggregate records are compact and are not capped.
const SAFE_RAW_MESSAGE_LIMIT = 2000;
// Poll the job status at this interval until it reaches a terminal state.
const POLL_INTERVAL_MS = 1000;
// Give up waiting for a job after this long so a stuck job can't hang forever.
// Long lookbacks (e.g. 60 days) may need more; SUMO_SEARCH_TIMEOUT_MS raises it.
const DEFAULT_MAX_POLL_MS = 5 * 60 * 1000;
// Sumo returns these when it is busy (429 = 200-job org concurrency limit) or
// briefly unavailable. Retry them with backoff rather than failing the search.
const RETRYABLE_STATUS = [429, 502, 503, 504];
const MAX_RETRIES = 4;

function maxPollMs(override?: number): number {
  if (override && override > 0) {
    return override;
  }
  const env = Number(process.env.SUMO_SEARCH_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_POLL_MS;
}

export interface SearchOptions {
  // ISO 8601 (wall-clock in `timeZone`, or with Z/offset), epoch millis, or a
  // relative time such as `-15m` / `-60d`. Defaults to 24 hours before `to`.
  from?: string;
  // Same formats as `from`. Defaults to now.
  to?: string;
  // Center the window on this instant (±aroundMinutes). Overrides from/to.
  around?: string;
  aroundMinutes?: number;
  // Max rows to return (1–100000). Defaults to 100. Rows beyond a single 10000
  // row page are fetched by paginating.
  limit?: number;
  // Search by message arrival (receipt) time rather than message timestamp.
  byReceiptTime?: boolean;
  // Search by indexed (searchable) time rather than message timestamp.
  bySearchableTime?: boolean;
  // 'AutoParse' extracts JSON fields automatically; 'Manual' (default) does not.
  autoParsingMode?: 'AutoParse' | 'Manual';
  // Keep the raw messages behind an aggregate query so they can be returned
  // alongside the aggregated records (one job instead of two).
  requiresRawMessages?: boolean;
  // Also return volume-over-time histogram buckets for the search.
  includeHistogram?: boolean;
  // Return more than SAFE_RAW_MESSAGE_LIMIT raw messages. Off by default because
  // a very large raw payload can drop the MCP connection.
  allowLargeResult?: boolean;
  // IANA time zone used to interpret `from`/`to` when they carry no offset.
  // Defaults to UTC.
  timeZone?: string;
  // Keep only these keys in each row's `map` (case-insensitive) to shrink the
  // payload, e.g. ['_messagetime', '_sourcecategory', '_raw'].
  returnFields?: string[];
  // Override the poll timeout for this search.
  timeoutMs?: number;
}

// Aggregate operators produce grouped records instead of raw messages. A query
// is aggregate when one of these appears as its own token in a pipe segment
// (e.g. `... | count by _timeslice`, `... | timeslice 1h | sum(bytes)`).
const AGGREGATE_OPERATORS = [
  'count',
  'count_distinct',
  'count_frequent',
  'sum',
  'avg',
  'average',
  'min',
  'max',
  'stddev',
  'variance',
  'pct',
  'percentile',
  'median',
  'first',
  'last',
  'most_recent',
  'least_recent',
  'values',
];

export function looksLikeAggregateQuery(query: string): boolean {
  return query
    .split('|')
    .slice(1)
    .some((segment) => {
      const normalized = segment.toLowerCase();
      return AGGREGATE_OPERATORS.some((op) =>
        new RegExp(`\\b${op}\\b`).test(normalized),
      );
    });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(err: any): number | undefined {
  const header = err?.response?.headers?.['retry-after'];
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

// Retry a Sumo call on transient failures (429 concurrency, 5xx, dropped
// sockets) with exponential backoff, honoring Retry-After when Sumo sends it.
// Anything else, or a run out of attempts, rethrows.
export async function withRetry<T>(fn: () => PromiseLike<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: any) {
      const code = statusCodeOf(err);
      const transient =
        (code !== undefined && RETRYABLE_STATUS.includes(code)) ||
        isNetworkError(err);
      if (attempt >= MAX_RETRIES || !transient) {
        throw err;
      }
      const backoff = Math.min(1000 * 2 ** attempt, 8000);
      await sleep(Math.min(retryAfterMs(err) ?? backoff, 30000));
      attempt += 1;
    }
  }
}

// Walk a paginated results endpoint (messages/records) in 10000 row pages until
// `wanted` rows are collected or the data runs out.
async function fetchAllRows(
  total: number,
  wanted: number,
  fetchPage: (
    offset: number,
    pageLimit: number,
  ) => PromiseLike<{ fields: Sumo.IField[]; rows: any[] }>,
): Promise<{ fields: Sumo.IField[]; rows: any[] }> {
  const target = Math.min(total, wanted);
  let fields: Sumo.IField[] = [];
  const rows: any[] = [];

  while (rows.length < target) {
    const pageLimit = Math.min(MAX_ROWS_PER_PAGE, target - rows.length);
    const page = await withRetry(() => fetchPage(rows.length, pageLimit));
    fields = page.fields;
    if (!page.rows.length) {
      break;
    }
    rows.push(...page.rows);
    if (page.rows.length < pageLimit) {
      break;
    }
  }

  return { fields, rows };
}

// Only these fields can contain PII worth masking.
function sanitizeRow(row: any): any {
  if (row && row.map && typeof row.map === 'object') {
    const plainMap: Record<string, string> = {};
    Object.keys(row.map).forEach((key) => {
      const rawValue = row.map[key]?.toString() || '';
      if (key === '_raw' || key === 'response') {
        plainMap[key] = maskSensitiveInfo(rawValue);
      } else {
        plainMap[key] = rawValue;
      }
    });

    const maskedRaw = row._raw
      ? maskSensitiveInfo(row._raw.toString())
      : undefined;

    return { ...row, map: plainMap, _raw: maskedRaw };
  }

  if (row && row._raw && typeof row._raw === 'string') {
    return { ...row, _raw: maskSensitiveInfo(row._raw) };
  }

  if (row && row.response && typeof row.response === 'string') {
    return { ...row, response: maskSensitiveInfo(row.response) };
  }

  if (typeof row === 'string') {
    return row;
  }

  if (typeof row === 'object' && row !== null) {
    const result = { ...row };
    if (result._raw && typeof result._raw === 'string') {
      result._raw = maskSensitiveInfo(result._raw);
    }
    if (result.response && typeof result.response === 'string') {
      result.response = maskSensitiveInfo(result.response);
    }
    return result;
  }

  return row;
}

// Keep only the requested keys of a row's map (case-insensitive).
function projectRow(row: any, keep?: Set<string>): any {
  if (!keep || !row?.map) {
    return row;
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.map)) {
    if (keep.has(key.toLowerCase())) {
      map[key] = value as string;
    }
  }
  const { _raw, ...rest } = row;
  return keep.has('_raw') && _raw !== undefined
    ? { ...rest, map, _raw }
    : { ...rest, map };
}

const toStrings = (items: any[] | undefined): string[] =>
  (items ?? []).map((item) =>
    typeof item === 'string' ? item : (item?.message ?? JSON.stringify(item)),
  );

// Resolve the job's from/to. Wall-clock ISO strings without an offset are
// passed through untouched (Sumo interprets them in `timeZone`, as before);
// everything else (relative, epoch, ISO with Z/offset, and the default
// window) is sent as unambiguous epoch millis.
function resolveJobWindow(
  options: SearchOptions,
  timeZone: string,
  now: number,
) {
  const window = resolveWindow(
    {
      from: options.from,
      to: options.to,
      around: options.around,
      aroundMinutes: options.aroundMinutes,
      timeZone,
    },
    now,
  );
  const passThrough = (value: string | undefined, epochMs: number) => {
    if (!options.around && value) {
      const { kind } = resolveTime(value, timeZone, now);
      if (kind === 'iso-local') {
        return value;
      }
    }
    return epochMs;
  };
  return {
    ...window,
    jobFrom: passThrough(options.from, window.fromMs),
    jobTo: passThrough(options.to, window.toMs),
  };
}

export async function search(
  client: Sumo.Client,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const startedAt = Date.now();
  const timeZone = options.timeZone || 'UTC';
  let window: ReturnType<typeof resolveJobWindow>;
  try {
    assertTimeZone(timeZone);
    window = resolveJobWindow(options, timeZone, startedAt);
  } catch (err) {
    throw new SumoSearchError((err as Error).message, 'invalid_input');
  }
  const { fromMs, toMs, jobFrom, jobTo } = window;

  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_LIMIT, 1),
    MAX_TOTAL_ROWS,
  );

  // Raw messages are large, so cap them unless the caller opts in. Aggregate
  // records stay on the full limit.
  const rawLimit = options.allowLargeResult
    ? limit
    : Math.min(limit, SAFE_RAW_MESSAGE_LIMIT);
  const capNote =
    rawLimit < limit
      ? `Raw messages capped at ${SAFE_RAW_MESSAGE_LIMIT} to protect the ` +
        `connection. Pass allowLargeResult:true to return up to ${limit}, or ` +
        `use an aggregate query (e.g. | count by ...) for large result sets.`
      : undefined;

  const keep = options.returnFields?.length
    ? new Set(options.returnFields.map((f) => f.toLowerCase()))
    : undefined;
  const shape = (row: any) => projectRow(sanitizeRow(row), keep);

  // Create search job
  const jobParams: Sumo.IJobOptions = {
    query,
    from: jobFrom,
    to: jobTo,
    timeZone,
    ...(options.byReceiptTime !== undefined && {
      byReceiptTime: options.byReceiptTime,
    }),
    ...(options.bySearchableTime !== undefined && {
      bySearchableTime: options.bySearchableTime,
    }),
    ...(options.autoParsingMode && {
      autoParsingMode: options.autoParsingMode,
    }),
    ...(options.requiresRawMessages !== undefined && {
      requiresRawMessages: options.requiresRawMessages,
    }),
  };

  // One cookie session per search so parallel searches can't clobber each
  // other's job affinity.
  const session = client.withSession();
  let jobId: string | undefined;
  const cleanup = async () => {
    if (jobId) {
      const id = jobId;
      jobId = undefined;
      await Promise.resolve(session.delete(id)).catch(() => undefined);
    }
  };

  try {
    const created = await withRetry(() => session.job(jobParams));
    jobId = created.id;
    const id = created.id;

    // Sumo reports warnings/errors as "pending since the last status call",
    // so accumulate them across every poll.
    const warnings: string[] = [];
    const errors: string[] = [];

    // Wait for the job to reach a terminal state. A job may also end in
    // CANCELLED, and 'FORCE PAUSED' means results are ready (a non-aggregate
    // query hit its 100K cap) — so treat both done states as complete. Guard
    // with a timeout so a stuck job can't spin this loop forever.
    const doneStates = ['DONE GATHERING RESULTS', 'FORCE PAUSED'];
    const timeoutMs = maxPollMs(options.timeoutMs);
    let status: Sumo.IStatus;
    do {
      status = await withRetry(() => session.status(id));
      warnings.push(...toStrings(status.pendingWarnings));
      errors.push(...toStrings(status.pendingErrors));
      if (status.warning) {
        warnings.push(status.warning);
      }

      if (status.state === 'CANCELLED') {
        throw new SumoSearchError(
          `Sumo Logic search job was cancelled${
            errors.length ? `: ${errors.join('; ')}` : ''
          }`,
          'cancelled',
        );
      }

      if (doneStates.includes(status.state)) {
        break;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new SumoSearchError(
          `Sumo Logic search job did not complete within ${
            timeoutMs / 1000
          }s (last state: ${status.state})`,
          'timeout',
        );
      }

      await sleep(POLL_INTERVAL_MS);
    } while (true);

    // Aggregate queries (count/sum/avg/by/timeslice/...) produce records rather
    // than raw messages, and such jobs keep no raw messages — fetching
    // /messages on them fails with `requireRawMessages is false`. A positive
    // recordCount proves the job is aggregate, but an aggregate query that
    // matches nothing reports recordCount 0, so also detect aggregate intent
    // from the query itself. Otherwise a zero-result aggregate would be routed
    // to /messages and error instead of returning empty records.
    const recordCount = status.recordCount ?? 0;
    const messageCount = status.messageCount ?? 0;
    const isAggregate = recordCount > 0 || looksLikeAggregateQuery(query);

    // Best-effort volume-over-time buckets from the final status.
    const histogram = options.includeHistogram
      ? (status.histogramBuckets ?? [])
      : undefined;

    const buildMeta = (returned: { messages: number; records: number }) => {
      const truncated = isAggregate
        ? returned.records < recordCount ||
          (!!options.requiresRawMessages && returned.messages < messageCount)
        : returned.messages < messageCount;
      const forcePaused = status.state === 'FORCE PAUSED';
      if (forcePaused) {
        warnings.push(
          'Job FORCE PAUSED: Sumo stopped gathering at its 100K message cap, so totals are a lower bound. Narrow the query or use an aggregate.',
        );
      }
      const meta: SearchMeta = {
        jobId: id,
        query,
        window: {
          from: toIso(fromMs),
          to: toIso(toMs),
          timeZone,
          timeBasis: options.byReceiptTime
            ? 'receiptTime'
            : options.bySearchableTime
              ? 'searchableTime'
              : 'messageTime',
        },
        state: status.state,
        totals: { messages: messageCount, records: recordCount },
        returned,
        truncated,
        completeness:
          truncated || forcePaused || warnings.length || errors.length
            ? 'partial'
            : 'complete',
        warnings: [...new Set(warnings)],
        errors: [...new Set(errors)],
        elapsedMs: Date.now() - startedAt,
      };
      const ui = searchUiLink(client.endpoint, query, fromMs, toMs);
      if (ui) {
        meta.links = { ui };
      }
      return meta;
    };

    if (isAggregate) {
      const records = await fetchAllRows(
        recordCount,
        limit,
        async (offset, pageLimit) => {
          const page = await session.records(id, { offset, limit: pageLimit });
          return { fields: page.fields, rows: page.records };
        },
      );

      // requiresRawMessages keeps the underlying messages for an aggregate job,
      // so return them alongside the records when the caller asked for them.
      const rawMessages =
        options.requiresRawMessages && messageCount > 0
          ? await fetchAllRows(
              messageCount,
              rawLimit,
              async (offset, pageLimit) => {
                const page = await session.messages(id, {
                  offset,
                  limit: pageLimit,
                });
                return { fields: page.fields, rows: page.messages };
              },
            )
          : undefined;

      await cleanup();

      return {
        type: 'records',
        fields: records.fields,
        records: records.rows.map(shape),
        ...(rawMessages && { messages: rawMessages.rows.map(shape) }),
        ...(histogram && { histogram }),
        ...(rawMessages && capNote && { note: capNote }),
        meta: buildMeta({
          messages: rawMessages?.rows.length ?? 0,
          records: records.rows.length,
        }),
      };
    }

    // Non-aggregate search: return the raw log messages.
    const messages = await fetchAllRows(
      messageCount || rawLimit,
      rawLimit,
      async (offset, pageLimit) => {
        const page = await session.messages(id, { offset, limit: pageLimit });
        return { fields: page.fields, rows: page.messages };
      },
    );

    await cleanup();

    return {
      type: 'messages',
      fields: messages.fields,
      messages: messages.rows.map(shape),
      ...(histogram && { histogram }),
      ...(capNote && messageCount > rawLimit && { note: capNote }),
      meta: buildMeta({ messages: messages.rows.length, records: 0 }),
    };
  } catch (error) {
    await cleanup();
    console.error('Sumo Logic search error:', error);
    throw classifyError(error);
  }
}
