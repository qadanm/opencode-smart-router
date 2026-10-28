# 02 — Repository comparison

All repositories were cloned read-only into an isolated temp directory and inspected at the pinned commit. No project dependencies were installed except s-berdia's (to run its unit suite), and that install was confined to the audit clone.

## Verification

| Candidate | URL | Commit | Commit date | License | Stars | Open issues | npm |
|---|---|---|---|---|---:|---:|---|
| Ours | local working tree | n/a | 2026-10-27 | **none declared** | n/a | n/a | not published |
| Marco | `https://github.com/marco-jardim/opencode-model-router` | `d2837cc0d086bf814694811e359cf12a9c2c0a32` | 2026-10-26 | **GPL-3.0-only** | 142 | 15 | `opencode-model-router@2.9.1` (2026-10-25) |
| Sberdia | `https://github.com/s-berdia/Opencode_router` | `54256a9c42842ad878111425a440bc5e2f381f33` | 2026-10-26 | **MIT** | 0 | 5 | `@s-berdia/opencode-router@1.2.0` (2026-10-19) |
| Sertdisk | `https://github.com/sertdisk/OpenCode-Model-Router` | `0529a145e01b8c8eb588742b509eac2f852a963a` | 2026-10-15 | **MIT** | 4 | 0 | `@sertdisk/opencode-v2-agents-model-router@0.3.1` (2026-10-15) |
| Usage-limits | `https://github.com/mynameistito/opencode-plugins` | `151405a66fd74f00b34f771e0a073ab57b4df3f0` | 2026-10-27 | **MIT** | 4 | 6 | `@mynameistito/opencode-usage-limits@1.3.9` (2026-10-26) |

### URL discrepancy

The requested URL `https://github.com/s-berdia/opencode-router` returns **HTTP 404** (verified through the GitHub API and a direct request). The author's account exists and contains `s-berdia/Opencode_router`, whose description is “Automatic model routing and quota failover for OpenCode on the Go, Go Plus, and Free plans.” That repository is the one audited. Its README still calls the product “opencode-router”; only the repository name differs.

### Maintenance activity

- Marco: pushed the day before the audit; frequent releases; active CI; 15 open issues. It is the only candidate with a substantial community.
- Sberdia: created 2026-10-18, five open issues, npm release 2026-10-19. Very young and effectively single-maintainer.
- Sertdisk: no commits since 2026-10-15; no tests; no releases; two forks.
- Usage-limits: active monorepo; release on 2026-10-26; 27 test files in this package; 95% coverage gate.

## Repository profiles

### A. Ours (`~/Documents/opencode-smart-router`)

**What it is.** A server plugin for OpenCode 2.1.4 that intercepts prompt admission, classifies the task deterministically, filters models by hard requirements, prices the route (including cache loss and quota pressure), and calls `ctx.session.switchModel` before the request is sent.

**Verified in source**

- Entry: `src/index.ts` (29 lines), `Plugin.define` with a per-location controller.
- Routing: `src/core/routing/engine.ts` (539 lines) — deterministic, no model call.
- Classifier: `src/core/classify/classifier.ts` (305 lines).
- Eligibility: `src/core/policy/eligibility.ts` (246 lines).
- Lifecycle: `src/server/shared-core.ts` (502 lines) + `src/server/controller.ts` (1,536 lines).
- Quota: `src/core/quota/opencode-go.ts` (136), `commandcode.ts` (414), `service.ts` (206), `credentials.ts` (183), `ledger.ts` (672).
- Tests: 7 files, 77 tests; `npm test` and `npm run typecheck` pass (evidence: `evidence/our-tests.txt`).

**Verified by execution (pre-audit, this session)**

- 20 isolated locations, one process, one `globalThis` core, one storage namespace (`docs/evidence/sdk-sharing-probe.jsonl`, `docs/evidence/storage-sharing-probe.jsonl`).
- 20-project load: one core id, 21 bridges, one event stream, 16 commands in the sampled projects (p1 and p20).
- 30-minute mock-provider soak on an earlier build: 1,352 requests, one core id, 21 bridges, 483 setups / 462 disposes, zero thrash warnings, zero server errors, RSS 156–662 MB. **Not repeated on the final build.**
- Live fail-closed probe: prompt rejected with HTTP 500 and no provider request (`docs/evidence/fail-closed.txt`).

**Known defects / limitations**

