[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/samwang0723-mcp-sumologic-badge.png)](https://mseep.ai/app/samwang0723-mcp-sumologic)

# MCP Sumo Logic

A Model Context Protocol (MCP) server that integrates with Sumo Logic's API to perform log searches.

## Features

- Search Sumo Logic logs using custom queries
- Analysis tools built for AI skills: occurrence timelines, window-vs-baseline spike/drop detection, source discovery
- Discovery and context tools: indexes, fields, ingestion health events, triggered monitors, saved searches, scheduled views, scan-cost estimates, metrics queries
- Every search returns `meta` (job id, resolved window, totals vs returned, truncation, Sumo warnings/errors, UI link) so callers can tell a quiet window from a failed or partial search
- Relative times (`-90m`, `-60d`), epoch millis, and `around` a timestamp
- Process-wide rate limiting (Sumo allows 4 req/s, 10 in flight) and a cookie session per search, so parallel searches don't collide
- Aggregate queries (`count`, `sum`, `avg`, `by`, `timeslice`, ...) return grouped records
- Configurable time ranges, with a `timeZone` that defaults to UTC
- Search by message, receipt, or searchable time
- AutoParse for automatic JSON field extraction
- Pagination past the 10000 row page limit (up to 100000 rows)
- Optional raw messages behind an aggregate, and optional volume histogram
- Automatic retry with backoff on rate limits (429) and transient 5xx
- Raw message payload safeguard to protect the connection
- PII masking on log bodies
- Error handling and detailed logging
- Docker support for easy deployment

## Environment Variables

```env
ENDPOINT=https://{host}/api/v1  # Sumo Logic API endpoint
SUMO_API_ID=your_api_id                       # Sumo Logic API ID
SUMO_API_KEY=your_api_key                     # Sumo Logic API Key
```

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `SUMO_SEARCH_TIMEOUT_MS` | `300000` | How long a search job may run before giving up. Raise for long lookbacks. |
| `SUMO_MESSAGE_CAP` | `200000` | Raw messages Sumo gathers before it stops. At or above this, `totalsAreLowerBound` is set. Change only if Sumo changes its cap. |
| `SUMO_MAX_REQUESTS_PER_SECOND` | `4` | Client-side pacing of Sumo API calls. |
| `SUMO_MAX_IN_FLIGHT` | `10` | Max concurrent Sumo API calls. |
| `SUMO_UI_URL` | derived from `ENDPOINT` | Base URL for UI links in `meta.links.ui` (e.g. `https://service.us2.sumologic.com`). `off` disables links. |

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the required environment variables
4. Build the project:
   ```bash
   npm run build
   ```
5. Start the server:
   ```bash
   npm start
   ```

## Docker Setup

1. Build the Docker image:
   ```bash
   docker build -t mcp/sumologic .
   ```

2. Run the container (choose one method):

   a. Using environment variables directly:
   ```bash
   docker run -e ENDPOINT=your_endpoint -e SUMO_API_ID=your_api_id -e SUMO_API_KEY=your_api_key mcp/sumologic
   ```

   b. Using a .env file:
   ```bash
   docker run --env-file .env mcp/sumologic
   ```

   Note: Make sure your .env file contains the required environment variables:
   ```env
   ENDPOINT=your_endpoint
   SUMO_API_ID=your_api_id
   SUMO_API_KEY=your_api_key
   ```

## Transport

The server speaks MCP over Streamable HTTP by default (Express on `PORT`, default 3006). Set `MCP_TRANSPORT=stdio` to run it over stdio instead, which is what MCP clients that spawn the process (Claude Code / Claude Desktop) use.

## Usage

The server exposes a `search_sumologic` tool. The response always carries a `type` field (`"messages"` for raw searches, `"records"` for aggregates), a `fields` column list, and the matching rows under `messages` or `records`.

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `query` | string, required | Sumo Logic search query. Aggregate operators (`count`, `sum`, `avg`, `by`, `timeslice`, ...) are supported and return `records`. |
| `from` | string, optional | Start time: ISO 8601 (interpreted in `timeZone` when it has no offset), epoch millis, or relative (`-15m`, `-24h`, `-60d`). Defaults to 24 hours ago. |
| `to` | string, optional | End time, same formats plus `now`. Defaults to now. |
| `around` | string, optional | Center the window on this instant instead of `from`/`to`. Raw messages are read from the event's position, not the newest end of the window. If Sumo's cap stops it before the event, the search retries once with a narrower window (`partialReasons` then includes `narrowedWindow`). |
| `aroundMinutes` | number, optional | Half-width of the `around` window. Defaults to 5 (±5 min). |
| `timeZone` | string, optional | IANA time zone for `from`/`to` when they carry no offset. Defaults to `UTC`. |
| `limit` | int, optional | Max rows to return (1–100000). Defaults to 100. Rows beyond a single 10000 row page are paginated. Raw messages are capped (see `allowLargeResult`). |
| `byReceiptTime` | bool, optional | Search by the time logs were received rather than their own timestamp. Useful for ingestion-lag debugging. |
| `bySearchableTime` | bool, optional | Search by indexed (searchable) time rather than message timestamp. |
| `autoParsingMode` | `AutoParse` \| `Manual`, optional | `AutoParse` auto-extracts fields from JSON logs (including nested, e.g. `payload.status`). Defaults to `Manual`. |
| `requiresRawMessages` | bool, optional | For aggregate queries, also return the raw messages behind the aggregation under `messages` (one job instead of two). |
| `includeHistogram` | bool, optional | Also return volume-over-time buckets under `histogram`. On a capped search, empty buckets older than the gathered messages are dropped (they were never searched). |
| `allowLargeResult` | bool, optional | Return more than 2000 raw messages. Off by default because a large raw payload can drop the connection. Aggregate records are never capped. |
| `returnFields` | string[], optional | Keep only these keys in each row `map` and in `fields` (case-insensitive), e.g. `["_messagetime", "_sourcecategory", "_raw"]`. |

### Response `meta`

Every `search_sumologic` response includes a `meta` object alongside the existing keys:

```jsonc
{
  "jobId": "4A1B...",                     // unique per search
  "query": "...",
  "window": { "from": "2026-09-29T21:00:00.000Z", "to": "...", "timeZone": "UTC", "timeBasis": "messageTime" },
  "state": "DONE GATHERING RESULTS",
  "totals":   { "messages": 5432, "records": 0 },   // what Sumo matched
  "totalsAreLowerBound": false,           // true when Sumo stopped counting at its cap
  "hint": "...",                          // only when a _sourceCategory scoped search matched nothing
  "returned": { "messages": 100,  "records": 0 },   // what this response carries
  "returnedSpan": { "newest": "2026-09-29T21:59:58.120Z", "oldest": "2026-09-29T21:59:41.003Z" }, // raw messages only
  "truncated": true,
  "completeness": "partial",              // "complete" only with no truncation, warnings, errors or FORCE PAUSED
  "partialReasons": ["limit"],            // limit | rawMessageCap | sumoCap | sumoWarning | sumoError | narrowedWindow
  "warnings": [], "errors": [],
  "elapsedMs": 2140,
  "links": { "ui": "https://service.sumologic.com/ui/#/search/create?query=..." }
}
```

Failed calls return `isError: true` with a classified `kind` (`rate_limited`, `auth`, `invalid_query`, `invalid_input`, `timeout`, ...), `retryable` and a hint. A failure is never shown as an empty result.

## Additional tools

All read-only.

| Tool | What it answers |
|---|---|
| `sumologic_timeline` | When did it start, how often, when did it peak? Zero-filled `timeslice` counts computed Sumo-side, with `firstSeen`/`lastSeen`/`peak`; optional `groupBy`. |
| `sumologic_compare_windows` | Is this window worse than usual? Same query over the window and baseline windows shifted by `baselineOffsets` (default `24h`), with a `spike`/`drop`/`normal` verdict on totals, plus `burst` when the busiest bucket is `spikeRatio`× every baseline's busiest bucket (a short storm inside a normal total). |
| `sumologic_discover_sources` | Which `_sourceCategory` (or host, collector, any field) values exist under a scope, with counts. |
| `sumologic_list_indexes` | Partitions searchable with `_index=`, with routing, tier and retention. |
| `sumologic_list_fields` | Built-in and custom (indexed) field names. |
| `sumologic_health_events` | Unresolved collector/source/ingestion problems, to tell missing data apart from a quiet window. |
| `sumologic_search_monitors` | Monitors by status (default: currently triggered), including their queries. |
| `sumologic_list_saved_searches` | Saved searches, filterable by text. |
| `sumologic_list_scheduled_views` | Pre-aggregated views for cheap long-range trends. |
| `sumologic_estimate_scan` | How much data a query would scan, per tier, without running it. |
| `sumologic_query_metrics` | Sumo metrics queries, for when metrics are ingested into Sumo. |

Examples:

```jsonc
// sumologic_timeline: hourly occurrences of an error across 14 days, split by source category
{ "query": "_index=Production \"NoMethodError\"", "from": "-14d", "bucket": "1h", "groupBy": "_sourceCategory" }

// sumologic_compare_windows: error-log spike vs same time yesterday and last week
{ "query": "_sourceCategory=prod/portal/worker \"work pool full\"",
  "from": "2026-09-29T17:00:00", "to": "2026-09-29T18:00:00", "timeZone": "America/New_York",
  "baselineOffsets": ["24h", "7d"] }

// search_sumologic: everything ±5 minutes around one event
{ "query": "_index=Production", "around": "2026-09-29T21:14:03Z", "returnFields": ["_messagetime", "_sourcecategory", "_raw"] }
```

### Examples

Aggregate, grouped by hour:
```jsonc
{ "query": "_sourceCategory=prod/* error | timeslice 1h | count by _timeslice",
  "from": "2026-09-15T09:00:00", "to": "2026-09-15T15:00:00", "timeZone": "UTC" }
```

Receipt-time search for ingestion lag:
```jsonc
{ "query": "_sourceCategory=prod/portal/web", "byReceiptTime": true, "limit": 10 }
```

AutoParse then break down by a nested JSON field:
```jsonc
{ "query": "_sourceCategory=prod/portal/web | count by status",
  "autoParsingMode": "AutoParse" }
```

Aggregate plus the raw lines behind it:
```jsonc
{ "query": "_sourceCategory=prod/portal/web error | count by _sourcehost",
  "requiresRawMessages": true, "limit": 20 }
```

Volume histogram:
```jsonc
{ "query": "_sourceCategory=prod/portal/web error", "includeHistogram": true, "limit": 1 }
```

Large raw pull (explicit opt-in):
```jsonc
{ "query": "_sourceCategory=prod/portal/web", "limit": 15000, "allowLargeResult": true }
```

Programmatic use:
```typescript
const results = await search(sumoClient, "_sourceCategory=prod/* | count by _sourceCategory", {
  from: "2026-09-08T00:00:00",
  to: "2026-09-15T00:00:00",
  timeZone: "UTC",
});
```

## Error Handling

- Transient failures (429, 502/503/504, dropped sockets) are retried with exponential backoff, honoring `Retry-After`
- Search jobs are always deleted, even when fetching results fails
- Sumo `pendingWarnings`/`pendingErrors` are accumulated across polls and returned in `meta`
- Errors are returned with `isError: true`, a classified `kind`, and a remediation hint

## Development

To run in development mode:
```bash
npm run dev
```

For testing (Node's built-in test runner via `tsx`, no credentials needed; Sumo is faked in `test/fakeSumo.ts`):
```bash
npm test
```

## Makefile

Common tasks are available via `make`:

| Command              | Description                                  |
|----------------------|----------------------------------------------|
| `make install`       | Install dependencies                         |
| `make build`         | Build the project                            |
| `make start`         | Start the server                             |
| `make dev`           | Start in development mode (auto-reload)      |
| `make clean`         | Remove `dist/` and `node_modules/`           |
| `make lint`          | Run ESLint                                   |
| `make test`          | Run tests                                    |
| `make docker-build`  | Build Docker image                           |
| `make docker-run`    | Run container with `.env` file on port 3006  |
| `make docker-compose`| Start services via Docker Compose            |
| `make docker-down`   | Stop Docker Compose services                 | 
