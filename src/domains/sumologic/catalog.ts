// Read-only wrappers over Sumo Logic management APIs (see
// src/docs/sumologic-api-1.0.0.yaml). They answer the questions a skill has
// before and around a search: which indexes and fields exist, whether
// ingestion is healthy, which monitors are firing, and what a query will scan.

import * as Sumo from '@/lib/sumologic/client.js';
import { classifyError, SumoSearchError } from '@/domains/sumologic/errors.js';
import { withRetry } from '@/domains/sumologic/client.js';
import {
  formatBytes,
  parseDuration,
  resolveWindow,
  toIso,
} from '@/utils/time.js';

const call = async <T>(fn: () => PromiseLike<T>): Promise<T> => {
  try {
    return await withRetry(fn);
  } catch (err) {
    throw classifyError(err);
  }
};

// Follow `next` continuation tokens until `max` items are collected.
async function collectPages(
  client: Sumo.Client,
  path: string,
  max: number,
  pageSize: number,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<{ items: any[]; more: boolean }> {
  const items: any[] = [];
  let token: string | undefined;
  do {
    const page: any = await call(() =>
      client.getJson(path, {
        ...query,
        limit: Math.min(pageSize, max - items.length),
        token,
      }),
    );
    const data = Array.isArray(page?.data)
      ? page.data
      : (Object.values(page ?? {}).find(Array.isArray) ?? []);
    items.push(...(data as any[]));
    token = page?.next ?? undefined;
  } while (token && items.length < max);
  return { items: items.slice(0, max), more: Boolean(token) };
}

const pick = (obj: any, keys: string[]) =>
  Object.fromEntries(
    keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]),
  );

export async function listIndexes(client: Sumo.Client, includeAudit = false) {
  const viewTypes = includeAudit
    ? 'DefaultView,Partition,AuditIndex'
    : 'DefaultView,Partition';
  const { items, more } = await collectPages(
    client,
    '/partitions',
    1000,
    1000,
    { viewTypes },
  );
  return {
    note: 'Search an index with `_index=<name>` (alias `_view`). routingExpression shows which data lands in it.',
    indexes: items.map((p) => ({
      ...pick(p, [
        'name',
        'routingExpression',
        'analyticsTier',
        'retentionPeriod',
        'isActive',
        'indexType',
      ]),
      ...(p.totalBytes !== undefined && {
        totalSize: formatBytes(p.totalBytes),
      }),
    })),
    more,
  };
}

export async function listScheduledViews(client: Sumo.Client, max = 200) {
  const { items, more } = await collectPages(
    client,
    '/scheduledViews',
    max,
    100,
  );
  return {
    note: 'Scheduled views hold pre-aggregated data; query one with `_view=<indexName>` for fast, cheap long-range trends.',
    scheduledViews: items.map((v) => ({
      ...pick(v, [
        'indexName',
        'query',
        'startTime',
        'retentionPeriod',
        'status',
        'dataForwardingId',
      ]),
      ...(v.totalBytes !== undefined && {
        totalSize: formatBytes(v.totalBytes),
      }),
      ...(v.totalMessageCount !== undefined && {
        totalMessageCount: v.totalMessageCount,
      }),
    })),
    more,
  };
}

export async function listFields(client: Sumo.Client) {
  const [custom, builtin]: any[] = await Promise.all([
    call(() => client.getJson('/fields')),
    call(() => client.getJson('/fields/builtin')),
  ]);
  return {
    note: 'Custom fields are indexed metadata usable directly as search scope (e.g. `cluster=prod`), which is faster than parsing.',
    builtin: (builtin?.data ?? []).map((f: any) => f.fieldName),
    custom: (custom?.data ?? []).map((f: any) =>
      pick(f, ['fieldName', 'dataType', 'state']),
    ),
  };
}

export async function listHealthEvents(client: Sumo.Client, max = 200) {
  const { items, more } = await collectPages(
    client,
    '/healthEvents',
    max,
    1000,
  );
  return {
    note: 'Unresolved collector/source/ingest health events. If a source feeding your query is unhealthy, an empty or low-volume result may be missing data rather than a quiet window.',
    count: items.length,
    events: items.map((e) =>
      pick(e, [
        'eventName',
        'severityLevel',
        'subsystem',
        'eventTime',
        'resourceIdentity',
        'details',
      ]),
    ),
    more,
  };
}

