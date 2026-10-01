// Server-level guidance sent to MCP clients at initialize. Keep it about how
// to use these tools well; organization-specific mappings (which index holds
// which environment) belong in the calling skills, or can be discovered with
// sumologic_list_indexes / sumologic_discover_sources.
//
// Claude Code drops everything past 2048 characters, so keep it under that
// (test/instructions.test.ts enforces it). The most important rules go first.

export const SERVER_INSTRUCTIONS = `
Sumo Logic log search and discovery. All tools are read-only.

Trusting results:
- Every search result has "meta". Treat "no results" as evidence only when meta.completeness is "complete" (meta.partialReasons says why not).
- meta.truncated: more rows matched (meta.totals) than were returned. Aggregate instead of raising limits.
- meta.totalsAreLowerBound: Sumo stopped gathering raw messages at its cap, so the real message total is higher and raw messages and histograms cover only the newest ones. Aggregate records still cover the whole window; use one (| count) for real numbers.
- A failed call is an error with a kind (rate_limited, invalid_query, timeout, ...), never an empty result. The server already paces and retries.
- Give meta.links.ui to the human so they can verify in the Sumo UI.

Choosing a tool:
- Raw lines or a custom aggregate: search_sumologic. Aggregates (count, sum, avg, pct, by, timeslice) run Sumo-side and return compact "records"; prefer them to counting raw messages.
- When did it start / is it growing: sumologic_timeline.
- Worse than usual: sumologic_compare_windows (vs 24h/7d earlier).
- Context around one event: search_sumologic with around=<timestamp>, aroundMinutes.
- Unknown index or source category: sumologic_list_indexes, then sumologic_discover_sources. Don't guess.
- Long (weeks+) or broad searches: sumologic_estimate_scan first; check sumologic_list_scheduled_views.
- Empty or low result: sumologic_health_events before calling the window quiet.
- Alert context: sumologic_search_monitors; trusted queries: sumologic_list_saved_searches.

Query tips:
- Always scope with _index and/or _sourceCategory first.
- Times: ISO 8601 (wall-clock in timeZone, or with Z/offset), epoch millis, "now", or relative "-90m", "-24h", "-60d". Default: last 24h, UTC.
- returnFields (e.g. ["_messagetime","_raw"]) keeps raw payloads small.
- Recipes: "| timeslice 1h | count by _timeslice", "| count by _sourceCategory | sort by _count".
`.trim();
