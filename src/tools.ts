import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as Sumo from '@/lib/sumologic/client.js';
import {
  compareWindows,
  discoverValues,
  timeline,
} from '@/domains/sumologic/analytics.js';
import {
  estimateScan,
  listFields,
  listHealthEvents,
  listIndexes,
  listSavedSearches,
  listScheduledViews,
  queryMetrics,
  searchMonitors,
} from '@/domains/sumologic/catalog.js';
import { formatToolError } from '@/domains/sumologic/errors.js';
import { toJsonText } from '@/utils/json.js';

export const EXTRA_TOOLS = [
  'sumologic_timeline',
  'sumologic_compare_windows',
  'sumologic_discover_sources',
  'sumologic_list_indexes',
  'sumologic_list_fields',
  'sumologic_health_events',
  'sumologic_search_monitors',
  'sumologic_list_saved_searches',
  'sumologic_list_scheduled_views',
  'sumologic_estimate_scan',
  'sumologic_query_metrics',
] as const;

const TIME_FORMATS =
  'ISO 8601 (wall-clock in `timeZone`, or with Z/offset), epoch millis, "now", or relative like "-15m", "-24h", "-60d"';

export const timeParams = {
  from: z.string().optional().describe(`Window start. ${TIME_FORMATS}.`),
  to: z
    .string()
    .optional()
    .describe(`Window end. Same formats as from. Defaults to now.`),
  timeZone: z
    .string()
    .optional()
    .describe(
      'IANA time zone for wall-clock from/to (e.g. "America/New_York"). Defaults to UTC.',
    ),
};

export const aroundParams = {
  around: z
    .string()
    .optional()
    .describe(
      `Center the window on this instant instead of from/to (e.g. an error timestamp). ${TIME_FORMATS}.`,
    ),
  aroundMinutes: z
    .number()
    .positive()
    .max(24 * 60)
    .optional()
    .describe(
      'Half-width of the `around` window in minutes. Defaults to 5 (±5 min).',
    ),
};

