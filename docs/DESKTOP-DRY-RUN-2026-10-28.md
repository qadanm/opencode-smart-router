# Desktop dry-run deployment — 2026-10-28

> **Promoted on 2026-10-28:** the user explicitly approved promotion to automatic routing, overriding the unmet criteria below. See [DESKTOP-PROMOTION-2026-10-28.md](DESKTOP-PROMOTION-2026-10-28.md). The car-spotter duplicate bridge cleared after promotion (live bridge count 9). This document remains the pre-promotion dry-run record.

**Status at verification:** **DRY-RUN; automatic routing was NOT enabled.**
**Artifact:** `8c71c46c5f7616f950c6a3fcf5c42be2198407848cf9ffac15d01504496f8920`
**Code commit:** `e8fa5ac` · **Docs commit before this report:** `4519dd9`
**Tests:** 106 passed; typecheck clean; fresh 30-minute mock soak **PASS**
**Live server:** PID `90727`, port `49374` — same process, no application restart
**Live config:** `d6cab84f1cd1899057486da35b1da09b63bcf7bf7983c440bb7f4ea888b7268b`
**Router config:** `d7bebb5941896623f59a42d71bf13980d66394ac086ca284815c622201757d6e`

## What was deployed

- Installed the verified artifact at `~/.config/opencode/plugins/opencode-smart-router/index.js`; hash verified before and after reload.
- Added only that path to the existing `plugins` array. The existing Vercel and Superpowers entries were preserved.
- Wrote `~/.config/opencode/smart-router.json` with:
  - `dryRun: true`
  - `premium.mode: "off"`, budget 0, one-shot approval false
  - `opencode-go` and `commandcode` enabled; `allowExtraUsage: false` for both
  - quota probes enabled at 5 minutes; `failClosed: true`
  - no third provider, no OpenDesign, no model-definition additions
- Reloaded with `POST /api/location/reload`; **did not restart the desktop process**.

The host still has its existing Ollama provider entry. The router’s approved provider set is only `opencode-go` and `commandcode`; Ollama is outside router policy and was not used.

## Backup and emergency rollback

Backup: `~/Documents/opencode-smart-router-backups/20261027-223912`

Contents:

- exact pre-deployment `opencode.json` (mode 0600)
- markers proving `smart-router.json` and the plugin directory were absent before deployment
- the exact deployment artifact and hash
- `state.txt`, `deployed-state.txt`, and a self-excluding `SHA256SUMS.txt`
- `rollback.sh` (mode 0700), which does not depend on the plugin

Verified:

- backup manifest `shasum -a 256 -c SHA256SUMS.txt` → **PASS**
- rollback exercised in a disposable HOME with a dummy deployed state → restored the exact pre-deployment config hash
- rollback exercised against a disposable copy of the **actual deployed state** → restored `opencode.json` to `83872b2d…`, removed the router config and plugin directory
- the rollback also attempts a location reload; if reload is unavailable, it prints the restart instruction

Emergency command:

```bash
~/Documents/opencode-smart-router-backups/20261027-223912/rollback.sh
```

The backup contains the live config, including provider credentials. The directory and files are owner-only; do not share or commit it.

## Live verification

### Dry-run decisions

Three live `preview` decisions were run on a disposable session; preview does not send a model request.

| Sample | Task | Would switch to | Dry-run | Premium approval | Session changed? |
|---|---|---|---|---|---|
| 1 | Tier 2 design/feature | `commandcode/claude-haiku-5-5` | yes · switched false | false | no |
| 2 | Tier 1 mechanical CSS | `opencode-go/mimo-v2.6-flash` | yes · switched false | false | no |
| 3 | Tier 3 sophisticated design | `commandcode/claude-haiku-5-5` (standard-design fallback warning) | yes · switched false | false | no |

The disposable session stayed on `commandcode/deepseek-v4.1-flash`; its cost and tokens remained **zero** before and after all previews. The session was deleted.

An isolated 6-location lab exercised **actual prompts** under dry-run:

- 5 prompts → **5 mock model requests**, one per prompt; no extra classifier request
- all five selected sessions kept their existing model (four DeepSeek, one Haiku)
- titles changed to `DRY RUN`, but no model switch occurred

Code path: `classifyTask` is deterministic and makes no model call. The engine sets `switched: wouldSwitch && !input.dryRun`; the controller calls `switchModel` only when `decision.switched` is true. Dry-run therefore cannot change the selected model.

### Providers and accounting

