# 01 — Executive findings

> **Post-audit implementation update (2026-10-28):** Option C was approved and implemented on branch `option-c`. The audit scores in this packet are the pre-implementation assessment. Current verification: [QA-OPTION-C-2026-10-27.md](../QA-OPTION-C-2026-10-27.md). The live plugin remains disabled.

## Bottom line

No existing project is a drop-in replacement for this router.

- **`opencode-model-router` (marco)** is the most rigorously engineered project in the set, but it is a different product: it keeps an orchestrator model and *delegates* work to tiered subagents through injected instructions. It does not deterministically select the executing model per prompt, has no OpenCode Go or Command Code quota awareness, is GPL-3.0-only, and is roughly 120,000 source lines. It is not a foundation for this requirement set.
- **`Opencode_router` (s-berdia)** is the closest conceptual match for Go quota failover, is MIT, and is refreshingly small (about 2,700 source lines; 101 tests pass). But it targets the **v1 plugin API**, has no Command Code support, no task classifier, no intelligence/vision/design floors, no premium approval, and no fail-closed admission. It would need substantial new code and a v2 port.
- **`OpenCode-Model-Router` (sertdisk)** is a per-agent chain editor and web UI, not a runtime router. Its retry hook only logs; it has no tests; it hardcodes a Windows state path; it starts a web server per plugin instance; and it reuses the same plugin id as marco.
- **`opencode-usage-limits` (mynameistito)** contains the best quota adapters in the set: exact Go and Command Code endpoints, bounded HTTP, typed failures, stale-data fallback, and strong tests. It is a **TUI plugin**, not a server plugin, and its Effect/OpenTUI dependency stack is a poor fit for a server-side router. Its value is as a verified reference and test oracle, not as a dependency.

Our existing implementation is the only candidate that covers the full requirement set: deterministic per-prompt model switching, intelligence and design floors, vision requirements, both providers' quota windows, purchased-credit protection, cache-aware affinity, manual override, and fail-closed admission (with the exception noted below).

**Recommendation: repair and simplify our existing plugin (Option A, with the minimal hybrid elements of Option C). Do not fork or adopt an external router as the base.**

Concretely:

1. Keep the routing engine, policy, ledger, classifier, and quota adapters.
2. Keep the process-wide core + per-location bridge split, but remove the remaining module-scope assumptions and shrink the bridge.
3. Adopt the quota-adapter *semantics and tests* from `opencode-usage-limits` (the endpoints are already implemented in our adapters; the external project is a better test oracle).
4. Adopt `s-berdia`'s simple per-model health/cooldown idea, reimplemented in our v2 architecture.
5. Reject marco as a code source (license and philosophy), sertdisk entirely, and usage-limits as a runtime dependency.

This preserves 100% of the stated requirements while reducing lifecycle surface. A pure external adoption would fail to fully satisfy most of requirements 1–11 in the table below; a marco fork would add a large, GPL-licensed second product.

## What the audit actually established

### Host behavior (verified by isolated probes)

- OpenCode 2.1.4 loaded 20 project locations in **one process** with **one** shared `globalThis` and **one** plugin-storage namespace.
- `setup` runs once per loaded location (133 setup events observed during a churn test; one PID, one core id).
- Commands and RPC are location-scoped; the event stream and plugin storage are process-wide.
- A prompt-hook throw rejects admission (HTTP 500, no provider request). There is no typed rejection API, but the safety effect is real.
- Plugin module scope is **not** proven shared. The observed 21 simultaneous bridges with zero disposals implies each location received a separate module evaluation. Our current `src/index.ts` still relies on that behavior; this is a latent assumption to remove.

### Our current build (post-rebuild, before this audit)

- 7,204 source lines, 206 KB single-file bundle, 77 tests pass, typecheck clean.
- One shared core, one event stream, session ownership, bounded maps, one quota service, bridge refcounting and grace shutdown.
- A 20-location isolated lab loaded all projects with one core, 21 bridges, one event stream, and 16 commands in each sampled project (p1 and p20).
- A 30-minute soak passed on an earlier build (1,352 mock requests, one core, 21 bridges, 483 setups / 462 disposes, zero thrash warnings, zero server errors, RSS 156–662 MB). The final build was **not** re-soaked for 30 minutes after the last fixes.
- The fail-closed path was verified live: HTTP 500, `BLOCKED` title, no provider request.

### Defects found during this audit (do not ship without fixing)

1. **Fail-open on routing exceptions (critical).** A user-defined model whose cost tier omitted `cache` caused `estimateTaskCost` to throw at `src/core/routing/engine.ts:113`. The prompt hook caught the error at `src/server/controller.ts:807-811`, recorded no decision, and let the prompt execute. Fail-closed only covers the *decision* path, not exceptions before it. Reproduced deterministically; see `evidence/engine-cost-repro.txt` and `evidence/lab9-fail-open.txt`.
2. **Config validation accepts the shape that triggers it.** `src/core/config.ts:210-211` accepts a cost tier with only `input`/`output`; the engine assumes `cache.read`.
3. **Latent module-scope lifecycle assumption.** `src/index.ts:10-24` keeps a module-level `active` controller and disposes it on every `setup`. This is safe only because module scope appears to be per location. The shared core already has a bridge registry; the module-level controller should be deleted.
4. **Startup work still scales with locations.** Each bridge runs `ctx.model.list()` in the background (`src/server/controller.ts:237`). It is local and non-blocking, but it is N calls, not one.
5. **Documentation drift.** `docs/ARCHITECTURE.md` still describes “one controller per process” and `docs/LIMITATIONS.md` still says there is no prompt rejection, contradicting the current code and the verified blocked-prompt behavior.
6. **No license.** The repository has no `LICENSE` file, which blocks any deliberate reuse or distribution decision.

