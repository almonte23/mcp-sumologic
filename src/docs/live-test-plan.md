# Live test plan

The live test cases for this server. `npm test` uses a fake Sumo and cannot catch problems that only show on live data: cookie notices, the 200K cap, coarse histograms, real category names.

This repo cannot run them: they need a Claude Code session with this server connected, which is globo-portal. Run them there with the `sumo-mcp-check` skill (`globo-portal/.claude/skills/sumo-mcp-check/SKILL.md`). It picks only the cases that cover what changed since the last tested commit, runs them in a subagent, and writes the outcome to `live-test-results.md` next to this file.

When you add or change a case here, update the skill's file to case map and cost table to match.

Fixed dates in a prompt are written as YESTERDAY: use a recent day so Sumo still has the data (Production keeps 45 days, PreProduction 30). Large raw results (A7) are saved to a file by Claude Code; read them with `jq`.

## 0. Is the new build loaded?

"List every tool the Sumo Logic MCP exposes, and tell me whether you received server instructions from it. Also check that the running server process started after the last build."

Pass if:

- 12 tools: `search_sumologic` plus 11 `sumologic_*`.
- The instructions mention `meta.completeness` and are not cut off. Claude Code drops everything past 2048 characters; `test/instructions.test.ts` enforces the limit.
- The server process started after `dist/` was last built.

## Part A: core search

### A1. Basic raw search with the default window

"Use search_sumologic with query `_index=Production` and limit 5. Show me the raw JSON response."

Pass if:

- `type: "messages"` with 5 messages and a `meta` key.
- `meta.window.to` is close to the current UTC time (the default window is the last 24h).
- `meta.warnings` has no "You must enable cookies" notice. Sumo sends that text on every job; the server drops it.
- Inside `_raw`, timestamps, decimals (`duration_ms`), hostnames and ARNs are not redacted.

### A2. Wall-clock times with a time zone

"Use search_sumologic: query `_index=Production`, from YESTERDAY at 09:00:00, to YESTERDAY at 09:15:00, timeZone America/New_York, limit 3. Show the message timestamps and meta.window."

Pass if: `meta.window` is 13:00Z to 13:15Z (or 14:00Z to 14:15Z in winter, EST), and the message timestamps fall inside it.

### A3. Aggregate query

"Use search_sumologic: `_index=Production | count by _sourceCategory | sort by _count`, last 24h. Show the top 10."

Pass if: `type: "records"` with counts, `totalsAreLowerBound: false` (aggregates are never capped), and `partialReasons: ["limit"]` when more than 10 categories matched.

### A4. Aggregate with zero results

"Use search_sumologic: `_index=Production "zzz-no-such-string-zzz" | count by _sourceCategory`."

Pass if: `type: "records"`, `records: []`, no error, `completeness: "complete"`.

### A5. Timeslice aggregate

"Use search_sumologic: `_index=Production | timeslice 1h | count by _timeslice`, from YESTERDAY 00:00:00 to YESTERDAY 06:00:00 UTC."

Pass if: 6 hourly records whose counts add up to `meta.totals.messages`, `completeness: "complete"`. Sumo returns the rows out of order; that is expected.

### A6. Receipt time, raw messages behind an aggregate, and histogram

Run three search_sumologic calls:

1. "`_index=Production` with byReceiptTime true, limit 3"
2. "`_index=Production | count by _sourceHost` with requiresRawMessages true, limit 5"
3. "`_index=Production` with includeHistogram true, limit 1"

Summarize what each returned.

Pass if:

- Call 1 returns messages and `meta.window.timeBasis` is `receiptTime`.
- Call 2 returns both records and messages. When capped, its warning says the records cover the whole window and only the raw messages stop at the cap. It must not say the counts cover only the newest messages (that was wrong and was fixed in 1.6.1).
- Call 3 returns a histogram array. When capped, the empty older buckets are dropped and a warning says how many.

### A7. Raw message cap and the opt out

"Use search_sumologic on `_index=Production`, last 1h, limit 3000, returnFields ["_messagetime"]. Then repeat with allowLargeResult true. Report the message count and note for each."

