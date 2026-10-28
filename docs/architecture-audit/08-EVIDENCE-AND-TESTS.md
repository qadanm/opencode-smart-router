# 08 — Evidence and tests

## Environment

| Item | Value |
|---|---|
| Date | 2026-10-27 (UTC), late session |
| Host | macOS (Apple Silicon), OpenCode Desktop 2.1.4 |
| Node | v24.11.0 |
| npm | 11.21.1 |
| Bun | 1.3.14 (available; not used for the audit) |
| Live config | unchanged; router plugin absent; no restart |
| Live server | untouched |
| Test isolation | separate `HOME`, `XDG_*`, data/cache dirs, ports 4200–4211 |
| Provider credentials | fake lab keys only; no real credits spent |

## What was inspected

### Ours

- `src/index.ts`, `src/server/shared-core.ts`, `src/server/controller.ts`, `src/rpc.ts`
- `src/core/config.ts`, `src/core/types.ts`, `src/core/failures.ts`
- `src/core/routing/engine.ts`, `src/core/policy/eligibility.ts`, `src/core/classify/classifier.ts`
- `src/core/quota/{ledger,service,opencode-go,commandcode,credentials}.ts`
- `src/core/models/{registry,seed}.ts`, `src/core/ui.ts`
- `test/*.ts` (7 files), `docs/*.md`, `docs/evidence/*`
- Disabled bundle: `~/Documents/opencode-smart-router-disabled-20261027-160033/index.js`

### Marco (`d2837cc`)

- `package.json`, `README.md`, `docs/OPENCODE_V2.md`, `docs/ROUTING_ENGINE.md`
- `src/v2.ts`, `src/index.ts`, `src/compat/v2-hooks.ts`, `src/compat/background.ts`
- `src/escalate/*`, `src/router/*` (targeted)
- `test/` inventory (342 test files), `.github/workflows/*`

### Sberdia (`54256a9`)

- `package.json`, `README.md`, `USAGE.md`, `src/index.ts`, `src/engine.ts`, `src/ledger.ts`, `src/scoring.ts`, `src/update.ts`, `src/config.ts`
- `tests/*` (13 files)
- CI workflow

### Sertdisk (`0529a14`)

- `package.json`, `README.md`, `src/model-router.js` (single file, 1,497 lines), `web/` inventory, `tools/`

### Usage-limits (`151405a`)

- `package.json`, `README.md`, `usage-limits.schema.json`
- `src/plugin.tsx`, `src/coordinator.ts`, `src/config.ts`, `src/config-schema.ts`
- `src/providers/opencode-go.ts`, `commandcode.ts`, `auth-file.ts`, `runtime/http.ts`
- `__tests__/` inventory (27 test files) and representative provider tests

## What was executed

### 1. Our suite

```bash
cd ~/Documents/opencode-smart-router
npm run typecheck
npm test
```

Result: typecheck clean; **7 files, 77 tests passed**. Saved in `evidence/our-tests.txt`.

### 2. Deterministic fail-open reproduction

A temporary test (created, run, deleted) called `estimateTaskCost` with a model whose cost tier omitted `cache`.

Result: `TypeError: Cannot read properties of undefined (reading 'read')` at `src/core/routing/engine.ts:113`. The test passes because it asserts the throw. Saved with source in `evidence/engine-cost-repro.txt`.

### 3. Live fail-open observation (isolated server)

Lab: isolated HOME, port 4210, fake provider, `routing.failClosed=true`, one definition with a cost tier lacking `cache`.

Observed route log:

```text
route-start → route-loaded → route-task → (no route-record)
```

RPC status: `lastDecision = null`, no router warning. The prompt reached the fake provider and returned 401. The provider was not blocked. Saved in `evidence/lab9-fail-open.txt`.

### 4. Sberdia unit suite

```bash
git clone https://github.com/s-berdia/Opencode_router
git checkout 54256a9c42842ad878111425a440bc5e2f381f33
npm ci --ignore-scripts
npm test
```

Result: **13 files, 101 tests passed**. Saved in `evidence/sberdia-tests.txt`.

### 5. Earlier lifecycle probes (pre-audit, same session)

These were run before the audit request, on the rebuilt architecture. They are evidence about the host and the earlier build, not about the final artifact.

| Probe | Result |
|---|---|
| 20 locations, one server | one PID, one `globalThis` core, 133 setup events, one storage namespace |
| Plugin storage cross-location | location 1 write read by location 2 |
| 20-project load | one core, 21 bridges, one event stream, 16 commands in sampled projects (p1, p20) |
| Fail-closed live | HTTP 500, `BLOCKED` title, no provider request |
| 30-minute soak (earlier build) | 1,352 mock requests, one core, 21 bridges, 483 setups / 462 disposes, zero thrash, zero server errors, RSS 156–662 MB |

Raw files: `docs/evidence/sdk-sharing-probe.jsonl`, `docs/evidence/storage-sharing-probe.jsonl`, `docs/evidence/shared-core-diagnostics-20-projects.json`, `docs/evidence/fail-closed.txt`.

### 6. Repository metadata

GitHub API and npm registry queries recorded in `evidence/repositories.json`; full comparison in `02-REPOSITORY-COMPARISON.md`.

## What was not executed

