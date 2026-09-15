import moment from 'moment';
import * as Sumo from '@/lib/sumologic/client.js';
import { maskSensitiveInfo } from '@/utils/pii.js';

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
const MAX_POLL_MS = 5 * 60 * 1000;
// Sumo returns these when it is busy (429 = 200-job org concurrency limit) or
// briefly unavailable. Retry them with backoff rather than failing the search.
const RETRYABLE_STATUS = [429, 502, 503, 504];
const MAX_RETRIES = 4;

export interface SearchOptions {
  from?: string;
  to?: string;
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

function looksLikeAggregateQuery(query: string): boolean {
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

// Retry a Sumo call on transient failures (429 concurrency, 5xx) with
// exponential backoff. Anything else, or a run out of attempts, rethrows.
async function withRetry<T>(fn: () => PromiseLike<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: any) {
      const code = err?.statusCode ?? err?.response?.statusCode;
      if (attempt >= MAX_RETRIES || !RETRYABLE_STATUS.includes(code)) {
        throw err;
      }
      const delayMs = Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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

interface SumoAPIError {
  statusCode?: number;
  message: string;
  error?: any;
  response?: {
    body: any;
  };
}

export async function search(
  client: Sumo.Client,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const defaultTimeRange = {
    from: moment().subtract(1, 'day').toISOString(true).slice(0, 19),
    to: moment().toISOString(true).slice(0, 19),
  };

  const { from, to } = {
    ...defaultTimeRange,
    ...(options.from && { from: options.from }),
    ...(options.to && { to: options.to }),
  };

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

  // Create search job
  const jobParams: Sumo.IJobOptions = {
    query,
    from,
    to,
    timeZone: options.timeZone || 'UTC',
    ...(options.byReceiptTime !== undefined && {
      byReceiptTime: options.byReceiptTime,
    }),
    ...(options.bySearchableTime !== undefined && {
      bySearchableTime: options.bySearchableTime,
    }),
    ...(options.autoParsingMode && { autoParsingMode: options.autoParsingMode }),
    ...(options.requiresRawMessages !== undefined && {
      requiresRawMessages: options.requiresRawMessages,
    }),
  };

  try {
    const { id } = await withRetry(() => client.job(jobParams));

    // Wait for the job to reach a terminal state. A job may also end in
    // CANCELLED, and 'FORCE PAUSED' means results are ready (a non-aggregate
    // query hit its 100K cap) — so treat both done states as complete. Guard
    // with a timeout so a stuck job can't spin this loop forever.
    const doneStates = ['DONE GATHERING RESULTS', 'FORCE PAUSED'];
    const startedAt = Date.now();
    let status;
    do {
      status = await withRetry(() => client.status(id));

      if (status.state === 'CANCELLED') {
        await Promise.resolve(client.delete(id)).catch(() => undefined);
        throw new Error('Sumo Logic search job was cancelled');
      }

      if (doneStates.includes(status.state)) {
        break;
      }

      if (Date.now() - startedAt > MAX_POLL_MS) {
        await Promise.resolve(client.delete(id)).catch(() => undefined);
        throw new Error(
          `Sumo Logic search job did not complete within ${
            MAX_POLL_MS / 1000
          }s (last state: ${status.state})`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
      ? status.histogramBuckets ?? []
      : undefined;

    if (isAggregate) {
      const records = await fetchAllRows(
        recordCount,
        limit,
        async (offset, pageLimit) => {
          const page = await client.records(id, { offset, limit: pageLimit });
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
                const page = await client.messages(id, {
                  offset,
                  limit: pageLimit,
                });
                return { fields: page.fields, rows: page.messages };
              },
            )
          : undefined;

      // Cleanup
      await client.delete(id);

      return {
        type: 'records',
        fields: records.fields,
        records: records.rows.map(sanitizeRow),
        ...(rawMessages && { messages: rawMessages.rows.map(sanitizeRow) }),
        ...(histogram && { histogram }),
        ...(rawMessages && capNote && { note: capNote }),
      };
    }

    // Non-aggregate search: return the raw log messages.
    const messages = await fetchAllRows(
      messageCount || rawLimit,
      rawLimit,
      async (offset, pageLimit) => {
        const page = await client.messages(id, { offset, limit: pageLimit });
        return { fields: page.fields, rows: page.messages };
      },
    );

    // Cleanup
    await client.delete(id);

    return {
      type: 'messages',
      fields: messages.fields,
      messages: messages.rows.map(sanitizeRow),
      ...(histogram && { histogram }),
      ...(capNote && { note: capNote }),
    };
  } catch (error) {
    console.error('Sumo Logic search error:', error);
    throw error;
  }
}
