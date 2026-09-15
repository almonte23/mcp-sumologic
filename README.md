[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/samwang0723-mcp-sumologic-badge.png)](https://mseep.ai/app/samwang0723-mcp-sumologic)

# MCP Sumo Logic

A Model Context Protocol (MCP) server that integrates with Sumo Logic's API to perform log searches.

## Features

- Search Sumo Logic logs using custom queries
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
| `from` | string, optional | Start time, ISO 8601. Interpreted in `timeZone` when it has no offset. Defaults to 24 hours ago. |
| `to` | string, optional | End time, ISO 8601. Defaults to now. |
| `timeZone` | string, optional | IANA time zone for `from`/`to` when they carry no offset. Defaults to `UTC`. |
| `limit` | int, optional | Max rows to return (1–100000). Defaults to 100. Rows beyond a single 10000 row page are paginated. Raw messages are capped (see `allowLargeResult`). |
| `byReceiptTime` | bool, optional | Search by the time logs were received rather than their own timestamp. Useful for ingestion-lag debugging. |
| `bySearchableTime` | bool, optional | Search by indexed (searchable) time rather than message timestamp. |
| `autoParsingMode` | `AutoParse` \| `Manual`, optional | `AutoParse` auto-extracts fields from JSON logs (including nested, e.g. `payload.status`). Defaults to `Manual`. |
| `requiresRawMessages` | bool, optional | For aggregate queries, also return the raw messages behind the aggregation under `messages` (one job instead of two). |
| `includeHistogram` | bool, optional | Also return volume-over-time buckets under `histogram`. |
| `allowLargeResult` | bool, optional | Return more than 2000 raw messages. Off by default because a large raw payload can drop the connection. Aggregate records are never capped. |

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

The server includes comprehensive error handling and logging:
- API errors are caught and logged with details
- Search job status is monitored and logged
- Network and authentication issues are properly handled

## Development

To run in development mode:
```bash
npm run dev
```

For testing:
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
