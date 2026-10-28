# Stage B evidence

## Read this first

- `usage-deltas.json` is the **historical** Stage B record. Its `cc_provider_vs_session_ratio` (38.5×) is **not a price ratio**: the numerator is the account-wide Command Code window delta, while the denominator is only the two canary requests. The live desktop was using the same account during the window.
- `reconciliation.json` is the corrected accounting view. It separates the canary cost, the concurrent live-desktop activity, the provider window delta, and the two monthly pools.
- `artifact-validation-8c71c46c.txt` records the exact accounting-follow-up artifact in the isolated mock lab (16 router commands, 2 mock requests, 0 errors, explicit design-fallback label).
- `soak-summary-8c71c46c.json` records the fresh 30-minute mock soak on the exact artifact: 29 samples, 1,491 mock requests, one PID/core, one event stream, 21 bridges, 63 setups / 42 disposes, 0 plugin errors, one expected outage `ECONNREFUSED`; outage and large-context sessions succeeded.

## Provider data

`preflight-*`, `post-quota-*`, `usage-before-requests.json`, and `usage-after-requests.json` are read-only provider snapshots. They contain usage/plan data, not credentials.

## Key accounting facts

- Plan grant: **$70** (`$14` five-hour cap = 20%, `$35` weekly cap = 50%).
- Before requests: remaining `$42.394248873`, derived monthly used `$27.605751127`, summary used `$27.924756069`.
- After requests: remaining `$42.333361882`, derived monthly used `$27.666638118`, summary used `$28.080547352`.
- The provider 5h/weekly delta and monthly remaining delta are both `$0.060886991`.
- The summary monthly delta is `$0.155791283`; it is a different accounting pool and is now diagnostic only.
- The canary's two Command Code requests cost `$0.001580838` locally at published off-peak rates.
- Concurrent live-desktop Command Code activity in 04:20–04:40 UTC: 74 assistant messages, `$0.284917` local estimate; 11 messages at 04:27 alone.
