# Live test results

Version: 1.6.4
Commit: 2f635a4
Date: 2026-10-01
Tier: patch

| Case | Result | Evidence                                                                                                                                                       |
| ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Pass   | 12 tools; instructions complete; process started 20:15:53, after the 20:15:28 build                                                                            |
| A1   | Pass   | Job 5CA57192E54F7857: 5 messages, `meta` present, no cookie notice, timestamps, durations, hosts and ARNs not redacted                                         |
| A2   | Pass   | 2026-09-30 09:00 to 09:15 New York became 13:00Z to 13:15Z; messages at 13:14:59.99Z                                                                           |
| A3   | Pass   | 10 of 29 categories, `partialReasons: ["limit"]`, `totalsAreLowerBound: false`                                                                                 |
| A4   | Pass   | `records: []`, `complete`, no error                                                                                                                            |
| A5   | Pass   | 6 hourly records summing to 19,526,263, equal to `totals.messages`, `complete`                                                                                 |
| A6   | Pass   | receiptTime messages; records plus messages with the whole window warning; histogram with 96 empty older buckets dropped                                       |
| A7   | Pass   | 2,000 with cap note and `["rawMessageCap","sumoCap"]`; 3,000 with no note; only `_messagetime` in messages and fields                                          |
| B1   | Pass   | `truncated`, `partial`, `["limit","sumoCap"]`; UI link well formed (browser sign in check not run)                                                             |
| B2   | Pass   | 90 min window; around window ±2m, `returnedSpan` 00:19:58.000 to .022 contains target .018                                                                     |
| B3   | Pass   | bad parse returns `invalid_query`; `from: "tuesday"` returns `invalid_input`; both say "This search FAILED" (stdio check not run)                              |
| B4   | Pass   | 29 buckets; 5 series plus `(other: 5 groups)`; `prod/portal/*` hints; valid prod and PreProduction staging categories with a made up term return 0 and no hint |
| B9   | Pass   | 6 distinct job IDs per run, no `rate_limited`; windows that do not overlap each return their own newest messages                                               |

Not run this time: A8, B5, B6, B7, B8 (patch tier; `pii.ts`, `analytics.ts`, `catalog.ts`, `time.ts` and `tools.ts` unchanged since 1.6.2). B1 browser step (`links.ts` unchanged). B3 stdio `isError` step (`index.ts` changed only its version string).
