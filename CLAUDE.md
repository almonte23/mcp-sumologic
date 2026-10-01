# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server for Sumo Logic log searches. Exposes `search_sumologic` plus read-only analysis and discovery tools (`sumologic_*`, registered in `src/tools.ts`) via the Model Context Protocol over Streamable HTTP transport (Express server on port 3006). Primary consumers are AI skills (debug-with-telemetry, optimize-with-telemetry, picasso), so results must make failure, truncation and partial data explicit.

## Releasing a version

Live tests cannot run from this repo: they need a Claude Code session with this server connected, which is globo-portal. After a version bump (`package.json` `version` and `VERSION` in `src/index.ts`) and a rebuild, run the `sumo-mcp-check` skill from globo-portal. It reads `src/docs/live-test-plan.md`, runs only the cases that cover the files changed since the commit in `src/docs/live-test-results.md`, and rewrites that results file. Commit the results file with the version.

When you add a source file or a case, update the file to case map in `globo-portal/.claude/skills/sumo-mcp-check/SKILL.md`.

Test data must never contain real IDs copied from logs (Twilio SIDs, account IDs, task IDs, client IPs). GitHub push protection rejects them; build fake ones at runtime.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc + tsc-alias for path aliases)
npm start            # Run compiled server from dist/
npm run dev          # Dev mode with nodemon + tsx (auto-reload)
npm test             # Run tests (node:test via tsx, Sumo faked in test/fakeSumo.ts)
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier format
npm run format:check # Prettier check