export async function searchMonitors(
  client: Sumo.Client,
  query = 'monitorStatus:AllTriggered',
  limit = 100,
) {
  const rows: any[] = await call(() =>
    client.getJson('/monitors/search', {
      query,
      limit: Math.min(Math.max(limit, 1), 1000),
    }),
  );
  return {
    query,
    monitors: (rows ?? []).map((r) => ({
      path: r.path,
      ...pick(r.item ?? {}, [
        'id',
        'name',
        'description',
        'type',
        'contentType',
        'monitorType',
        'status',
        'isDisabled',
        'alertName',
        'modifiedAt',
      ]),
      ...(r.item?.queries && {
        queries: r.item.queries.map((q: any) => pick(q, ['rowId', 'query'])),
      }),
    })),
  };
}

export async function listSavedSearches(
  client: Sumo.Client,
  filter?: string,
  max = 200,
) {
  const { items, more } = await collectPages(client, '/logSearches', max, 100);
  const needle = filter?.toLowerCase();
  const matches = items.filter(
    (s) =>
      !needle ||
      [s.name, s.description, s.queryString].some((v) =>
        v?.toLowerCase().includes(needle),
      ),
  );
  return {
    savedSearches: matches.map((s) =>
      pick(s, [
        'id',
        'name',
        'description',
        'queryString',
        'timeRange',
        'parsingMode',
        'modifiedAt',
      ]),
    ),
    more,
  };
}

export interface EstimateOptions {
  query: string;
  from?: string;
  to?: string;
  timeZone?: string;
  byReceiptTime?: boolean;
}

export async function estimateScan(
  client: Sumo.Client,
  options: EstimateOptions,
) {
  const timeZone = options.timeZone || 'UTC';
  let fromMs: number;
  let toMs: number;
  try {
    ({ fromMs, toMs } = resolveWindow({ ...options, timeZone }));
  } catch (err) {
    throw new SumoSearchError((err as Error).message, 'invalid_input');
  }
  const body = {
    queryString: options.query,
    timeRange: {
      type: 'BeginBoundedTimeRange',
      from: { type: 'EpochTimeRangeBoundary', epochMillis: fromMs },
      to: { type: 'EpochTimeRangeBoundary', epochMillis: toMs },
    },
    timezone: timeZone,
    runByReceiptTime: Boolean(options.byReceiptTime),
  };
  const res: any = await call(() =>
    client.postJson('/logSearches/estimatedUsageByMeteringType', body),
  );
  const details: any[] = res?.estimatedUsageDetails ?? [];
  const totalBytes = details.reduce(
    (sum, d) => sum + (d.dataScannedInBytes ?? 0),
    0,
  );
  const chargedBytes = details
    .filter((d) => d.scanCreditAccounted)
    .reduce((sum, d) => sum + (d.dataScannedInBytes ?? 0), 0);
  return {
    query: options.query,
    window: { from: toIso(fromMs), to: toIso(toMs), timeZone },
    totalScan: formatBytes(totalBytes),
    totalScanBytes: totalBytes,
    chargedPerScan: formatBytes(chargedBytes),
    note: 'chargedPerScan is data in tiers billed per scan (e.g. Infrequent/Flex). Narrow _index/_sourceCategory or the window if it is large.',
    byMeteringType: details.map((d) => ({
      ...pick(d, ['tier', 'meteringType', 'scanCreditAccounted']),
      scan: formatBytes(d.dataScannedInBytes ?? 0),
    })),
  };
}

export interface MetricsOptions {
  queries: Array<{
    query: string;
    rowId?: string;
    quantization?: string;
    rollup?: string;
  }>;
  from?: string;
  to?: string;
  timeZone?: string;
}

export async function queryMetrics(
  client: Sumo.Client,
  options: MetricsOptions,
) {
  const timeZone = options.timeZone || 'UTC';
  let fromMs: number;
  let toMs: number;
  try {
    ({ fromMs, toMs } = resolveWindow({
      ...options,
      defaultLookbackMs: 60 * 60 * 1000,
      timeZone,
    }));
  } catch (err) {
    throw new SumoSearchError((err as Error).message, 'invalid_input');
  }
  let queries;
  try {
    queries = options.queries.map((q, i) => ({
      rowId: q.rowId ?? String.fromCharCode(65 + i),
      query: q.query,
      ...(q.quantization && { quantization: parseDuration(q.quantization) }),
      ...(q.rollup && { rollup: q.rollup }),
    }));
  } catch (err) {
    throw new SumoSearchError((err as Error).message, 'invalid_input');
  }
  const body = {
    queries,
    timeRange: {
      type: 'BeginBoundedTimeRange',
      from: { type: 'EpochTimeRangeBoundary', epochMillis: fromMs },
      to: { type: 'EpochTimeRangeBoundary', epochMillis: toMs },
    },
  };
  const res: any = await call(() => client.postJson('/metricsQueries', body));
  return {
    window: { from: toIso(fromMs), to: toIso(toMs), timeZone },
    ...res,
  };
}