Pass if:

- Call 1: 2000 messages, a cap note, `partialReasons` includes `rawMessageCap`.
- Call 2: 3000 messages, no note.
- Each message and the `fields` list contain only `_messagetime`.
- `meta.returnedSpan` shows the few seconds the messages actually cover.

### A8. PII masking

"Use search_sumologic on `_index=Production "@"`, limit 5. Are email addresses masked in \_raw?"

Pass if:

- Emails show as `[EMAIL REDACTED]`.
- Client IPs (`http_remote_address`, Rack `"ip"`) show as `[IP REDACTED]`.
- `AccountSid` shows as `[TWILIO ACCOUNT SID REDACTED]`; `CallSid` and `ConferenceSid` stay readable.
- `user_id`, hostnames and the task ARN stay readable.

## Part B: trust signals and analysis tools

### B1. Trust signals

"Use search_sumologic on `_index=Production`, from -1h, limit 10. Explain meta: totals vs returned, truncated, completeness, partialReasons, warnings. Then open meta.links.ui in the browser and tell me whether it loads that search in Sumo Logic."

Pass if:

- `truncated: true`, `completeness: "partial"`, `partialReasons` includes `limit` (and `sumoCap` when Sumo hit its cap).
- The UI link uses `service.us2.sumologic.com`. The built-in browser is not signed in to Sumo, so a person signed in has to confirm the link loads the search.

### B2. Relative times, around, and returnFields

1. "search_sumologic `_index=Production`, from "-90m", limit 3"
2. "take the newest message's \_messagetime and search `_index=Production` around it with aroundMinutes 2, returnFields ["_messagetime","_sourcecategory","_raw"], limit 20. Show meta.window for both, and whether meta.returnedSpan contains that message's time."

Pass if:

- Call 1's window is 90 minutes wide.
- Call 2's window is ±2 minutes around the message time, **or** narrower with `partialReasons` including `narrowedWindow` and a warning saying why (a busy window hit the cap before reaching the event).
- Call 2's `returnedSpan` contains the target time.
- Call 2's rows contain only those three fields.

### B3. Errors are flagged, not empty

"Call search_sumologic with exactly these arguments and show me the raw response, including isError:
{"query": "\_index=Production | parse \"x=\*\" as", "from": "-15m", "limit": 5}"

"Call search_sumologic with exactly these arguments and show me the raw response, including isError:
{"query": "\_index=Production", "from": "tuesday", "limit": 5}"

Pass if:

- Both are `isError: true`.
- The first is `kind: "invalid_query"`. The second is `kind: "invalid_input"` and never reaches Sumo.
- Both say "This search FAILED. It is not an empty result".

Claude Code shows only the error text, not the `isError` flag itself. To see the flag, call the server over stdio: start `dist/index.js` with `MCP_TRANSPORT=stdio`, send `initialize`, then `tools/call`, and read the JSON reply. To prove the second call never reaches Sumo, point `ENDPOINT` at an address that refuses connections (e.g. `https://127.0.0.1:9/api/v1`): the result must still be `invalid_input`, not a network error. Every stdout line must be JSON (stdio mode writes nothing else there).

### B4. Timeline

"Use sumologic_timeline on `_index=Production _sourceCategory=production/portal/* error`, from "-7d", bucket "6h". Give me total, firstSeen, lastSeen, peak. Then repeat for the last 3h grouped by \_sourceCategory with topGroups 5. Then run the first one again with `prod/portal/*` instead. Then run it once more with `production/portal/*` and the term `\"zz-no-such-term-zz\"` in place of `error`. Finally run `_index=PreProduction _sourceCategory=staging/portal/web \"zz-no-such-term-zz\"` from \"-24h\"."

Pass if:

- 29 zero filled buckets for 7 days at 6h (the first and last are partial), with real totals.
- The grouped run returns 5 series plus an `(other: N groups)` series.
- The `prod/portal/*` run returns 0 with `completeness: "complete"` and a `meta.hint` pointing to `sumologic_discover_sources`. Production categories are `production/portal/*`; `prod/portal/*` matches nothing.
- (1.6.3) The `production/portal/*` run with the made up term returns 0 with **no** `hint`: the category has data, so only the term matched nothing.
- (1.6.4) The `staging/portal/web` run returns 0 with **no** `hint`. `PreProduction` is outside the default search scope, so the category check must keep `_index=PreProduction`; 1.6.3 dropped it and wrongly hinted.