| Provider | Source | 5h | Weekly | Monthly | Remaining | Purchased |
|---|---|---:|---:|---:|---:|---:|
| OpenCode Go Plus | provider | 5% | 63% | 81% | n/a | n/a |
| Command Code GOAT | provider | 12.71% | 81.19% | 40.59% | `$41.5839432091` | `$0` |

- Command Code plan grant: `$70`; monthly usage is `$70 − remaining`, derived from provider-reported remaining credits.
- Model-level quotas are labeled `source: "estimate"`; provider-level allowances are `source: "provider"`.
- Premium mode is `off`; premium spend is `$0`; no premium model was selected.
- Purchased credits are `$0`; `allowExtraUsage` is false for both providers. The client-side zero-remaining guard is unit-tested; provider-side billing enforcement remains the final guarantee.

### Multi-project load

The plugin is active in four queried live projects:

- `Documents/Default Project`
- `Documents/dev/car-spotter-game`
- `Code/vinly`
- `Artwork/qadantravels-studio/carousel-studio`

Observed:

- one core `eimkk4hz`, one PID `90727`, **one event stream**
- 10 bridges across the active locations; `setups` 25 / `disposes` 15 reflect the one-time reload and per-location probes, not repeated core creation
- **16 router commands per location** (not duplicated)
- plugin diagnostics errors: **0**
- one quota service: `quotaRefreshes` 2 → 4 after one interval for two providers, `quotaSnapshots` 2 — one refresh per provider per interval, not per bridge
- no true log-level `ERROR` in the deployment window; 187 pre-existing MCP/worktree warnings; no plugin warnings or thrash

**Watch item:** `Documents/dev/car-spotter-game` has two bridge records (one created before the reload, one after). It does not duplicate commands (16), the event stream (one), the core (one), or quota polling (one service). It appears to be a pre-reload location retained around an active session. It should clear when that session next advances or is closed; if it persists without an active session, reload again or investigate the host’s workspace/location retention before promotion.

## Promotion criteria: dry-run → automatic routing

Do not change `dryRun` to `false` until all criteria pass and the user explicitly approves.

| # | Criterion | Target | Current |
|---|---|---|---|
| 1 | Stability window | 24 hours continuous with the plugin loaded; one core/PID, one event stream; no plugin errors/thrash | **Not met** — deployment is minutes old |
| 2 | Dry-run coverage | ≥20 live decisions across trivial, feature, and design tasks; 100% no model change; no premium/purchased routes | **Not met** — 3 live previews + 5 lab prompts |
| 3 | Multi-project cleanliness | 16 commands per location; no persistent duplicate bridge for a location after reload grace | **Watch** — 16 commands and one core, but one car-spotter duplicate bridge persists |
| 4 | Provider headroom | Go: monthly <85%, weekly <80%, 5h <80%. Command Code: weekly <80%, monthly <70%, remaining ≥$20, purchased $0 | **Partly** — Go passes 81/63/5; Command Code monthly/remaining/purchased pass, but weekly **81.19% > 80%** |
| 5 | Fresh provider data | Provider source, no auth/rate-limit errors, snapshots refreshed at least every 10 minutes | **Pass** |
| 6 | Premium and extras | Premium off, spend $0, purchased $0, `allowExtraUsage:false` | **Pass** |
| 7 | Cost labeling | Provider allowances authoritative; local model/session costs explicitly `estimate` | **Pass** |
| 8 | Rollback | Manifest verifies; rollback restores exact pre-deployment config and removes deployed files | **Pass** |
| 9 | Provider scope | Only Go Plus and Command Code GOAT approved; no OpenDesign/third provider | **Pass** |
| 10 | Approval | Explicit user decision to promote | **Pending** |

### Promotion procedure (only after all criteria pass)

1. Record the current artifact and config hashes; confirm the backup and rollback are current.
2. Set `"dryRun": false` in `~/.config/opencode/smart-router.json`; keep premium off and `allowExtraUsage:false`.
3. `opencode api POST /api/location/reload`.
4. Watch the first 20 automatic decisions: model/provider matches the decision, no premium/purchased route, no plugin errors, one core/event stream, quota refresh once per interval.
5. Keep the rollback command ready. Revert to dry-run immediately if any criterion breaks.

**Current recommendation:** stay in dry-run. Wait for the 24-hour window and at least 20 live decisions; resolve or explain the car-spotter duplicate bridge; wait for Command Code weekly usage to fall below 80% (next weekly reset is 2026-10-31T06:41Z or usage decay). Then review promotion explicitly.