# Docker
docker build -t mcp-sumologic .
docker run --rm --env-file .env -p 3006:3006 mcp-sumologic
docker-compose up --build -d
```

## Architecture

```
src/
├── index.ts                      # Express server + MCP setup, search_sumologic registration
├── tools.ts                      # Registration of the sumologic_* tools
├── instructions.ts               # Server instructions sent to MCP clients at initialize
├── domains/sumologic/
│   ├── client.ts                 # Search orchestration (job → poll → messages → cleanup) + meta
│   ├── analytics.ts              # timeline, compareWindows, discoverValues (built on search)
│   ├── catalog.ts                # Management API reads (partitions, fields, health, monitors, ...)
│   ├── errors.ts                 # Error classification + tool error formatting
│   └── links.ts                  # Sumo UI search links
├── lib/sumologic/
│   ├── client.ts                 # Sumo Logic HTTP client (Search Job API + generic GET/POST)
│   ├── limiter.ts                # Process-wide rate limiter (4 req/s, 10 in flight)
│   └── types.ts                  # TypeScript interfaces for Sumo Logic API
├── utils/
│   ├── json.ts                   # Compact JSON for tool output (handles circular refs)
│   ├── pii.ts                    # PII masking (email, phone, CC, SSN, address, secrets)
│   └── time.ts                   # Time parsing: ISO/offset/epoch/relative, zones, windows
├── docs/sumologic-api-1.0.0.yaml # Sumo Logic OpenAPI spec (reference for new endpoints)
├── docs/live-test-plan.md        # Live test cases (run from globo-portal: sumo-mcp-check)
└── docs/live-test-results.md     # Last live run: version, commit, pass or fail per case
```

### Request Flow

1. **MCP entry** (`index.ts`): Serves MCP over Streamable HTTP at `/mcp` (session-based transports), or over stdio when `MCP_TRANSPORT=stdio`. The `search_sumologic` tool accepts `query`, optional `from`/`to` ISO timestamps, optional `timeZone` (IANA, default UTC), `limit` (1–100000, default 100), `byReceiptTime`, `bySearchableTime`, `autoParsingMode` (`AutoParse`/`Manual`), `requiresRawMessages`, `includeHistogram`, `allowLargeResult`, `around`/`aroundMinutes`, and `returnFields`. Errors are returned with `isError: true` and a classified kind (`formatToolError`).
2. **Search orchestration** (`domains/sumologic/client.ts`): Creates a Sumo Logic search job, polls status until a terminal state (`DONE GATHERING RESULTS`/`FORCE PAUSED`; throws on `CANCELLED` or a 5-minute timeout), then fetches results and deletes the job. Aggregate queries return `records`, other queries return `messages`; detection is `recordCount > 0` OR the query containing an aggregate operator, so a zero-result aggregate still returns `records` instead of erroring on the messages endpoint. Results beyond a 10000 row page are paginated up to `limit` (raw messages capped at 2000 unless `allowLargeResult`). `around` reads raw messages from the event's position (histogram estimate, then up to 6 single-message probes), and a capped `around` search that never reached the event retries once with a narrower window; `requiresRawMessages` adds the raw lines behind an aggregate; `includeHistogram` adds volume buckets (on a capped search, empty buckets older than the gathered messages are dropped). Transient failures (429, 5xx, socket errors) retry with backoff. Default time range is last 24 hours (sent as epoch millis), timezone UTC. Wall-clock ISO `from`/`to` without an offset pass through unchanged; relative, epoch and offset times are sent as epoch millis. Each search uses its own cookie jar (`client.withSession()`) because Search Job API jobs are pinned to their session cookie. Every result carries `meta` (jobId, window, totals vs returned, returnedSpan, truncated, completeness, partialReasons, accumulated pendingWarnings/pendingErrors, UI link).
3. **HTTP client** (`lib/sumologic/client.ts`): Wraps `request-promise-native` with basic auth, a 120s request timeout, and the shared rate limiter. Methods: `job()`, `status()`, `messages()`, `records()`, `delete()`, `getJson()`, `postJson()`, `withSession()`.
5. **Analysis/catalog tools** (`analytics.ts`, `catalog.ts`): `timeline` appends `| timeslice | count by _timeslice` to a non-aggregate query and zero-fills buckets; `compareWindows` runs timelines for the window and shifted baselines and applies the spike/drop rule to totals, and flags `burst` when the busiest bucket beats every baseline's busiest bucket by `spikeRatio`; catalog functions are thin, trimmed reads over management endpoints from the OpenAPI spec.
4. **PII filtering** (`utils/pii.ts`): Applied only to `_raw` and `response` fields in search results. Redacts emails, Luhn-valid card numbers, formatted or `+` prefixed phone numbers, street addresses, dashed SSNs, Twilio account SIDs, client IPs under client IP keys (`ip`, `http_remote_address`, `remote_ip`, `X-Forwarded-For`, ...), and values of secret-looking keys. Bare digit runs, decimals, IPs, hostnames and ARNs are left alone because they are almost always timestamps or ids. Call and conference SIDs are kept for tracing.

### Key Technical Details

- **ESM modules**: `"type": "module"` in package.json — all imports use `.js` extensions
- **Path aliases**: `@/*` maps to `src/*` (tsconfig paths + `tsc-alias` for build, `tsx` handles in dev)
- **Transport**: Streamable HTTP by default (each session gets its own `StreamableHTTPServerTransport` keyed by session ID), or stdio when `MCP_TRANSPORT=stdio` (used by clients that spawn the process)
- **Health endpoint**: `GET /health` returns service status and enabled tools

## Environment Variables

Required in `.env`:
- `ENDPOINT` — Sumo Logic API base URL (e.g., `https://{host}/api/v1`)
- `SUMO_API_ID` — API access ID
- `SUMO_API_KEY` — API access key
- `PORT` — Server port (default: 3006)

Optional: `SUMO_SEARCH_TIMEOUT_MS` (default 300000), `SUMO_MESSAGE_CAP` (200000, raw message cap used for `totalsAreLowerBound`), `SUMO_MAX_REQUESTS_PER_SECOND` (4), `SUMO_MAX_IN_FLIGHT` (10), `SUMO_UI_URL` (UI link base, derived from ENDPOINT; `off` disables).
