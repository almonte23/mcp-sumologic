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

// limit: the caller's limit returned fewer rows than matched.
// rawMessageCap: this server's raw message cap (see allowLargeResult).
// sumoCap: Sumo stopped gathering, so totals are a lower bound.
// sumoWarning / sumoError: Sumo reported a warning or error for the job.
// narrowedWindow: a capped `around` search was retried with a smaller window.
export type PartialReason =
  | 'narrowedWindow'
  | 'limit'
  | 'rawMessageCap'
  | 'sumoCap'
  | 'sumoWarning'
  | 'sumoError';

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
  // True when Sumo stopped counting at a cap, so the real totals are higher.
  totalsAreLowerBound: boolean;
  returned: { messages: number; records: number };
  // Message times of the newest and oldest raw message returned. Sumo returns
  // the newest first, so a capped search can span far less than `window`.
  returnedSpan?: { newest: string; oldest: string };
  truncated: boolean;
  // `complete` only when nothing was capped, paused, warned or errored.
  completeness: 'complete' | 'partial';
  // Why the result is partial; empty when complete.
  partialReasons: PartialReason[];
  // Set when a search scoped by _sourceCategory matched nothing and the
  // category alone also matched nothing in the window (or the check failed):
  // a wrong category name returns a complete, empty result too.
  hint?: string;
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
// Overall ceiling on rows a single search may return (the tool's `limit`
// maximum). Sumo itself stops gathering raw messages at its own cap; see
// DEFAULT_MESSAGE_CAP.
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
// Sumo puts this text in every job status `warning`, even when the session
// cookie is sent correctly, so it says nothing about this search.
const COOKIE_NOTICE = /^You must enable cookies for subsequent requests/i;
// Sumo stopped gathering at its result cap, so totals are a lower bound.
const MAX_RESULTS_WARNING = /max(imum)? results reached/i;
// Sumo stops gathering raw messages at this many, newest first, and does not
// always say so. The API does not expose the number; SUMO_MESSAGE_CAP
// overrides it if Sumo changes it.
const DEFAULT_MESSAGE_CAP = 200000;

