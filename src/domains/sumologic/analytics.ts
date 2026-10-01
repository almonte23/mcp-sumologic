// Higher-level analyses built on `search`. Skills repeatedly need the same
// shapes — "when did this start and how often", "is this window worse than
// yesterday", "which source categories exist" — and computing them Sumo-side
// is cheaper and more reliable than pulling raw messages and counting locally.

import * as Sumo from '@/lib/sumologic/client.js';
import {
  looksLikeAggregateQuery,
  search,
  type SearchMeta,
} from '@/domains/sumologic/client.js';
import { SumoSearchError } from '@/domains/sumologic/errors.js';
import {
  formatDuration,
  parseDuration,
  resolveWindow,
  toIso,
} from '@/utils/time.js';

const AUTO_BUCKETS = ['1m', '5m', '15m', '30m', '1h', '3h', '6h', '12h', '1d'];
const TARGET_BUCKETS = 200;
const MAX_BUCKETS = 5000;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export interface TimeBasis {
  byReceiptTime?: boolean;
  bySearchableTime?: boolean;
}

export interface TimelineOptions extends TimeBasis {
  query: string;
  from?: string;
  to?: string;
  around?: string;
  aroundMinutes?: number;
  timeZone?: string;
  // Bucket size such as `5m`, `1h`, `1d`. Chosen automatically when omitted.
  bucket?: string;
  // Split the timeline by a field (e.g. `_sourceCategory`).
  groupBy?: string;
  // Keep this many groups (by total); the rest fold into `(other)`.
  topGroups?: number;
  includeBuckets?: boolean;
}

export interface SeriesSummary {
  total: number;
  firstSeen: string | null;
  lastSeen: string | null;
  peak: { at: string; count: number } | null;
  nonZeroBuckets: number;
}

export interface TimelineResult extends SeriesSummary {
  query: string;
  window: { from: string; to: string; timeZone: string };
  bucket: string;
  bucketCount: number;
  // [bucketStartIsoUtc, count] pairs, zero-filled across the window.
  buckets?: Array<[string, number]>;
  series?: Array<
    SeriesSummary & { group: string; buckets?: Array<[string, number]> }
  >;
  meta: SearchMeta;
}

function invalid(message: string): never {
  throw new SumoSearchError(message, 'invalid_input');
}

export function assertField(field: string, label = 'field'): void {
  if (!FIELD_RE.test(field)) {
    invalid(
      `Invalid ${label} "${field}". Use a plain field name such as _sourceCategory.`,
    );
  }
}

function assertRawQuery(query: string): void {
  if (looksLikeAggregateQuery(query)) {
    invalid(
      'Pass a non-aggregate query (a filter, optionally with parse/where); ' +
        'this tool appends its own timeslice/count. Use search_sumologic for custom aggregates.',
    );
  }
}

export function chooseBucket(
  spanMs: number,
  requested?: string,
): { label: string; ms: number } {
  if (requested) {
    let ms: number;
    try {
      ms = parseDuration(requested);
    } catch (err) {
      invalid((err as Error).message);
    }
    if (ms < 1000) invalid('Bucket must be at least 1s.');
    if (spanMs / ms > MAX_BUCKETS) {
      invalid(
        `Bucket ${requested} yields ${Math.ceil(spanMs / ms)} buckets (max ${MAX_BUCKETS}). Use a larger bucket.`,
      );
    }
    // timeslice accepts s/m/h/d, so never express a bucket in weeks.
    const label =
      ms % parseDuration('1d') === 0
        ? `${ms / parseDuration('1d')}d`
        : formatDuration(ms);
    return { label, ms };
  }
  for (const label of AUTO_BUCKETS) {
    const ms = parseDuration(label);
    if (spanMs / ms <= TARGET_BUCKETS) {
      return { label, ms };
    }
  }
  return { label: '1d', ms: parseDuration('1d') };
}

const mapValue = (row: any, key: string): string | undefined => {
  const map = row?.map ?? {};
  const hit = Object.keys(map).find(
    (k) => k.toLowerCase() === key.toLowerCase(),
  );
  return hit === undefined ? undefined : map[hit];
};

function summarize(grid: number[], counts: Map<number, number>): SeriesSummary {
  let total = 0;
  let first: number | null = null;
  let last: number | null = null;
  let peak: { at: number; count: number } | null = null;
  let nonZero = 0;
  for (const t of grid) {
    const n = counts.get(t) ?? 0;
    total += n;
    if (n > 0) {
      nonZero += 1;
      first ??= t;
      last = t;
      if (!peak || n > peak.count) peak = { at: t, count: n };
    }
  }
  return {
    total,
    firstSeen: first === null ? null : toIso(first),
    lastSeen: last === null ? null : toIso(last),
    peak: peak ? { at: toIso(peak.at), count: peak.count } : null,
    nonZeroBuckets: nonZero,
  };
}

