# Desktop dry-run evidence — 2026-10-28

- `deployment-identity.txt` — pre/post config hashes, installed artifact hash, service PID.
- `live-status-baseline.json` / `live-status-after-interval.json` — provider-sourced allowances, premium state, purchased credits, local model-quota source.
- `live-diagnostics-baseline.json` / `live-diagnostics-after-interval-2.json` — one core, one event stream, bridges, quota refresh counts.
- `live-preview-samples.jsonl` — three live dry-run previews (no inference) with would-switch targets.
- `live-preview-session-before.json` / `after.json` — selected model and zero cost/tokens before and after previews.
- `live-plugin-status.txt` / `live-commands.txt` — four active projects, plugin active, 16 commands per project.
- `live-errors.txt` / `live-warnings-summary.txt` — true log-level errors zero; warnings are pre-existing MCP/worktree messages.
- `router-config.json` — deployed dry-run policy (no credentials).
- `lab/` — isolated 6-location dry-run evidence: one core/event stream, 16 commands per location, 5 prompts → 5 mock requests, models unchanged.
- `lab/dryrun-decision-p1.json` — would-switch decision with `switched:false`.

Watch item: one extra bridge record for car-spotter retained from a pre-reload active session; commands/core/event stream/quota polling remain singular.