- Fail-open on unexpected routing exceptions. Reproduced: a cost tier without `cache` throws at `engine.ts:113`; the hook swallows it at `controller.ts:807-811`.
- `src/index.ts` retains a module-level `active` controller and disposes it on each setup. The observed behaviour says module scope is per location, but the host does not guarantee that.
- `ctx.model.list()` is still called once per bridge (`controller.ts:237`), in the background.
- Docs drift: `docs/ARCHITECTURE.md` describes the pre-bridge design; `docs/LIMITATIONS.md` says prompt rejection is impossible.
- No licence file.
- The Command Code adapter relies on undocumented `/alpha/*` routes.

**API compatibility.** `@opencode/plugin` 2.1.4; `Plugin.define`; tested against the installed desktop server 2.1.4.

---

### B. Marco — `opencode-model-router`

**What it is.** A large “tiered delegation” system. An orchestrator model receives a routing protocol in its system prompt and delegates work to `fast` / `medium` / `heavy` subagents. The root model is not switched.

**Verified in source**

- v2 entry: `src/v2.ts:17-109`; v1 compatibility in `src/index.ts`; `server.ts` re-exports the v2 definition.
- Prompt hook: `src/compat/v2-hooks.ts:3055`.
- Delegation model pinning: `src/compat/v2-hooks.ts:3592` sets `args.model = tierModel` on subagent execution. This is real model selection **for the delegated child**, not for the current prompt.
- No `session.switchModel` call anywhere in `src/` (verified by grep).
- Process-wide claims/leases: `src/compat/background.ts:485-491`, `1961-1964` use `Symbol.for` keys on `globalThis`.
- Per-instance sweep timer: `src/compat/v2-hooks.ts:2637`, disposed at `2647`.
- v2 dispose barrier: `src/v2.ts:102-106`.

**Scale and quality signals**

- About 120,000 source lines (excluding tests) and 342 test files.
- CI workflows for tests, keyless smoke, upstream smoke, TUI, and publishing.
- Extensive docs (`docs/OPENCODE_V2.md`, `ROUTING_ENGINE.md`, `ENFORCEMENT.md`, `FLOW_DIAGRAMS.md`, …).
- Quality enforcement and escalation exist: `docs/ENFORCEMENT.md` and `src/escalate/ladder.ts` define verification and stronger-tier retries for delegated work. They were inspected, not executed.
- Six provider presets (Anthropic, OpenAI, GitHub Copilot, Google, hybrid, Zai) are documented in the README.
- Runtime dependencies: none declared; peer `@opencode-ai/plugin >=1.0.0 <2.0.0` (the peer range does not reflect the v2 support documented in `docs/OPENCODE_V2.md`; dev dependency is `@opencode/plugin 2.0.22`).

**Fit**

- No OpenCode Go or Command Code quota accounting. Grep found `opencode.ai/zen/go/v1` only in a routing example, not a usage probe.
- Routing is advisory/instructional for the root and enforced for subagents via model pinning. It cannot guarantee “the current prompt runs on the cheapest qualified model”.
- 3,249–6,357 characters of protocol overhead on every message (documented in the README).
- GPL-3.0-only: copying code into this repository would require relicensing the combined work under GPL.

**Verdict.** Excellent lifecycle and testing discipline to learn from; wrong product and wrong licence to adopt.

---

### C. Sberdia — `Opencode_router`

**What it is.** A role-based Go/Go Plus/free router. It writes per-agent models into `opencode.json`, hot-applies the config to a running server, and overrides `output.message.model` in the v1 `chat.message` hook.

**Verified in source**

- v1 plugin function export: `src/index.ts:49` (`export const OpencodeRouter: Plugin = async (input) => {`).
- Config hook rewrites agent models and commands: `src/index.ts:109-134`.
- Per-message model override: the `chat.message` hook at `src/index.ts:155-168` assigns `output.message.model = { providerID, modelID }` at line 167. This is genuine execution-time selection in the v1 API.
- Event accounting: `src/index.ts:173-208`; per-instance `recordedMessages` set at `src/index.ts:52`.
- Ledger: `src/ledger.ts:128-139` records and saves on every message; `sync()` reloads on mtime change (`src/ledger.ts:92-94`).
- Quota model: local rolling 5-hour / week / month ledger, allowance share from catalog prices (`src/ledger.ts`, `src/scoring.ts`), soft threshold 0.85 (`src/config.ts:5`). No provider usage API.
- Update check on setup: `src/index.ts:56`, `src/update.ts:12-14` (npm registry, 3 s timeout, cached).
- **No Command Code support** (grep across `src`, `README.md`, `USAGE.md` returns nothing).

**Tests (executed)**

`npm ci --ignore-scripts && npm test` at the pinned SHA: **13 files, 101 tests passed** (`evidence/sberdia-tests.txt`).

**Fit and risks**

