# Desktop promotion — automatic routing active

**Status:** **AUTOMATIC ROUTING ACTIVE**, by explicit user approval on 2026-10-28.
**Artifact:** `8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920`
**Live config:** `d6cab84f1cd1899057486da35b1da09b63bcf7bf7983c440bb7f4ea888b7268b` (unchanged)
**Promoted router config:** `ca7476d3caa71b27948d20e91e96ce70ff6709df1e9b9c0968622009be488263`
**Previous dry-run config:** `d7bebb5941896623f59a42d71bf13980d66394ac086ca284815c622201757d6e`
**Live service:** PID `90727`, port `49374` — same process; no application restart

## What changed

- `dryRun` was changed from `true` to `false`.
- Everything else remains:
  - premium mode **off**, budget 0, one-shot approval false
  - `opencode-go` and `commandcode` only; `allowExtraUsage:false` for both
  - quota probes at 5 minutes; fail closed
  - no third provider, no OpenDesign
- The change was applied atomically and loaded with `POST /api/location/reload`.
- The selected session model is not changed by the promotion itself; the next eligible prompt will be routed automatically.

## User-approved exception

The dry-run report recommended waiting for the 24-hour window, ≥20 live decisions, resolution of the car-spotter duplicate bridge, and Command Code weekly below 80%. The user explicitly approved **promotion now**, overriding those gates. The car-spotter duplicate bridge subsequently cleared; the weekly headroom and 24-hour/decision-count gaps remain monitor-only at the user's direction. The dry-run report remains the historical verification record.

## Live verification after promotion

| Project | dryRun | Runtime | Premium | Approved providers |
|---|---|---|---|---|
| Default Project | false | automatic | off | Command Code, OpenCode Go |
| car-spotter-game | false | automatic | off | Command Code, OpenCode Go |
| vinly | false | automatic | off | Command Code, OpenCode Go |
| carousel-studio | false | automatic | off | Command Code, OpenCode Go |

- One core `eimkk4hz`, PID `90727`, **one event stream**.
- Plugin diagnostics errors: **0**.
- 9 bridges (the earlier car-spotter duplicate has cleared); 16 commands per project; one quota service.
- Provider allowances: `source:provider`; local model/session costs: `source:estimate`.
- Command Code remaining `$41.4483117158`; purchased credits `$0`; monthly 40.79%, weekly 81.58%, 5h 13.67%.
- Go Plus 5h 5%, weekly 63%, monthly 81%.

No paid prompt was sent after promotion. Automatic switching will be exercised by the next real prompt; verify the first decisions against the decision record and actual session model.

## Rollback

Promotion backup: `~/Documents/opencode-smart-router-backups/20261027-225615-promotion`

- Immediate restore to dry-run:
  ```bash
  ~/Documents/opencode-smart-router-backups/20261027-225615-promotion/rollback-to-dryrun.sh
  ```
  This restores `dry-run:true`, keeps the plugin/premium/extras policy, and attempts a location reload. It was tested against a disposable HOME: restored hash `d7bebb59…`, `dryRun:true`.

- Full pre-deployment restore (plugin removed):
  ```bash
  ~/Documents/opencode-smart-router-backups/20261027-223912/rollback.sh
  ```
  This restores `opencode.json` to `83872b2d…`, removes the router config and plugin, and was tested against the actual deployed state.

The backup directories contain the live config with provider credentials; they are owner-only. Do not share or commit them.

## Monitoring the first automatic decisions

Watch for:

1. Decision model/provider matches the actual session model after the request.
2. No premium model or premium spend; no purchased credits.
3. Provider remaining balances and windows move within expectations; provider balances remain authoritative.
4. One core/PID, one event stream, 16 commands per project; no duplicate bridge growth; no plugin errors or thrash.
5. No unexpected third-provider route.
6. Local `estimatedUsd` is treated as an estimate, not a provider bill.

If any of these fail, run `rollback-to-dryrun.sh` first; use the full rollback if the plugin itself is unstable.

## Current headroom warning

Command Code weekly is **81.58%**, above the 80% promotion target but below the 85% reserve. The user accepted this risk. If weekly reaches the reserve or the provider reports an error, routing will block under the existing policy; monitor and revert to dry-run if needed.
