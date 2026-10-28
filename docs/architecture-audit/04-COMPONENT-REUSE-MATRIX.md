# 04 — Component reuse matrix

No third-party code was copied into our repository during this audit. This document records what is worth reusing, how, and under which constraints.

## Decision vocabulary

| Decision | Meaning |
|---|---|
| **Direct** | Could be used as a dependency or copied with attribution, with little adaptation |
| **Vendor** | Copy a small, self-contained piece with its licence notice and adapt it |
| **Concept** | Reimplement the idea in our architecture; no code copied |
| **Test oracle** | Use the external tests/edge cases to validate our own implementation |
| **Reject** | Not suitable for licensing, architecture, quality, or scope reasons |

## Matrix

| Component | Source (pinned commit) | Licence | Decision | Integration difficulty | Why |
|---|---|---|---|---|---|
| Go usage adapter | `opencode-plugins/.../src/providers/opencode-go.ts` @ `151405a` | MIT | **Concept + test oracle** | Low | Same endpoint we already use. Its tests cover auth-file fallback, missing keys, malformed payloads, and percentage parsing. |
| Command Code adapter | `.../src/providers/commandcode.ts` @ `151405a` | MIT | **Concept + test oracle** | Low–medium | Same `/alpha/*` routes plus subscription/summary handling. Our adapter is broader (credits + subscriptions + period-aware summary); its tests are valuable. |
| Bounded HTTP client | `.../src/providers/runtime/http.ts` @ `151405a` | MIT | **Concept** | Low | 2 MB cap, abort, `retry-after`, typed transport/rate-limit/timeout failures. We already cap bodies and timeouts; add `retry-after` and typed classification. |
| Stale-data coordinator | `.../src/coordinator.ts` @ `151405a` | MIT | **Concept** | Low | Retain last success, mark stale after 2 intervals, fetch providers concurrently, minimum 15 s. We already have single-flight and backoff; add explicit stale state per provider. |
| OpenCode auth discovery | `.../src/config.ts` + provider key fallbacks | MIT | **Concept** | Low | Reads `auth.json` first, then configured/env credentials. Our `credentials.ts` already discovers OpenCode integration and CLI-compatible keys; compare for gaps. |
| Command Code monthly window derivation | `.../src/providers/commandcode.ts:189-240` | MIT | **Concept** | Low | `monthlyCredits + purchasedCredits + freeCredits + spent`. Confirms our own model. |
| Go weekly/monthly windows | `.../src/providers/opencode-go.ts` | MIT | **Concept** | Low | Confirms the `usage.rolling/weekly/monthly` shape and reset parsing. |
| Per-model cooldown / role health | `sberdia/src/engine.ts:84-130`, `src/index.ts:92-105` | MIT | **Concept** | Low | Simple, understandable failover: bench a model for an hour after 429/402, bench the whole Go allowance after a usage-limit error, fall back to free. |
| Allowance-share model | `sberdia/src/ledger.ts`, `src/scoring.ts` | MIT | **Concept** | Medium | Estimates how much of a shared allowance each model consumes. Our ledger already has per-model cost; we can add a shared-allowance share for Go. |
| mtime-based ledger sync | `sberdia/src/ledger.ts:92-94` | MIT | **Reject for us** | Low | Useful for multi-process file sharing, but our design is one process and one writer. Adding file sync would introduce the races it tries to solve. |
| v1 `output.message.model` override | `sberdia/src/index.ts:167` | MIT | **Reject** | n/a | v1 API; v2 uses `session.switchModel`. The concept (mutate before dispatch) maps to our prompt hook. |
| Tiered delegation protocol | `marco/src/compat/v2-hooks.ts`, `src/router/*` | GPL-3.0 | **Reject as code; concept only** | High | Different product philosophy; 3–6 K prompt overhead; no quota; GPL would force relicensing. |
| Process-wide leases/claims | `marco/src/compat/background.ts:483-491` | GPL-3.0 | **Concept only** | Medium | Validates `globalThis` coordination and ownership. Our core already provides a simpler version. Do not copy. |
| Dispose barrier / registration tracking | `marco/src/v2.ts:102-106`, `src/index.ts:1945-1967` | GPL-3.0 | **Concept only** | Low | Confirms idempotent disposal and shared cleanup barriers. Our bridge dispose already follows this shape. |
| Cache-stable prompt prefix | `marco/docs/OPENCODE_V2.md` | GPL-3.0 (doc) | **Concept only** | Medium | Keep stable system content; deliver per-turn state separately. Our router does not rewrite prompts, so the risk is lower. |
| Per-agent model chains | `sertdisk/src/model-router.js` | MIT | **Reject** | n/a | Config-level failover, not runtime routing; hardcoded path; no tests. |
| Local web UI | `sertdisk/web/*` | MIT | **Reject for now** | High | Out of scope; stability first. Can be revisited after the router is stable. |
| TUI usage panel | `opencode-plugins/.../src/plugin.tsx` | MIT | **Reject as dependency** | High | OpenTUI/Effect peers; different lane. |
| Quota adapter tests | `.../__tests__/providers/opencode-go.test.ts`, `commandcode.test.ts` | MIT | **Test oracle** | Low | Reproduce the cases in our Vitest suite using fake `fetch`. |
| Provider error taxonomy | `.../src/errors/*` | MIT | **Concept** | Low | Distinguish missing credentials, timeout, transport, rate limit, decode. Our `failures.ts` covers model errors; quota errors are less typed. |

