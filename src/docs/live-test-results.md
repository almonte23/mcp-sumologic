# Live test results

Version: 1.6.2
Commit: f9fc6d5
Date: 2026-10-01
Tier: full

| Case | Result | Evidence                                                                                                         |
| ---- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| 0    | Pass   | 12 tools; instructions 2,008 characters, not cut off; process started after build                                |
| A1   | Pass   | 5 messages, `meta` present, no cookie notice, timestamps and durations not redacted                              |
| A2   | Pass   | 09:00 to 09:15 New York became 13:00Z to 13:15Z; messages at 13:14:59.99Z                                        |
| A3   | Pass   | 10 of 29 categories, `partialReasons: ["limit"]`, `totalsAreLowerBound: false`                                   |
| A4   | Pass   | `records: []`, `complete`, no error                                                                              |
| A5   | Pass   | 6 hourly records summing to 19,526,263, `complete`                                                               |
| A6   | Pass   | receiptTime messages; records plus messages with the whole window warning; histogram trimmed to 1 bucket         |
| A7   | Pass   | 2,000 with cap note and `rawMessageCap`; 3,000 with no note; only `_messagetime`                                 |
| A8   | Pass   | emails, client IPs and AccountSid redacted; `user_id`, hosts, ARNs readable                                      |
| B1   | Pass   | `truncated`, `partial`, `["limit","sumoCap"]`; UI link host correct, sign in check still needed by a person      |
| B2   | Pass   | 90 min window; around window ±2m, `returnedSpan` 17:08:46.372 to .405 contains target .393                       |
| B3   | Pass   | raw stdio: `isError: true`, `invalid_query`; `invalid_input` with an unreachable endpoint                        |
| B4   | Pass   | 29 zero filled buckets; 5 series plus `(other: 4 groups)`; `prod/portal/*` returns 0 with the hint               |
| B5   | Pass   | 2026-09-30 13:00 ET: `normal` (1.39x, 1.60x), `burst` at 13:37 ET (19.2x, 21.8x)                                 |
| B6   | Pass   | Production 45d, PreProduction 30d; `production/portal/*`; 17 custom fields                                       |
| B7   | Pass   | 3 health events; monitors `forbidden` with "This call FAILED"; 6 saved searches; no scheduled views              |
| B8   | Pass   | 5.1 TB Continuous, 0 B charged; metrics series returned                                                          |
| B9   | Pass   | 6 distinct job IDs per run, no `rate_limited`; windows that do not overlap each return their own newest messages |