- Targets plugin API **1.19** (README), not the v2 API used by desktop 2.1.4. The v1 function export fails v2 module validation (`docs/OPENCODE_V2.md` in marco documents the exact failure: `Expected object at ["default"]`). It would need a v2 adapter/port before it could load here.
- No task classification, no intelligence/vision/design floors, no premium policy, no fail-closed, no cache-affinity pricing.
- Multi-location: the v1 event hook is process-wide; each plugin instance has its own `recordedMessages`, and the ledger is a read-modify-write JSON file with last-writer-wins. With N locations, the same assistant message can be counted N times and increments can be lost.
- The ledger/allowance estimate is useful and simple; the cooldown/health model is a good idea.

**Verdict.** Best *conceptual* reference for Go allowance failover, and MIT. Not a base: v1 API, Go-only, missing most requirements.

---

### D. Sertdisk — `OpenCode-Model-Router`

**What it is.** A v2 plugin plus local web UI that writes primary/secondary/tertiary model chains into `opencode.json` (or `oh-my-opencode-slim` config). It is a configuration editor with a retry hook placeholder.

**Verified in source**

- Single file, 1,497 lines; `export default { id: "opencode-model-router", setup }` at the end.
- Hardcoded state path: `src/model-router.js:38` — `C:\Users\Hb\.config\opencode\model-router.json`. On macOS this is not a valid path; writes either fail or create a literal filename in the working directory. (A `MODEL_ROUTER_STATE_PATH` override exists at line 607 for tests.)
- Local web server on port 37337, started from `setup` (`src/model-router.js:595-1466`), with Bun/Node fallback and a disposer. Each loaded location attempts to bind the same port; failures are logged and ignored.
- Retry hook logs only; steering is explicitly “next phase”: `src/model-router.js:575-590` (`event.decision` is not touched).
- Plugin id collides with marco's id (`opencode-model-router`).
- The `/model-router` command provides an interactive question flow, and the web UI writes chains for plain OpenCode or `oh-my-opencode-slim` (preserving reasoning variants). Both are configuration workflows.
- No test files and no CI workflows.
- Zero runtime dependencies; MIT.

**Fit**

- Not a router at execution time. It can arrange fallback chains for a host or for oh-my-opencode-slim, but it does not itself switch models on failure.
- No quota awareness, no classifier, no vision/design/premium policy.
- The web UI is a genuine convenience, but it is out of scope for the stability-first goal.

**Verdict.** Reject. The hardcoded path, per-location server, absent tests, and id collision are disqualifying for daily use.

---

### E. Usage-limits — `@mynameistito/opencode-usage-limits`

**What it is.** A TUI plugin that displays provider usage in the sidebar and prompt footer. It is not a server plugin and does not route.

**Verified in source**

- OpenCode Go adapter: `src/providers/opencode-go.ts:29` default base URL `https://opencode.ai/zen/go/v1`; request to `${baseUrl}/usage` (~line 130); parses `usage.rolling|weekly|monthly` with `percent` and `resetsAt`.
- Command Code adapter: `src/providers/commandcode.ts:31-33` — `/alpha/whoami`, `/alpha/billing/credits`, `/alpha/usage/summary`; parses `windowLimits.fiveHour|weekly` (`used`, `cap`, `resetAt`) and derives a monthly window from `monthlyCredits + purchasedCredits + freeCredits + spent`.
- Bounded HTTP: 2 MB response cap, abort/timeout, rate-limit classification, `retry-after` parsing (`src/providers/runtime/http.ts`).
- Refresh loop: default 60 s, minimum 15 s (`src/config.ts:71`, `src/coordinator.ts:60-61`), concurrent provider fetches, stale after two intervals, last-success retained on failure (`src/coordinator.ts:118-330`).
- Credentials: OpenCode `auth.json` first, then configured auth file/env (`src/config.ts:41-57`, `src/providers/opencode-go.ts` key fallback).
- Lifecycle: a scoped Effect fiber started in the TUI slot; disposer interrupts it (`src/plugin.tsx:190-196`).
- Tests: 27 test files; test script enforces 95% coverage on lcov (`package.json`).

**Dependencies and lane**

- Runtime `effect` and `@opencode/plugin`; peers `@opentui/core`, `@opentui/solid`, `solid-js`.
- Configured in `cli.json` as a TUI plugin (`opencode2 plugin add … -g`). It does not register server hooks and cannot switch models.

**Fit**

- As a router: none.
- As a quota component: excellent. Endpoint coverage, edge cases, and test oracles are directly useful. Our own adapters already hit the same endpoints, so the practical reuse is **tests and semantics**, not code.

**Verdict.** Reuse the adapter design and tests as a reference; do not add it as a runtime dependency.