function messageCap(): number {
  const env = Number(process.env.SUMO_MESSAGE_CAP);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MESSAGE_CAP;
}

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
  // Internal: set on the one retry of a capped `around` search, holding the
  // half width that was first asked for.
  narrowedFromMs?: number;
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
  startOffset = 0,
): Promise<{ fields: Sumo.IField[]; rows: any[] }> {
  const target = Math.min(total - startOffset, wanted);
  let fields: Sumo.IField[] = [];
  const rows: any[] = [];

  while (rows.length < target) {
    const pageLimit = Math.min(MAX_ROWS_PER_PAGE, target - rows.length);
    const page = await withRetry(() =>
      fetchPage(startOffset + rows.length, pageLimit),
    );
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

// Raw messages come back newest first, so an `around` search would otherwise
// return the end of the window instead of the event. Sumo's histogram counts
// how many messages are newer than the event; start half a page before that.
// Half width (ms) for an around window expected to hold about 40% of the cap,
// from the rate the capped search gathered: messageCount over the time between
// the oldest non-empty histogram bucket and the window end.
function narrowedHalfWidth(
  buckets: any[],
  toMs: number,
  messageCount: number,
): number | undefined {
  const filled = buckets.filter((b) => Number(b?.count) > 0);
  if (!filled.length || messageCount <= 0) {
    return undefined;
  }
  const oldest = Math.min(...filled.map((b) => Number(b.startTimestamp)));
  const perMs = messageCount / Math.max(toMs - oldest, 1);
  return Math.max(5000, Math.floor((0.4 * messageCap()) / perMs));
}

// Each probe reads one message. Busy logs put ~1.5 messages in every ms, so
// a few probes are not enough to land a 20 row page on the event.
const MAX_AROUND_PROBES = 12;

// Raw messages are sorted newest first, so the event's position can be found
// by reading single messages: alternate interpolation (fast when the rate is
// even) with halving (safe when it is not). Returns the offset to read from so
// the event sits mid page.
async function locateAround(
  timeAt: (offset: number) => Promise<number | undefined>,
  aroundMs: number,
  total: number,
  wanted: number,
  page: { offset: number; count: number; newest: number; oldest: number },
): Promise<number> {
  const lastStart = Math.max(0, total - wanted);
  // lo always holds a message newer than the event, hi one at or before it.
  let lo: number;
  let tLo: number;
  let hi: number;
  let tHi: number;
  if (aroundMs > page.newest) {
    hi = page.offset;
    tHi = page.newest;
    const first = await timeAt(0);
    if (first === undefined || first <= aroundMs) {
      return 0;
    }
    lo = 0;
    tLo = first;
  } else {
    lo = page.offset + page.count - 1;
    tLo = page.oldest;
    hi = total - 1;
    const last = await timeAt(hi);
    if (last === undefined || last > aroundMs) {
      return lastStart;
    }
    tHi = last;
  }

  // Stop once the gap fits in half a page: the page then holds the event.
  const closeEnough = Math.max(1, Math.floor(wanted / 2));
  for (let i = 0; i < MAX_AROUND_PROBES && hi - lo > closeEnough; i += 1) {
    const share =
      i % 2 === 0 && tLo > tHi ? (tLo - aroundMs) / (tLo - tHi) : 0.5;
    const mid = Math.min(
      hi - 1,
      Math.max(lo + 1, lo + Math.round(share * (hi - lo))),
    );
    const time = await timeAt(mid);
    if (time === undefined) {
      break;
    }
    if (time > aroundMs) {
      lo = mid;
      tLo = time;
    } else {
      hi = mid;
      tHi = time;
    }
  }
  return Math.max(0, Math.min(hi - Math.floor(wanted / 2), lastStart));
}

const formatSpan = (ms: number) =>
  ms >= 60000 ? `${+(ms / 60000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;

function aroundOffset(
  buckets: any[],
  aroundMs: number,
  total: number,
  wanted: number,
): number {
  let newer = 0;
  for (const b of buckets) {
    const start = Number(b?.startTimestamp);
    const length = Number(b?.length);
    const count = Number(b?.count) || 0;
    if (start >= aroundMs) {
      newer += count;
    } else if (length > 0 && start + length > aroundMs) {
      newer += (count * (start + length - aroundMs)) / length;
    }
  }
  const offset = Math.round(newer - wanted / 2);
  return Math.max(0, Math.min(offset, total - wanted));
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

// On a capped search Sumo gathers the newest messages only, so every empty
// bucket older than the oldest non-empty one was never searched.
function trimUnsearchedBuckets(buckets: any[]): any[] {
  const filled = buckets.filter((b) => Number(b?.count) > 0);
  if (!filled.length) {
    return buckets;
  }
  const oldest = Math.min(...filled.map((b) => Number(b.startTimestamp)));
  return buckets.filter(
    (b) => Number(b?.count) > 0 || Number(b?.startTimestamp) >= oldest,
  );
}

function returnedSpan(
  rows: any[] = [],
): { newest: string; oldest: string } | undefined {
  const times = rows
    .map((row) => Number(row?.map?._messagetime))
    .filter(Number.isFinite);
  if (!times.length) {
    return undefined;
  }
  return {
    newest: toIso(Math.max(...times)),
    oldest: toIso(Math.min(...times)),
  };
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

const PROBE_TIMEOUT_MS = 30_000;
const KNOWN_CATEGORY_TTL_MS = 15 * 60_000;
const knownCategories = new Map<string, number>();

function sourceCategoryOf(query: string): string | undefined {
  return /_sourceCategory\s*=\s*("[^"]*"|[^\s|)]+)/i.exec(query)?.[1];
}

// Partitions outside the default search scope (e.g. PreProduction) are only
// searched when the query names them, so the probe must keep the same scope.
function partitionScopeOf(query: string): string {
  const scope = query.split('|')[0];
  return [
    ...scope.matchAll(/(?:^|\s)(_(?:index|view)\s*=\s*(?:"[^"]*"|[^\s)]+))/gi),
  ]
    .map((m) => m[1].replace(/\s*=\s*/, '='))
    .join(' ');
}

// A zero result scoped by _sourceCategory is ambiguous: the category name may
// be wrong, or only the search terms matched nothing. Probe the category alone
// (inside the same partition scope) over the same window so the hint fires only
// for the first case. A category that once returned data stays known for a
// while, so baselines and repeated searches don't probe again.
async function categoryHasData(
  client: Sumo.Client,
  category: string,
  partitionScope: string,
  options: SearchOptions,
): Promise<boolean> {
  const probeScope = [partitionScope, `_sourceCategory=${category}`]
    .filter(Boolean)
    .join(' ');
  const knownAt = knownCategories.get(probeScope);
  if (knownAt && Date.now() - knownAt < KNOWN_CATEGORY_TTL_MS) return true;

  const probe = await runSearch(client, `${probeScope} | limit 1`, {
    from: options.from,
    to: options.to,
    around: options.around,
    aroundMinutes: options.aroundMinutes,
    timeZone: options.timeZone,
    byReceiptTime: options.byReceiptTime,
    bySearchableTime: options.bySearchableTime,
    limit: 1,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const found = probe.meta.totals.messages > 0;
  if (found) knownCategories.set(probeScope, Date.now());
  return found;
}

export async function search(
  client: Sumo.Client,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const result = await runSearch(client, query, options);
  const category = sourceCategoryOf(query);
  if (result.meta.totals.messages > 0 || !category) return result;

  const hasData = await categoryHasData(
    client,
    category,
    partitionScopeOf(query),
    options,
  ).catch(() => false);
  if (!hasData) {
    result.meta.hint = `Nothing matched _sourceCategory=${category}. If you expected data, check the name with sumologic_discover_sources; a wrong category also returns 0.`;
  }
  return result;
}

async function runSearch(
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
  const shapeFields = (fields: Sumo.IField[]) =>
    keep ? fields.filter((f) => keep.has(f.name?.toLowerCase())) : fields;

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
    // query hit its message cap) — so treat both done states as complete. Guard
    // with a timeout so a stuck job can't spin this loop forever.
    const doneStates = ['DONE GATHERING RESULTS', 'FORCE PAUSED'];
    const timeoutMs = maxPollMs(options.timeoutMs);
    let status: Sumo.IStatus;
    do {
      status = await withRetry(() => session.status(id));
      warnings.push(...toStrings(status.pendingWarnings));
      errors.push(...toStrings(status.pendingErrors));
      if (status.warning && !COOKIE_NOTICE.test(status.warning)) {
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

    // Only warnings Sumo sent, before this server adds its own below. The
    // "max results" warning is reported as sumoCap instead.
    const hasSumoWarning = warnings.some((w) => !MAX_RESULTS_WARNING.test(w));
    const forcePaused = status.state === 'FORCE PAUSED';
    if (forcePaused) {
      warnings.push(
        'Job FORCE PAUSED: Sumo stopped gathering at its message cap, so totals are a lower bound. Narrow the query or use an aggregate.',
      );
    }
    // A plain aggregate keeps no raw messages, so its messageCount is the
    // real total and is never capped.
    const gathersRawMessages = !isAggregate || !!options.requiresRawMessages;
    const totalsAreLowerBound =
      forcePaused ||
      warnings.some((w) => MAX_RESULTS_WARNING.test(w)) ||
      (gathersRawMessages && messageCount >= messageCap());
    // With requiresRawMessages Sumo still aggregates the whole window; only
    // the raw messages it keeps stop at the cap.
    if (totalsAreLowerBound && isAggregate && options.requiresRawMessages) {
      warnings.push(
        'The aggregate records cover the whole window. Only the raw messages stop at the cap (newest first), so totals.messages is a lower bound.',
      );
    } else if (totalsAreLowerBound && !forcePaused) {
      warnings.push(
        'Sumo stopped gathering at its result cap, so totals are a lower bound. Use an aggregate (e.g. | count) for the real total.',
      );
    }

    if (options.narrowedFromMs) {
      warnings.push(
        `Narrowed the around window from ±${formatSpan(options.narrowedFromMs)} to ±${formatSpan((toMs - fromMs) / 2)}: the wider window hit Sumo's cap before it reached the event.`,
      );
    }

    // Best-effort volume-over-time buckets from the final status.
    let histogram = options.includeHistogram
      ? (status.histogramBuckets ?? [])
      : undefined;
    if (totalsAreLowerBound && histogram) {
      const trimmed = trimUnsearchedBuckets(histogram);
      const dropped = histogram.length - trimmed.length;
      histogram = trimmed;
      warnings.push(
        'The histogram only covers the newest gathered messages, so empty buckets were not searched' +
          (dropped ? `; ${dropped} empty older buckets were dropped` : '') +
          '. Use sumologic_timeline for real volume.',
      );
    }

    const buildMeta = (
      returned: { messages: number; records: number },
      rawRows: any[] = [],
    ) => {
      const recordsShort = isAggregate && returned.records < recordCount;
      const messagesShort =
        gathersRawMessages && returned.messages < messageCount;
      const truncated = recordsShort || messagesShort;
      const rawCapHit =
        messagesShort && rawLimit < limit && returned.messages >= rawLimit;

      const partialReasons: PartialReason[] = [];
      if (recordsShort || (messagesShort && !rawCapHit)) {
        partialReasons.push('limit');
      }
      if (rawCapHit) partialReasons.push('rawMessageCap');
      if (totalsAreLowerBound) partialReasons.push('sumoCap');
      if (hasSumoWarning) partialReasons.push('sumoWarning');
      if (errors.length) partialReasons.push('sumoError');
      if (options.narrowedFromMs) partialReasons.push('narrowedWindow');

      const span = returnedSpan(rawRows);
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
        totalsAreLowerBound,
        returned,
        ...(span && { returnedSpan: span }),
        truncated,
        completeness: partialReasons.length ? 'partial' : 'complete',
        partialReasons,
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
        fields: shapeFields(records.fields),
        records: records.rows.map(shape),
        ...(rawMessages && { messages: rawMessages.rows.map(shape) }),
        ...(histogram && { histogram }),
        ...(rawMessages && capNote && { note: capNote }),
        meta: buildMeta(
          {
            messages: rawMessages?.rows.length ?? 0,
            records: records.rows.length,
          },
          rawMessages?.rows,
        ),
      };
    }

    // Non-aggregate search: return the raw log messages.
    const aroundMs = options.around ? (fromMs + toMs) / 2 : undefined;
    const fetchFrom = (offset: number) =>
      fetchAllRows(
        messageCount || rawLimit,
        rawLimit,
        async (from, pageLimit) => {
          const page = await session.messages(id, {
            offset: from,
            limit: pageLimit,
          });
          return { fields: page.fields, rows: page.messages };
        },
        offset,
      );
    let startOffset =
      aroundMs !== undefined
        ? aroundOffset(
            status.histogramBuckets ?? [],
            aroundMs,
            messageCount,
            rawLimit,
          )
        : 0;
    let messages = await fetchFrom(startOffset);

    // The histogram only places the event to within a bucket. When the page
    // misses it, close in on the event's position before giving up.
    const firstSpan = returnedSpan(messages.rows);
    if (
      aroundMs !== undefined &&
      firstSpan &&
      (aroundMs < Date.parse(firstSpan.oldest) ||
        aroundMs > Date.parse(firstSpan.newest))
    ) {
      const refined = await locateAround(
        async (offset) => {
          const page = await withRetry(() =>
            session.messages(id, { offset, limit: 1 }),
          );
          const time = Number(page.messages?.[0]?.map?._messagetime);
          return Number.isFinite(time) ? time : undefined;
        },
        aroundMs,
        messageCount,
        rawLimit,
        {
          offset: startOffset,
          count: messages.rows.length,
          newest: Date.parse(firstSpan.newest),
          oldest: Date.parse(firstSpan.oldest),
        },
      );
      if (refined !== startOffset) {
        startOffset = refined;
        messages = await fetchFrom(startOffset);
      }
    }

    // A miss only when a capped search read up to the edge of what Sumo
    // gathered and the event lies beyond it.
    const span = returnedSpan(messages.rows);
    const atOldestEdge = startOffset >= Math.max(0, messageCount - rawLimit);
    const missedAround =
      aroundMs !== undefined &&
      totalsAreLowerBound &&
      (span
        ? (aroundMs < Date.parse(span.oldest) && atOldestEdge) ||
          (aroundMs > Date.parse(span.newest) && startOffset === 0)
        : messageCount > 0);

    await cleanup();

    // Sumo gathers the newest messages first, so a capped window can stop
    // before it reaches the event. Retry once with a window small enough to
    // stay under the cap at the rate this search just saw.
    if (missedAround && totalsAreLowerBound && !options.narrowedFromMs) {
      const half = (toMs - fromMs) / 2;
      const narrowHalf = narrowedHalfWidth(
        status.histogramBuckets ?? [],
        toMs,
        messageCount,
      );
      if (narrowHalf !== undefined && narrowHalf < half) {
        return runSearch(client, query, {
          ...options,
          aroundMinutes: narrowHalf / 60000,
          narrowedFromMs: half,
        });
      }
    }

    if (missedAround) {
      warnings.push(
        `The returned messages do not reach the around time (${toIso(aroundMs!)}); Sumo only gathered part of the window. Scope the query with _sourceCategory or lower aroundMinutes.`,
      );
    }

    return {
      type: 'messages',
      fields: shapeFields(messages.fields),
      messages: messages.rows.map(shape),
      ...(histogram && { histogram }),
      ...(capNote && messageCount > rawLimit && { note: capNote }),
      meta: buildMeta(
        { messages: messages.rows.length, records: 0 },
        messages.rows,
      ),
    };
  } catch (error) {
    await cleanup();
    console.error('Sumo Logic search error:', error);
    throw classifyError(error);
  }
}
