// Server-level guidance sent to MCP clients at initialize. Keep it about how
// to use these tools well; organization-specific mappings (which index holds
// which environment) belong in the calling skills, or can be discovered with
// sumologic_list_indexes / sumologic_discover_sources.

export const SERVER_INSTRUCTIONS = `
Sumo Logic log search and discovery. All tools are read-only.

Choosing a tool:
- Raw log lines or a custom aggregate: search_sumologic. Aggregates (count, sum, avg, pct, by, timeslice, ...) run Sumo-side and return compact "records"; prefer them over pulling raw messages to count locally.
- "When did this start / how often / is it growing": sumologic_timeline (zero-filled buckets, firstSeen, lastSeen, peak; optional groupBy).
- "Is this window worse than usual": sumologic_compare_windows (same window shifted by 24h/7d, spike/drop verdict).
- Context around one event: search_sumologic with around=<timestamp> and aroundMinutes (default ±5).
- Unsure of index or source category names: sumologic_list_indexes, then sumologic_discover_sources. Don't guess.
- Before long (weeks+) or broad searches: sumologic_estimate_scan, and check sumologic_list_scheduled_views for a pre-aggregated view.
- Empty or suspiciously low result: sumologic_health_events (ingestion problems) before calling the window quiet.
- Existing alerting context: sumologic_search_monitors (triggered monitors, with their queries); sumologic_list_saved_searches for trusted team queries.

Trusting results:
- Every search result has "meta". Only treat "no results" as evidence when meta.completeness is "complete" and meta.errors is empty.
- meta.truncated means more rows matched (meta.totals) than were returned (meta.returned). Aggregate instead of raising limits.
- meta.jobId is unique per search, and meta.window echoes the resolved UTC range, so you can confirm a result belongs to the window you asked for.
- A failed call is marked as an error and names its kind (rate_limited, invalid_query, timeout, ...). It is never an empty result. On rate_limited, wait and retry; this server already paces requests and retries transient failures.
- Hand meta.links.ui to the human so they can verify in the Sumo Logic UI.

Query tips:
- Always scope with _index and/or _sourceCategory first; it is the biggest speed and cost lever.
- Times accept ISO 8601 (wall-clock in timeZone, or with Z/offset), epoch millis, "now", or relative "-90m", "-24h", "-60d". Default window is the last 24h, in UTC.
- Use returnFields (e.g. ["_messagetime","_sourcecategory","_raw"]) to keep raw-message payloads small.
- Recipes: "| timeslice 1h | count by _timeslice", "| count by _sourceCategory | sort by _count", "| parse \\"duration=*ms\\" as ms | pct(ms, 95) by _sourceCategory".
`.trim();