| Item | Why | Consequence |
|---|---|---|
| Marco test suite (342 files) | 120K source lines; smoke tests need provider credentials; GPL | Claims about marco are source/documentation-based, not executed |
| Usage-limits test suite | Bun workspace with `catalog:` deps and OpenTUI peers; TUI lane | Its adapters are treated as a reference/test oracle; its tests were read, not run |
| Sertdisk tests | None exist | No execution possible |
| Live desktop canary | Requires approval | Not attempted |
| Real provider quota probes | Would spend/read real account state | Fake lab providers only |
| Final-build 30-minute soak | Audit stopped the rebuild work | Must be a Phase 5 gate before any install |

## Reproduction

### Repositories

```bash
AUDIT="$TMPDIR/opencode/router-audit"
mkdir -p "$AUDIT/repos"
cd "$AUDIT/repos"

git clone --depth 50 https://github.com/marco-jardim/opencode-model-router.git
git -C opencode-model-router checkout d2837cc0d086bf814694811e359cf12a9c2c0a32

git clone --depth 50 https://github.com/s-berdia/Opencode_router.git sberdia-opencode-router
git -C sberdia-opencode-router checkout 54256a9c42842ad878111425a440bc5e2f381f33

git clone --depth 50 https://github.com/sertdisk/OpenCode-Model-Router.git sertdisk-model-router
git -C sertdisk-model-router checkout 0529a145e01b8c8eb588742b509eac2f852a963a

git clone --depth 50 https://github.com/mynameistito/opencode-plugins.git
git -C opencode-plugins checkout 151405a66fd74f00b34f771e0a073ab57b4df3f0
```

### Fail-open reproduction

```bash
cd ~/Documents/opencode-smart-router
cat > test/audit-repro.test.ts <<'EOF'
import { describe, expect, it } from "vitest"
import { classifyTask } from "../src/core/classify/classifier.js"
import { estimateTaskCost } from "../src/core/routing/engine.js"
import type { ModelRecord } from "../src/core/types.js"

describe("audit reproduction", () => {
  it("estimateTaskCost throws when a user cost tier omits cache pricing", () => {
    const model = {
      key: "lab/x", providerID: "lab", modelID: "x", name: "X",
      context: 200000, maxOutput: 8192, inputModalities: ["text"],
      cost: [{ input: 0.1, output: 0.2 }],
      intelligence: 45, design: 65, tier: 2, approved: true,
      premium: false, training: false, free: false, monthlyAllowanceUsd: 100,
    } as unknown as ModelRecord
    const task = classifyTask({ text: "Implement a feature in src/app.ts", files: [], contextTokens: 0, recentFailures: 0 })
    expect(() => estimateTaskCost({ model, task, contextTokens: 1000, currentModelKey: model.key })).toThrow(TypeError)
  })
})
EOF
npx vitest run test/audit-repro.test.ts
rm -f test/audit-repro.test.ts
```

### Sberdia suite

```bash
cd "$TMPDIR/opencode/router-audit/repos/sberdia-opencode-router"
npm ci --ignore-scripts
npm test
```

## Evidence files in this packet

| File | Contents |
|---|---|
| `evidence/repositories.json` | Pins, URLs, test status, host API, licences |
| `evidence/our-tests.txt` | Typecheck + 77-test run |
| `evidence/engine-cost-repro.txt` | Test source + output for the `cache` TypeError |
| `evidence/lab9-fail-open.txt` | Instrumented route log, null decision, cause chain |
| `evidence/sberdia-tests.txt` | 13-file / 101-test run |
| `evidence/sdk-lifecycle-probes.txt` | Summary of the host sharing/storage/fail-closed probes |

## Claims matrix

| Claim | Label | Evidence |
|---|---|---|
| 20 locations share one process and `globalThis` | Verified (executed) | Probe log |
| Plugin storage is process-global | Verified (executed) | Probe log |
| Prompt-hook throw rejects admission | Verified (executed) | HTTP 500, no model |
| A routing exception bypasses fail-closed | Verified (executed) | Engine test + lab log |
| The current build passes 77 tests | Verified (executed) | `our-tests.txt` |
| Sberdia passes 101 tests | Verified (executed) | `sberdia-tests.txt` |
| Sberdia targets v1, not v2 | Verified (source) | `package.json`, `src/index.ts`, README |
| Marco does not switch the root model | Verified (source) | No `switchModel`; `args.model` only for subagents |
| Marco has no Go/CC quota accounting | Verified (source) | Grep; docs |
| Sertdisk state path is Windows-only | Verified (source) | `src/model-router.js:38` |
| Sertdisk has no tests | Verified (executed find) | 0 test files |
| Usage-limits adapters cover both providers | Verified (source + tests) | Provider files and 27 test files |
| The incident had 420 plugin loads | Documented | Incident report / debug bundle |
| The exact restart cause was memory exhaustion | Unknown | No post-mortem trace |
| The final build is stable for 30 minutes | Unknown | Final-build soak was not completed |

## Honesty statement

The audit did not claim production readiness. The strongest evidence is about the host model, the lifecycle failure mode, the quota endpoints, and the fail-open defect. The weakest evidence is about long-run stability of the final artifact, because the final-build soak was stopped when the mission changed to an audit. That gap is explicit in the roadmap and must be closed before any live deployment.