const timeBasisParams = {
  byReceiptTime: z
    .boolean()
    .optional()
    .describe(
      'Use receipt (ingest) time instead of message time; helps during ingestion delays.',
    ),
  bySearchableTime: z
    .boolean()
    .optional()
    .describe('Use searchable (indexed) time.'),
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

type Handler<A> = (args: A) => Promise<unknown>;

const respond =
  <A>(fn: Handler<A>) =>
  async (args: A) => {
    try {
      const result = await fn(args);
      return {
        content: [{ type: 'text' as const, text: toJsonText(result) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: formatToolError(err) }],
      };
    }
  };

export function registerExtraTools(
  server: McpServer,
  client: Sumo.Client,
): void {
  server.registerTool(
    'sumologic_timeline',
    {
      title: 'Occurrence timeline',
      description:
        'Count matching log messages over time in zero-filled buckets, computed Sumo-side (no raw ' +
        'messages transferred). Answers "when did it start / is it growing / when did it peak": ' +
        'returns total, firstSeen, lastSeen, peak, nonZeroBuckets and [bucketStartUtc, count] pairs. ' +
        'Optional groupBy splits it per source category, host, etc. Pass a NON-aggregate query ' +
        '(filters, optionally parse/where); the tool appends `| timeslice | count`. ' +
        'firstSeen means first seen within the window, so widen the window to confirm a true start.',
      inputSchema: {
        query: z
          .string()
          .describe(
            'Non-aggregate filter query, e.g. `_index=Production "NoMethodError"`.',
          ),
        ...timeParams,
        ...aroundParams,
        bucket: z
          .string()
          .optional()
          .describe(
            'Bucket size such as "1m", "5m", "1h", "1d". Auto-chosen (~≤200 buckets) when omitted.',
          ),
        groupBy: z
          .string()
          .optional()
          .describe(
            'Split into one series per value of this field, e.g. "_sourceCategory".',
          ),
        topGroups: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            'Series to keep when grouping (default 10); the rest fold into "(other)".',
          ),
        includeBuckets: z
          .boolean()
          .optional()
          .describe(
            'Include per-bucket counts (default true). Set false for summary only.',
          ),
        ...timeBasisParams,
      },
      annotations: READ_ONLY,
    },
    respond((args) => timeline(client, args)),
  );

  server.registerTool(
    'sumologic_compare_windows',
    {
      title: 'Compare window to baseline',
      description:
        'Count matches in a window and in the same-length baseline window(s) shifted back by ' +
        'baselineOffsets (default "24h" = same clock time yesterday; e.g. ["24h","7d"]). Returns ' +
        'totals, ratio, delta and a verdict: "spike" (≥ spikeRatio× baseline, or baseline 0 and ' +
        '> minCountWhenNoBaseline), "drop" (volume collapsed, e.g. a process stopped logging) or ' +
        '"normal". Built for error-log signals that never show up as slow transactions. Pass a ' +
        'NON-aggregate query; all windows run in parallel.',
      inputSchema: {
        query: z
          .string()
          .describe(
            'Non-aggregate filter query, e.g. `_sourceCategory=prod/portal/worker "lock timeout"`.',
          ),
        ...timeParams,
        ...aroundParams,
        baselineOffsets: z
          .array(z.string())
          .max(5)
          .optional()
          .describe(
            'How far back each baseline sits, e.g. ["24h"] or ["24h","7d"]. Defaults to ["24h"].',
          ),
        bucket: z
          .string()
          .optional()
          .describe('Bucket size for per-bucket shape (auto when omitted).'),
        includeBuckets: z
          .boolean()
          .optional()
          .describe(
            'Include per-bucket counts for every window (default false).',
          ),
        spikeRatio: z
          .number()
          .positive()
          .optional()
          .describe('Spike threshold ratio (default 5).'),
        minCountWhenNoBaseline: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'With a zero baseline, flag a spike above this count (default 10).',
          ),
        ...timeBasisParams,
      },
      annotations: READ_ONLY,
    },
    respond((args) => compareWindows(client, args)),
  );

  server.registerTool(
    'sumologic_discover_sources',
    {
      title: 'Discover sources',
      description:
        'List the values of a metadata field with message counts, e.g. which _sourceCategory values ' +
        'exist under `_index=PreProduction`, or which hosts log a given error. Use this instead of ' +
        'guessing source categories. Defaults: scope "*", groupBy "_sourceCategory", last 1 hour.',
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe(
            'Non-aggregate scope, e.g. `_index=Production` or `_sourceCategory=*portal*`. Default "*".',
          ),
        groupBy: z
          .string()
          .optional()
          .describe(
            'Field to enumerate: _sourceCategory (default), _sourceHost, _sourceName, _collector, _source, or any parsed/custom field.',
          ),
        ...timeParams,
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max values (default 100), highest count first.'),
        ...timeBasisParams,
      },
      annotations: READ_ONLY,
    },
    respond((args) =>
      discoverValues(client, { ...args, from: args.from ?? '-1h' }),
    ),
  );

  server.registerTool(
    'sumologic_list_indexes',
    {
      title: 'List indexes',
      description:
        'List the partitions (indexes) searchable with `_index=<name>`, with routing expression, tier and retention. ' +
        'Use it to map an environment to its index and confirm how far back data is retained.',
      inputSchema: {
        includeAudit: z
          .boolean()
          .optional()
          .describe('Also list internal audit indexes.'),
      },
      annotations: READ_ONLY,
    },
    respond(({ includeAudit }) => listIndexes(client, includeAudit)),
  );

  server.registerTool(
    'sumologic_list_fields',
    {
      title: 'List fields',
      description:
        'List built-in and custom (indexed) field names. Custom fields can be used directly in the search scope, ' +
        'which is faster than parsing them out of messages.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    respond(() => listFields(client)),
  );

  server.registerTool(
    'sumologic_health_events',
    {
      title: 'Ingestion health events',
      description:
        'List unresolved collector/source/ingestion health events. Check this when a search is ' +
        'unexpectedly empty or low: missing data is not the same as a quiet window.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max events (default 200).'),
      },
      annotations: READ_ONLY,
    },
    respond(({ limit }) => listHealthEvents(client, limit)),
  );

  server.registerTool(
    'sumologic_search_monitors',
    {
      title: 'Search monitors',
      description:
        'Search Sumo Logic monitors (alerts). Defaults to currently triggered ones (`monitorStatus:AllTriggered`). ' +
        "Returns name, status, path and each monitor's query, which is a vetted query you can reuse in a search. " +
        'Filters: monitorStatus:(Normal|Critical|Warning|MissingData|Disabled|AllTriggered), free text, modifiedAfter:<ms>.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Monitor search query. Default "monitorStatus:AllTriggered".',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max monitors (default 100).'),
      },
      annotations: READ_ONLY,
    },
    respond(({ query, limit }) => searchMonitors(client, query, limit)),
  );

  server.registerTool(
    'sumologic_list_saved_searches',
    {
      title: 'List saved searches',
      description:
        'List saved log searches visible to the API user, optionally filtered by text in name/description/query. ' +
        'Saved searches are queries the team already trusts: reuse them instead of writing one from scratch.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Case-insensitive text to match.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max to scan (default 200).'),
      },
      annotations: READ_ONLY,
    },
    respond(({ filter, limit }) => listSavedSearches(client, filter, limit)),
  );

  server.registerTool(
    'sumologic_list_scheduled_views',
    {
      title: 'List scheduled views',
      description:
        'List scheduled views: pre-aggregated indexes that make long-range trend queries fast and cheap ' +
        '(query with `_view=<indexName>`). Check here before running a 30–90 day aggregate over raw logs.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Max views (default 200).'),
      },
      annotations: READ_ONLY,
    },
    respond(({ limit }) => listScheduledViews(client, limit)),
  );

  server.registerTool(
    'sumologic_estimate_scan',
    {
      title: 'Estimate scan size',
      description:
        'Estimate how much data a log search would scan (per tier / metering type) without running it. ' +
        'Use before long windows (e.g. 60 days) or broad scopes; if large, narrow _index/_sourceCategory or the window.',
      inputSchema: {
        query: z.string().describe('The log search query to estimate.'),
        ...timeParams,
        byReceiptTime: timeBasisParams.byReceiptTime,
      },
      annotations: READ_ONLY,
    },
    respond((args) => estimateScan(client, args)),
  );

  server.registerTool(
    'sumologic_query_metrics',
    {
      title: 'Query metrics',
      description:
        'Run Sumo Logic metrics queries (not log searches) and return time series. Each query is a metrics ' +
        'expression such as `metric=CPU_Total _sourceCategory=prod/* | avg by _sourceHost`. Only useful when ' +
        'metrics are ingested into Sumo Logic. Defaults to the last hour.',
      inputSchema: {
        queries: z
          .array(
            z.object({
              query: z.string().describe('Metrics query.'),
              rowId: z
                .string()
                .regex(/^[A-Z]$/)
                .optional()
                .describe('Row letter A–Z (auto-assigned).'),
              quantization: z
                .string()
                .optional()
                .describe('Bucket size, e.g. "1m", "5m".'),
              rollup: z
                .enum(['Avg', 'Sum', 'Min', 'Max', 'Count', 'None'])
                .optional(),
            }),
          )
          .min(1)
          .max(26),
        ...timeParams,
      },
      annotations: READ_ONLY,
    },
    respond((args) => queryMetrics(client, args)),
  );
}