## Direct-reuse assessment

### Why not depend on `opencode-usage-limits` directly?

1. **Wrong lane.** It is a TUI plugin configured in `cli.json`; it does not register server hooks and cannot call `session.switchModel`.
2. **Dependency weight.** `effect`, `@opencode/plugin`, and peer `@opentui/core`, `@opentui/solid`, `solid-js`. A server plugin would inherit a UI-oriented stack for two HTTP calls.
3. **Version coupling.** The provider runtime is internal to the package (`@/providers/runtime/*`), not a documented public API. Importing it would be brittle.
4. **We already implement the endpoints.** Our adapters cover Go and Command Code, including credits and subscriptions. The missing value is edge-case coverage, which we can reproduce.

### Why not vendor the adapters verbatim?

They are MIT, so vendoring is legally possible with a notice. But they are written in Effect, with service layers (`ProviderEnvironment`, `ProviderHttpClient`, `ProviderFileSystem`) and schema decoding. Adapting them to our dependency-free style would cost more than reimplementing the 20–30 lines of parsing per endpoint. **Use them as executable specifications.**

### Why not reuse sberdia code?

The MIT licence permits it, and the ledger/health logic is small. But:

- It is v1-oriented; its model application path does not exist in v2.
- Its ledger is a read-modify-write JSON file, which we deliberately do not want.
- Its role model (plan/build/explore) is not a task classifier.

The useful part is the *policy idea*: per-model cooldown and a shared-allowance cooldown. That is ~40 lines in our types, and we can write tests that match its behaviour.

### Marco: concepts only

Marco is GPL-3.0-only. Copying any of its code into this repository would make the combined work a derivative and require GPL distribution terms. Even if that were acceptable, the code is coupled to its own executor, guard, leases, and config system. The transferable ideas are:

- explicit process-wide ownership (`Symbol.for` keys);
- one claim per session, with stale-claim recovery;
- a dispose barrier shared by concurrent cleanup callers;
- cache-stable prompt construction.

Those are already reflected in our core or can be implemented independently.

## Licence obligations if we later vendor MIT code

If a future phase copies any MIT-licensed code (from sberdia, sertdisk, or usage-limits), the repository must:

1. Include the original copyright notice and the MIT permission text.
2. State which files contain the adapted code and the source commit.
3. Keep the notice in the bundled artifact if the code is distributed.

For GPL-3.0 code (marco), do not copy. A concept reimplementation is not a derivative work, but a line-by-line translation would be. Keep the boundary explicit in the commit message and code comments.

## Combining plugins: conflict analysis

| Combination | Conflict |
|---|---|
| Ours + marco | Both register prompt/context/retry hooks. Marco injects a routing protocol and creates subagent tools; ours switches the root model. The two policies would fight. Also GPL if code is shared. |
| Ours + sberdia | Sberdia rewrites agent models in the config hook; ours switches per prompt. On v1 they could coexist awkwardly; on v2 sberdia does not load. Duplicate ledger files and duplicate update checks. |
| Ours + sertdisk | Sertdisk takes over agent configs and starts a web server; ours routes per prompt. Its retry hook only logs, so no direct fight, but config ownership is ambiguous. |
| Ours + usage-limits | Clean separation: usage-limits displays quota in the TUI; ours reads the same endpoints. Two pollers would double the request rate (still read-only). Prefer one poller: ours, with the TUI disabled for Go/CC, or accept the duplicate read-only load. |
| Marco + sertdisk | **Plugin id collision** (`opencode-model-router`). Do not install together. |

## Component verdicts

| Component | Verdict |
|---|---|
| Quota endpoint knowledge and edge-case tests | **Adopt as reference/tests** |
| Typed quota errors + stale semantics | **Adopt as concepts** |
| Per-model cooldown / shared allowance | **Adopt as concept** |
| Ledger file sync | **Do not adopt** |
| v1 message-model override | **Do not adopt** |
| Delegation protocol | **Do not adopt** |
| Web UI | **Defer** |
| TUI package as dependency | **Do not adopt** |
| GPL code | **Do not copy** |