## Capability comparison

| Dimension | Ours | Marco | Sberdia | Sertdisk | Usage-limits |
|---|---|---|---|---|---|
| Real per-prompt model switch | **Yes** (`session.switchModel`) | No (root); child pinning | Yes (v1 `message.model`) | No | No |
| Instruction-based delegation | No | **Yes** | No | No | No |
| Task classifier | **Deterministic** | Heuristic + orchestrator | No | No | No |
| Intelligence floor | **Yes** | Configurable tiers | No | No | No |
| Vision requirement | **Yes** | Not enforced | No | No | No |
| Design floor | **Yes** | Not enforced | No | No | No |
| Go usage windows | **Yes** | No | Local estimate | No | **Yes (display)** |
| Command Code windows | **Yes** | No | No | No | **Yes (display)** |
| Premium approval | **Yes** | No | No | No | No |
| Cache-affinity pricing | **Yes** | Prompt-cache stability | No | No | No |
| Manual override detection | **Yes** | Partial | Config-level | Config-level | n/a |
| Fail-closed admission | **Yes, with a gap** | No | No | No | n/a |
| Multi-project lifecycle | **Shared core + bridges** | Global leases/claims | Per-instance, duplicate risk | Per-instance web server | TUI single lane |
| v2 API | **Yes** | Yes (adapter) | No (v1) | Yes | TUI v2 |
| Tests | 77 pass | 342 files | 101 pass | 0 | 27 files, 95% gate |
| Runtime deps | 1 (`@opencode/plugin`) | 0 | 0 | 0 | Effect + TUI peers |
| Licence | none | GPL-3.0 | MIT | MIT | MIT |

## Lifecycle handling comparison

| Question | Ours | Marco | Sberdia | Sertdisk | Usage-limits |
|---|---|---|---|---|---|
| Work done in `setup` | Storage hydration, commands/RPC/hooks; models in background | Config load, executor prep, hooks, timers | Config read, update check, hooks | Agent/catalog probing, state read, **web server bind** | TUI slots + coordinator fiber |
| Network on load path | No (delayed quota/bootstrap) | No (catalog is local) | **Yes** (npm update check, async) | Local SQLite/HTTP-free | No |
| Shared state | `globalThis` core | `globalThis` leases/claims | None (JSON file) | State file | Effect fiber |
| Timers per location | **0** (core owns all) | Sweep timer per instance | 0 | 0 | 1 coordinator (TUI) |
| Event subscription | **1** per process (core) | Per instance, with claims | Per instance (v1 global events) | Per instance | n/a |
| Disposal | Bridge registrations + core grace | Registration dispose + dispose barrier | None (no resources) | Disposers + server close | Fiber interrupt |
| Duplicate registration risk | Low (location-scoped) | Managed | Low | **Port/id collision** | n/a |

## Dependencies and supply chain

| Candidate | Runtime | Dev/build | Notes |
|---|---|---|---|
| Ours | `@opencode/plugin@2.1.4` | TypeScript, Vitest, esbuild | Minimal |
| Marco | None declared | Large dev stack incl. `solid-js`, `@lydell/node-pty`, `@xterm/headless` | The pty/terminal test harness is for smoke tests, not runtime |
| Sberdia | None | `tsup`, `vitest`, `jsonc-parser`, TypeScript | Minimal |
| Sertdisk | None | None | Zero-dependency single file |
| Usage-limits | `effect`, `@opencode/plugin` | `tsdown`, `vitest`, `ultracite`, `knip`; peers `@opentui/*`, `solid-js` | Heavy for a server plugin |

## Known issues and maintenance signals

- **Marco:** 15 open issues; the v2 migration itself was issue #40. The codebase is a second product with its own executor, guard, leases, and TUI.
- **Sberdia:** five open issues (#1 version display, #2 checked scores, #3 command output markers); very young repository; no evidence of multi-project testing.
- **Sertdisk:** zero open issues and zero tests; no commits since 2026-10-15; Windows-first.
- **Usage-limits:** six open issues, all feature requests for additional providers; strong release cadence and test discipline.
- **Ours:** two verified defects and docs drift; no community or external issue tracker.

## What was not verified

- Marco's 342 test files, smoke suites, and live lifecycle behaviour were **not executed**. The repository is large and GPL-3.0; running its smoke suite would require provider credentials and a substantial environment.
- Usage-limits' suite was **not executed** because it is a Bun workspace with `catalog:` dependencies and OpenTUI peers. Its source and test structure were inspected.
- Sertdisk has no tests to run.
- No live paid provider request was made for any candidate. Quota endpoint behaviour is taken from source and, for our adapters, from earlier isolated probes.