## Requirement fit

| # | Requirement | Ours | Marco | Sberdia | Sertdisk | Usage-limits |
|---|---|---|---|---|---|---|
| 1 | Automatic provider + model selection | Yes | Partial (delegation) | Partial (per agent) | No (config only) | No |
| 2 | Least quota-expensive capable model | Yes | No | Partial | No | No |
| 3 | Weak models only for trivial work | Yes | Partial (prompt policy) | No | No | No |
| 4 | DeepSeek V4.1 Flash intelligence floor | Yes | Configurable | No | No | No |
| 5 | Vision requirement for visual tasks | Yes | Not enforced | No | No | No |
| 6 | UX / front-end design floor | Yes | Not enforced | No | No | No |
| 7 | Avoid premium spend | Yes | No quota model | Partial | No | No |
| 8 | Explicit premium approval | Yes | No | No | No | No |
| 9 | Both providers' usage windows | Yes | No | Go only | No | Display only |
| 10 | No unauthorised purchased credits | Yes | No | No | No | Display only |
| 11 | Cache-aware session affinity | Yes | Partial (cache-stable prompt) | No | No | No |
| 12 | Respect manual selections | Yes | Partial | Per-agent config | Per-agent config | n/a |
| 13 | Explain decisions | Yes | Partial | Scorecard | No | No |
| 14 | No billable classification calls | Yes | Yes | Yes | Yes | n/a |
| 15 | Safe when quotas/capabilities unknown | Partial (fail-open defect) | Partial | Partial | No | Display only |
| 16 | Many simultaneous projects | Yes (bridges) | Yes (leases/claims) | Weak (duplicate accounting) | Weak (per-location web server) | n/a |
| 17 | Supported desktop plugin API | Yes (v2 / 2.1.4) | Yes (v1 + v2 adapter) | No (v1) | Yes (v2) | No (TUI lane) |
| 18 | Lightweight and easy to disable | Partial (7.2K LOC) | No (120K LOC) | Yes | Partial | Yes (component) |

“Partial” means the mechanism exists but does not satisfy the requirement as written. Evidence for each cell is in `02-REPOSITORY-COMPARISON.md`.

## Weighted scorecard (as a foundation for this router)

Weights: stability 30%, functional fit 20%, quota 15%, simplicity 15%, performance 10%, security/SDK 10%.

| Candidate | Stability | Fit | Quota | Simplicity | Performance | Security/SDK | Weighted |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ours, repaired | 6.0 | 9.0 | 9.0 | 5.0 | 7.0 | 7.5 | **7.2** |
| Marco | 8.5 | 4.0 | 1.0 | 2.0 | 4.0 | 7.0 | **4.9** |
| Sberdia | 4.0 | 4.5 | 5.0 | 8.5 | 8.0 | 4.0 | **5.3** |
| Sertdisk | 3.0 | 2.5 | 0.5 | 7.0 | 6.0 | 5.0 | **3.6** |
| Usage-limits, as a foundation | 8.0 | 2.0 | 9.5 | 6.0 | 7.5 | 8.0 | **6.7** |
| Target hybrid (our engine, simplified) | 8.5 | 9.0 | 9.0 | 7.5 | 8.0 | 8.5 | **8.5** |

The “ours” stability score is deliberately moderate: the architecture is materially better than the incident build, but the fail-open defect and the missing final-build soak are real. The target score is an engineering target, not a measurement.

## Most serious remaining risks

1. **Silent fail-open on any unexpected router exception.** This is the single most important correctness gap. Fix by converting every routing exception into a blocked decision, and by validating configuration so the known throw cannot occur.
2. **Lifecycle assumptions that the host does not contractually guarantee.** Module scope, per-location setup, and globalThis sharing are observed on 2.1.4, not promised. The design should depend on the shared core's explicit registry, not on module-level variables.
3. **Undocumented quota endpoints.** Go `/zen/go/v1/usage` and Command Code `/alpha/*` are best-effort. They can change without notice. Keep them read-only, bounded, stale-aware, and non-authoritative.
4. **SDK drift.** The v2 plugin API is young. Marco's own v2 migration issue (#40) is evidence. Pin the host version and keep the bridge thin.
5. **Insufficient final-build evidence.** The last 30-minute soak predates the audit fixes. Any implementation phase must end with a fresh 20-location soak on the exact artifact proposed for installation.
6. **Documentation and license hygiene.** The docs contradict the code, and there is no license. Both undermine maintainability and any future reuse decision.

## Decision requested

Approve the repair-and-simplify direction in `06-RECOMMENDED-DESIGN.md` and the phased plan in `07-IMPLEMENTATION-ROADMAP.md`.

Implementation should not begin until that approval. Live installation requires a separate, explicit approval after the canary criteria are met.
