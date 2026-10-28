# Desktop promotion evidence — 2026-10-28

Explicit user approval: **promote to automatic routing now**, overriding the unmet dry-run promotion criteria.

- `status-default.json` — live status after promotion (`dryRun:false`, runtime automatic).
- `status-projects.txt` — policy visible in Default Project, car-spotter-game, vinly, carousel-studio.
- `diagnostics.json` — one core/event stream, bridge count, errors, quota refresh count.
- `config.json` / `router-config.json` — promoted policy (premium off, extras blocked, Go/CC only).
- `identity.txt` — hashes, service PID, promotion backup and rollback paths.

Rollback:
- immediate dry-run restore: `~/Documents/opencode-smart-router-backups/20261027-225615-promotion/rollback-to-dryrun.sh`
- full pre-deployment restore: `~/Documents/opencode-smart-router-backups/20261027-223912/rollback.sh`

## Final promoted snapshot

`final-status.json` and `final-diagnostics.json` capture the state after the car-spotter duplicate bridge cleared:
one core/event stream, 9 bridges, 0 errors, Command Code weekly 81.58%, remaining $41.4483117158, purchased $0.

- `commands-after-promotion.txt` — 16 router commands in each of four active projects.
- `plugin-after-promotion.txt` — plugin active in each project.
- `final-status.json` / `final-diagnostics.json` — one core/event stream, 9 bridges, 0 errors.