### B5. Compare windows

"Use sumologic_compare_windows on `_index=Production error` from YESTERDAY 13:00:00 to YESTERDAY 14:00:00 America/New_York with baselineOffsets ["24h","7d"]. What's the verdict and why? Is there a burst?"

Pass if:

- Both baselines are present, each with `ratio`, `verdict` (spike, drop or normal) and `reason`.
- Each baseline also has `peakRatio`, `burst` and `burstReason`.
- Top level `burst` is either `null` or names the busiest bucket and how many times it beat every baseline's busiest bucket.

Reference case: 2026-09-30 13:00 to 14:00 ET returns `verdict: "normal"` (1.39x and 1.60x) with a burst at 13:37 ET (26,494 errors, 19.2x and 21.8x), while that day is still within retention.

### B6. Discovery

1. "sumologic_list_indexes. Do Production and PreProduction exist? What are their retention periods?"
2. "sumologic_discover_sources with scope `_index=PreProduction`, last 1h. Which qa/, uat/, staging/ categories show up?"
3. "sumologic_discover_sources with scope `_index=Production`. Do categories start with prod/portal or production/portal?"
4. "sumologic_list_fields"

Pass if: real names come back. Expected today: Production 45 days, PreProduction 30 days; PreProduction has `qa|uat|staging/portal/*`; Production has `production/portal/*` (the only `prod/` categories are `prod/conn/*` and `prod/web/platform-checks`).

### B7. Context tools

"Call sumologic_health_events, sumologic_search_monitors (default), sumologic_list_saved_searches with filter "portal", and sumologic_list_scheduled_views. Summarize each."

Pass if: each returns data or a clean empty list. `search_monitors` currently returns `kind: "forbidden"`: the API key's role lacks that permission, which is a Sumo role setting, not a bug. Its note must say "This call FAILED", not "This search FAILED".

### B8. Scan estimate and metrics

1. "sumologic_estimate_scan for `_index=Production error`, from "-60d""
2. "sumologic_query_metrics with query `metric=CPU_Total | avg`, last 1h"

Pass if: call 1 gives a total and a per tier breakdown. Call 2 returns a series, an empty result, or a clean error.

### B9. Parallel searches

1. "Fire these 6 search_sumologic calls in parallel, each limit 5: `_index=Production` for windows -10m, -20m, -30m, -40m, -50m, -60m (from only). Report each jobId, meta.window.from, and whether any failed."
2. "Now fire 6 in parallel with windows that do not overlap: from -10m to -0m, -20m to -10m, -30m to -20m, -40m to -30m, -50m to -40m, -60m to -50m. Report each jobId and returnedSpan."

Pass if:

- 6 distinct job IDs per run, each with its own window, and no `rate_limited` failures.
- In run 2, each `returnedSpan.newest` sits at its own window's end. Repeated messages across these windows would mean the stale result bug is back.

Run 1 alone cannot detect stale results: every window ends at "now", so all six correctly return the same newest messages.

## Known non bugs

These look like failures but are not:

- `search_monitors` returns `forbidden`: Sumo role permission.
- The **HQ PROD** saved search uses `prod/app/portal` and `prod/web/portal`, which match nothing. Fix it in the Sumo UI.
- Health events for the Google Workspaces collector and `app10-production-east`: collector settings in Sumo, unrelated to portal logs.
- The newest message is about 30 seconds older than "now": Sumo's indexing delay.
- Most raw searches over Production report `sumoCap`: Production sends about 200K messages every 2 minutes.

## Recording results

Report each test as pass or fail with one line of evidence (a job ID, a count, a quoted warning). For each failure, write the test first in `test/` (the fake Sumo in `test/fakeSumo.ts`), confirm it fails, fix, then rerun the live test.