export async function timeline(
  client: Sumo.Client,
  options: TimelineOptions,
): Promise<TimelineResult> {
  assertRawQuery(options.query);
  if (options.groupBy) assertField(options.groupBy, 'groupBy');
  const timeZone = options.timeZone || 'UTC';
  let fromMs: number;
  let toMs: number;
  try {
    ({ fromMs, toMs } = resolveWindow({ ...options, timeZone }));
  } catch (err) {
    invalid((err as Error).message);
  }
  const bucket = chooseBucket(toMs - fromMs, options.bucket);

  const by = options.groupBy ? `_timeslice, ${options.groupBy}` : '_timeslice';
  const query = `${options.query} | timeslice ${bucket.label} | count by ${by}`;
  const result = await search(client, query, {
    from: String(fromMs),
    to: String(toMs),
    timeZone,
    limit: 100000,
    byReceiptTime: options.byReceiptTime,
    bySearchableTime: options.bySearchableTime,
  });

  // Zero-filled grid; any bucket Sumo aligned differently (e.g. day buckets
  // in a non-UTC zone) is merged in rather than dropped.
  const gridSet = new Set<number>();
  for (
    let t = Math.floor(fromMs / bucket.ms) * bucket.ms;
    t < toMs;
    t += bucket.ms
  ) {
    gridSet.add(t);
  }
  const perGroup = new Map<string, Map<number, number>>();
  const overall = new Map<number, number>();
  for (const row of result.records ?? []) {
    const t = Number(mapValue(row, '_timeslice'));
    const n = Number(mapValue(row, '_count') ?? 0);
    if (!Number.isFinite(t)) continue;
    gridSet.add(t);
    overall.set(t, (overall.get(t) ?? 0) + n);
    if (options.groupBy) {
      const g = mapValue(row, options.groupBy) || '(empty)';
      const m = perGroup.get(g) ?? new Map<number, number>();
      m.set(t, (m.get(t) ?? 0) + n);
      perGroup.set(g, m);
    }
  }
  const grid = [...gridSet].sort((a, b) => a - b);
  const toBuckets = (counts: Map<number, number>): Array<[string, number]> =>
    grid.map((t) => [toIso(t), counts.get(t) ?? 0]);
  const includeBuckets = options.includeBuckets ?? true;

  let series: TimelineResult['series'];
  if (options.groupBy) {
    const ranked = [...perGroup.entries()]
      .map(([group, counts]) => ({ group, counts, ...summarize(grid, counts) }))
      .sort((a, b) => b.total - a.total);
    const top = ranked.slice(0, options.topGroups ?? 10);
    const rest = ranked.slice(top.length);
    if (rest.length) {
      const other = new Map<number, number>();
      for (const r of rest) {
        for (const [t, n] of r.counts) other.set(t, (other.get(t) ?? 0) + n);
      }
      top.push({
        group: `(other: ${rest.length} groups)`,
        counts: other,
        ...summarize(grid, other),
      });
    }
    series = top.map(({ counts, ...summary }) => ({
      ...summary,
      ...(includeBuckets && { buckets: toBuckets(counts) }),
    }));
  }

  return {
    query,
    window: { from: toIso(fromMs), to: toIso(toMs), timeZone },
    bucket: bucket.label,
    bucketCount: grid.length,
    ...summarize(grid, overall),
    ...(includeBuckets && !options.groupBy && { buckets: toBuckets(overall) }),
    ...(series && { series }),
    meta: result.meta,
  };
}

export interface CompareOptions extends TimeBasis {
  query: string;
  from?: string;
  to?: string;
  around?: string;
  aroundMinutes?: number;
  timeZone?: string;
  // How far back each baseline window sits, e.g. ['24h'] (same time
  // yesterday) or ['24h', '7d']. Defaults to ['24h'].
  baselineOffsets?: string[];
  bucket?: string;
  includeBuckets?: boolean;
  // Flag a spike when window ≥ spikeRatio × baseline. Default 5.
  spikeRatio?: number;
  // When the baseline is 0, flag a spike once the window exceeds this. Default 10.
  minCountWhenNoBaseline?: number;
}

export type Verdict = 'spike' | 'drop' | 'normal';

function judge(
  count: number,
  baseline: number,
  spikeRatio: number,
  minNoBaseline: number,
): { verdict: Verdict; reason: string } {
  if (baseline === 0) {
    return count > minNoBaseline
      ? {
          verdict: 'spike',
          reason: `0 -> ${count} (> ${minNoBaseline} with no baseline)`,
        }
      : {
          verdict: 'normal',
          reason: `baseline 0, window ${count} (≤ ${minNoBaseline})`,
        };
  }
  const ratio = count / baseline;
  if (ratio >= spikeRatio) {
    return {
      verdict: 'spike',
      reason: `${ratio.toFixed(1)}x baseline (≥ ${spikeRatio}x)`,
    };
  }
  if (baseline > minNoBaseline && ratio <= 1 / spikeRatio) {
    return {
      verdict: 'drop',
      reason: `${ratio.toFixed(2)}x baseline: volume fell sharply (possible outage, ingestion gap, or stopped process)`,
    };
  }
  return { verdict: 'normal', reason: `${ratio.toFixed(2)}x baseline` };
}

export async function compareWindows(
  client: Sumo.Client,
  options: CompareOptions,
) {
  const timeZone = options.timeZone || 'UTC';
  let fromMs: number;
  let toMs: number;
  try {
    ({ fromMs, toMs } = resolveWindow({ ...options, timeZone }));
  } catch (err) {
    invalid((err as Error).message);
  }
  const offsets = options.baselineOffsets?.length
    ? options.baselineOffsets
    : ['24h'];
  const offsetMs = offsets.map((o) => {
    try {
      return parseDuration(o);
    } catch (err) {
      invalid((err as Error).message);
    }
  });
  const spikeRatio = options.spikeRatio ?? 5;
  const minNoBaseline = options.minCountWhenNoBaseline ?? 10;
  const bucket = options.bucket ?? chooseBucket(toMs - fromMs).label;
  const includeBuckets = options.includeBuckets ?? false;

  const run = (shift: number) =>
    timeline(client, {
      query: options.query,
      from: String(fromMs - shift),
      to: String(toMs - shift),
      timeZone,
      bucket,
      includeBuckets,
      byReceiptTime: options.byReceiptTime,
      bySearchableTime: options.bySearchableTime,
    });

  const [current, ...baselines] = await Promise.all([
    run(0),
    ...offsetMs.map(run),
  ]);

  const strip = ({ meta, query, ...rest }: TimelineResult) => ({
    ...rest,
    completeness: meta.completeness,
    warnings: meta.warnings,
    errors: meta.errors,
    ...(meta.hint && { hint: meta.hint }),
    uiLink: meta.links?.ui,
  });

  // Totals can look normal while one bucket explodes (a one minute error
  // storm inside a quiet hour), so compare the busiest buckets as well.
  const judgePeak = (base: TimelineResult) => {
    const now = current.peak?.count ?? 0;
    const then = base.peak?.count ?? 0;
    if (then === 0) {
      return {
        peakRatio: null,
        burst: now > minNoBaseline,
        burstReason: `busiest ${bucket}: ${now} vs 0`,
      };
    }
    const ratio = now / then;
    return {
      peakRatio: Number(ratio.toFixed(3)),
      burst: ratio >= spikeRatio,
      burstReason: `busiest ${bucket}: ${now} vs ${then} (${ratio.toFixed(1)}x)`,
    };
  };

  const comparisons = baselines.map((b, i) => {
    const { verdict, reason } = judge(
      current.total,
      b.total,
      spikeRatio,
      minNoBaseline,
    );
    return {
      offset: offsets[i],
      ratio:
        b.total === 0 ? null : Number((current.total / b.total).toFixed(3)),
      delta: current.total - b.total,
      verdict,
      reason,
      ...judgePeak(b),
      baseline: strip(b),
    };
  });

  const peakRatios = comparisons.map((c) => c.peakRatio ?? Infinity);
  const burst =
    comparisons.length && comparisons.every((c) => c.burst) && current.peak
      ? {
          at: current.peak.at,
          count: current.peak.count,
          reason: `busiest ${bucket} at ${current.peak.at} had ${current.peak.count}, ${
            Number.isFinite(Math.min(...peakRatios))
              ? `${Math.min(...peakRatios).toFixed(1)}x`
              : 'far above'
          } every baseline's busiest ${bucket}`,
        }
      : null;

  const verdicts = comparisons.map((c) => c.verdict);
  const overall: Verdict = verdicts.every((v) => v === 'spike')
    ? 'spike'
    : verdicts.every((v) => v === 'drop')
      ? 'drop'
      : 'normal';

  const partial = [current, ...baselines].some(
    (r) => r.meta.completeness === 'partial',
  );

  return {
    query: current.query,
    rule: {
      spikeRatio,
      minCountWhenNoBaseline: minNoBaseline,
      overall: 'spike/drop only when every baseline agrees',
      burst: `busiest bucket >= spikeRatio x every baseline's busiest bucket`,
    },
    verdict: overall,
    burst,
    ...(partial && {
      caution:
        'At least one window returned partial results (see warnings/errors); treat the verdict as provisional.',
    }),
    window: strip(current),
    comparisons,
  };
}

export interface DiscoverOptions extends TimeBasis {
  // Scope to search within, e.g. `_index=Production` or `*`.
  scope?: string;
  groupBy?: string;
  from?: string;
  to?: string;
  timeZone?: string;
  limit?: number;
}

export async function discoverValues(
  client: Sumo.Client,
  options: DiscoverOptions,
) {
  const scope = options.scope?.trim() || '*';
  assertRawQuery(scope);
  const field = options.groupBy || '_sourceCategory';
  assertField(field, 'groupBy');
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const query = `${scope} | count by ${field} | sort by _count | limit ${limit}`;
  const result = await search(client, query, {
    from: options.from ?? '-1h',
    to: options.to,
    timeZone: options.timeZone,
    limit,
    byReceiptTime: options.byReceiptTime,
    bySearchableTime: options.bySearchableTime,
  });
  const values = (result.records ?? []).map((row) => ({
    value: mapValue(row, field) ?? '',
    count: Number(mapValue(row, '_count') ?? 0),
  }));
  return { field, scope, values, meta: result.meta };
}
