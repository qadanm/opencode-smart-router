# Paperclip Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@qadanm/paperclip-router`, a Paperclip plugin that chooses the right connection-pool member per task from task class, subscription usage windows, continuity, and failure memory, with a decision page that explains every choice.

**Architecture:** A thin worker wires Paperclip's `onRouteAiConnection` hook to a pure decision function. The pure core (classification, window scoring, ranking, skip text, failure classification) has no host imports and is fully unit tested. Plugin state holds a bounded, company-keyed decision ring and a short-TTL failure memory. A React page, fed by `ctx.data`, renders the decisions and member state.

**Tech Stack:** TypeScript (strict), Node 24.11+, `@paperclipai/plugin-sdk` and `@paperclipai/shared` pinned at `2026.1023.0`, React 19 for the page, Vitest, tsc for build, npm distribution.

**Spec:** `docs/superpowers/specs/2026-11-05-paperclip-router-design.md`

## Global Constraints

- Plugin id `qadan.paperclip-router`; npm name `@qadanm/paperclip-router`; package type `module`; `engines.node >= 24.11.0`.
- Pin `@paperclipai/plugin-sdk` and `@paperclipai/shared` to exactly `2026.1023.0`. Do not use `^` or `latest`; the plugin runtime is alpha.
- Manifest capabilities, exactly: `ai.connections.route`, `issues.read`, `events.subscribe`, `plugin.state.read`, `plugin.state.write`, `ui.page.register`, `agents.read`. No others without a task that needs them.
- `multiCompanyConfig: true`; every state key is partitioned by `companyId`.
- The route hook must never exceed its 5 second budget and must never throw: catch everything and return `{ kind: "selected", memberId: <first candidate> }` as the last resort (a valid member is always better than a blocked run).
- Never return `exhausted` or `unavailable` unless every candidate is observed and over its limit; missing usage is unknown, not exhausted.
- Always return `pinnedMemberId` when present.
- No network calls, no credential access, no writes inside the route hook or inside the pure core.
- Decision text is user facing: plain sentences, no jargon, no emoji, no dashes as connectors.
- Every module in `src/core/` imports nothing except other `src/core/` modules and `node:` types. The selection result type is defined locally as `RouteResult` (structurally identical to the SDK's `AiConnectionRouterResult`) so the core stays host-free; the worker returns it and TypeScript checks the assignment.

## Review Focus

1. An autonomous run with no usage observations must still route sensibly and never deadlock the company. Test: Task 5, `routes on tier and fairness when no usage is observed`.
2. Empty or errored usage payloads (`limits: []`, `status: "error"`) must not read as "over limit". Tests: Task 3, `treats empty and errored usage as unknown`; Task 5, `returns unavailable only when every candidate is observed and blocked`.
3. A pinned task must keep its member even when failure memory dislikes it. Test: Task 5, `always returns the pinned member`.
4. Model tiers must use the effective model (`runtimeConfig.model`), and unknown models must be tier 2 with a note, never silently ineligible. Tests: Task 4, `uses the runtime model and treats unknown models as tier 2`.
5. State writes must never sit in the route path, and the decision ring must stay bounded. Tests: Task 6, `ring keeps the newest entries under its cap`; integration assertion in Task 7 that the hook does not call state.set.

---

### Task 1: Repository, package, and manifest

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- Create: `src/manifest.ts`, `src/worker.ts`, `src/index.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `manifest` default export typed `PaperclipPluginManifestV1`; `worker.ts` default export `PaperclipPlugin` from `definePlugin` with `onRouteAiConnection` defined (a stub returning the first candidate in this task); package scripts `build`, `typecheck`, `test`, `check`.

- [ ] **Step 1: Create the repository and package**

```bash
gh repo create qadanm/paperclip-router --public --description "Subscription-aware, task-aware connection-pool routing for Paperclip"
mkdir -p "$HOME/Documents/dev/paperclip-router" && cd "$HOME/Documents/dev/paperclip-router"
git init -q && git remote add origin https://github.com/qadanm/paperclip-router.git
```

Create `package.json` with: name `@qadanm/paperclip-router`, version `0.1.0`, type module, `exports: { ".": "./dist/manifest.js" }`, `paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js", ui: "./dist/ui/" }`, `files: ["dist", "README.md", "LICENSE"]`, engines node `>=24.11.0`, scripts: `build: "tsc -p tsconfig.build.json"`, `typecheck: "tsc --noEmit"`, `test: "vitest run"`, `check: "npm run typecheck && npm run test"`, `prepublishOnly: "npm run check && npm run build"`. Dependencies: `@paperclipai/plugin-sdk` and `@paperclipai/shared` exact `2026.1023.0`. Dev: `typecheck` deps plus `vitest`, `typescript`, `react`, `react-dom`, `@types/react`, `@types/react-dom`.

- [ ] **Step 2: Write the failing manifest test**

```ts
// test/manifest.test.ts
import { describe, expect, it } from "vitest"
import manifest from "../src/manifest.js"

describe("plugin manifest", () => {
  it("declares exactly the capabilities the plugin uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agents.read",
      "ai.connections.route",
      "events.subscribe",
      "issues.read",
      "plugin.state.read",
      "plugin.state.write",
      "ui.page.register",
    ])
  })
  it("declares the connection router descriptor", () => {
    expect(manifest.aiConnectionRouter?.name).toBe("Smart Router pool")
    expect(manifest.aiConnectionRouter?.description.length).toBeGreaterThan(0)
  })
  it("registers the decisions page", () => {
    expect(manifest.ui?.slots).toContainEqual({
      type: "page",
      id: "router-decisions",
      displayName: "Smart Router",
      exportName: "RouterDecisionsPage",
      routePath: "router",
    })
  })
  it("builds for Paperclip 1 and Node 24", () => {
    expect(manifest.apiVersion).toBe(1)
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js")
    expect(manifest.entrypoints.ui).toBe("./dist/ui")
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/manifest.test.ts`
Expected: FAIL, cannot resolve `../src/manifest.js`.

- [ ] **Step 4: Implement manifest and worker stub**

`src/manifest.ts` default-exports the manifest matching the test verbatim (id `qadan.paperclip-router`, categories `["developer-tools"]`, author "Moe Qadan"). `src/worker.ts`:

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk"
const plugin = definePlugin({
  multiCompanyConfig: true,
  async setup() {},
  async onRouteAiConnection(request) {
    const first = request.candidates[0]
    return first ? { kind: "selected", memberId: first.member.id } : { kind: "unavailable", skipped: {} }
  },
})
export default plugin
runWorker(plugin, import.meta.url)
```

Add `src/index.ts` re-exporting the manifest for tests.
- [ ] **Step 5: Verify pass and typecheck**

Run: `npx vitest run test/manifest.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold the Paperclip router plugin and manifest"
git push -u origin main
```

### Task 2: Task classification

**Files:**
- Create: `src/core/classify.ts`
- Test: `test/classify.test.ts`

**Interfaces:**
- Produces: `interface TaskClass { kind: "mechanical" | "docs" | "test" | "feature" | "debug" | "refactor" | "security" | "architecture" | "design" | "unknown"; tier: 1 | 2 | 3; signals: string[] }` and `classifyTask(input: { title: string; description?: string; labels?: readonly string[] }): TaskClass`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/classify.test.ts
import { describe, expect, it } from "vitest"
import { classifyTask } from "../src/core/classify.js"

describe("classifyTask", () => {
  it("keeps a narrow rename at tier 1", () => {
    const task = classifyTask({ title: "Rename the settings button label" })
    expect(task.kind).toBe("mechanical")
    expect(task.tier).toBe(1)
  })
  it("puts an architecture migration at tier 3", () => {
    const task = classifyTask({ title: "Migrate the billing service to event sourcing" })
    expect(task.kind).toBe("architecture")
    expect(task.tier).toBe(3)
  })
  it("treats a stack trace as debug work", () => {
    const task = classifyTask({ title: "Checkout crash on iPad", description: "TypeError: undefined is not a function\n  at render (app.js:42)" })
    expect(task.kind).toBe("debug")
    expect(task.signals).toContain("stack_trace")
  })
  it("does not let a self described simple task hide a project wide change", () => {
    const task = classifyTask({ title: "Simple refactor everywhere in the repo" })
    expect(task.tier).toBeGreaterThan(1)
    expect(task.signals).toContain("self_described_simple_ignored")
  })
  it("returns unknown for empty input", () => {
    expect(classifyTask({ title: "" }).kind).toBe("unknown")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/classify.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Port the structural heuristic from `opencode-smart-router/src/core/classify/classifier.ts`, reduced: keyword families for kinds, `tier` from kind plus scope signals (word counts, "everywhere", "all files", "migration", file paths), stack-trace and test-file signals, and the rule that a self-described "simple" or "quick" task does not lower the tier when scope words are present. No context tokens, no attachments, no failure history. Deterministic, no clock.
- [ ] **Step 4: Verify pass**

Run: `npx vitest run test/classify.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: classify tasks locally from title and description"`

### Task 3: Usage windows

**Files:**
- Create: `src/core/windows.ts`
- Test: `test/windows.test.ts`

**Interfaces:**
- Produces:
  - `interface WindowUsage { id: string; label: string; scope: string | null; windowSeconds: number | null; resetsAt: string | null; usedPercent: number | null; remainingPercent: number | null; limitReached: boolean | null }`
  - `interface MemberUsage { status: "ok" | "unsupported" | "unavailable" | "error"; checkedAt: string; limits: readonly WindowUsage[] } | undefined`
  - `assessUsage(usage: MemberUsage, now: Date): { state: "unknown" | "ok" | "blocked"; pressure: number; notes: string[] }` where `pressure` is 0..1+ (1 = neutral) and `blocked` means at least one observed window has `limitReached === true`.
  - `earliestReset(usages: ReadonlyArray<MemberUsage>, now: Date): Date | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/windows.test.ts
const at = (iso: string) => new Date(iso)
const win = (o: Partial<WindowUsage>) => ({ id: "w", label: "Weekly", scope: null, windowSeconds: 604800, resetsAt: "2026-11-08T00:00:00.000Z", usedPercent: 50, remainingPercent: 50, limitReached: false, ...o })

describe("assessUsage", () => {
  it("returns unknown when usage is absent", () => {
    expect(assessUsage(undefined, at("2026-11-05T00:00:00Z")).state).toBe("unknown")
  })
  it("treats empty and errored usage as unknown", () => {
    expect(assessUsage({ status: "ok", checkedAt: "2026-11-05T00:00:00Z", limits: [] }, at("2026-11-05T00:00:00Z")).state).toBe("unknown")
    expect(assessUsage({ status: "error", checkedAt: "2026-11-05T00:00:00Z", limits: [win({})] }, at("2026-11-05T00:00:00Z")).state).toBe("unknown")
  })
  it("blocks only on an explicit limit reached", () => {
    expect(assessUsage({ status: "ok", checkedAt: "2026-11-05T00:00:00Z", limits: [win({ limitReached: true, usedPercent: 100 })] }, at("2026-11-05T00:00:00Z")).state).toBe("blocked")
  })
  it("prices allowance that resets soon lower than allowance that resets late", () => {
    const soon = assessUsage({ status: "ok", checkedAt: "2026-11-05T00:00:00Z", limits: [win({ usedPercent: 80, resetsAt: "2026-11-05T02:00:00.000Z" })] }, at("2026-11-05T00:00:00Z"))
    const late = assessUsage({ status: "ok", checkedAt: "2026-11-05T00:00:00Z", limits: [win({ usedPercent: 80, resetsAt: "2026-11-20T00:00:00.000Z" })] }, at("2026-11-05T00:00:00Z"))
    expect(soon.pressure).toBeLessThan(late.pressure)
  })
  it("reads a stale observation as unknown", () => {
    expect(assessUsage({ status: "ok", checkedAt: "2026-11-04T00:00:00Z", limits: [win({})] }, at("2026-11-05T00:00:00Z")).state).toBe("unknown")
  })
})
describe("earliestReset", () => {
  it("returns the soonest future reset across usages", () => { /* two usages, one at T+2h, one at T+1d; expect T+2h */ })
  it("returns undefined when nothing resets in the future", () => { /* all resets in the past */ })
})
```

Staleness rule: `checkedAt` older than 15 minutes is unknown.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/windows.test.ts`; expect module not found.
- [ ] **Step 3: Implement** — pressure = mean over observed windows of `fill * proximity`, where `fill = (usedPercent ?? (100 - remainingPercent)) / 100` and `proximity = clamp((secondsUntilReset / windowSeconds), 0.25, 1.5)`; active windows resetting sooner get a lower multiplier. Notes carry human text for the decision page. Deterministic given `now`.
- [ ] **Step 4: Verify pass** — `npx vitest run test/windows.test.ts`; 7 tests pass.
- [ ] **Step 5: Commit** — `feat: score subscription usage windows`

### Task 4: Member ranking

**Files:**
- Create: `src/core/score.ts`
- Test: `test/score.test.ts`

**Interfaces:**
- Consumes: `TaskClass` (Task 2), `assessUsage` (Task 3), and
  `interface Candidate { memberId: string; model: string; provider: string; usage?: MemberUsage }`
- Produces:
  - `interface RankingPolicy { floorByTier: Readonly<Record<1 | 2 | 3, number>>; modelTier: Readonly<Record<string, 1 | 2 | 3>>; continuityBonus: number; expiryWeight: number }`
  - `rankCandidates(input: { task: TaskClass; candidates: readonly Candidate[]; memberOrder: readonly string[]; lastMemberId: string | null; memory: ReadonlySet<string>; policy: RankingPolicy; now: Date }): { chosen?: string; skipped: Record<string, string> }`

- [ ] **Step 1: Write the failing tests**

```ts
// test/score.test.ts
const c = (o: Partial<Candidate> & { memberId: string }) => ({ model: "claude-sonnet-5", provider: "acpx", ...o })
describe("rankCandidates", () => {
  it("protects the strong account for architecture work", () => {
    // two candidates: cheap tier1 model at low pressure, strong tier3 model at low pressure; architecture task
    // expect strong member chosen
  })
  it("uses the runtime model and treats unknown models as tier 2", () => {
    // candidate model "mystery-model", architecture task, floor 3 -> skipped with "below the tier 3 floor (model tier 2)"
  })
  it("prefers the last member when scores tie", () => {
    // identical candidates, lastMemberId set -> chosen equals lastMemberId
  })
  it("rotates fairly when scores tie and no continuity exists", () => {
    // memberOrder [a,b,c], lastMemberId null, identical candidates -> chosen 'a'; lastMemberId 'a' -> chosen 'b'
  })
  it("skips a member with failure memory and names the reason", () => {
    // memory contains b; expect skipped.b to contain "rejected a request"
  })
  it("skips members whose usage is blocked and says why", () => {
    // expect skipped.a to contain "limit reached"
  })
  it("returns no chosen when every candidate is skipped", () => { /* expect chosen undefined and skipped for each */ })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/score.test.ts`.
- [ ] **Step 3: Implement** — score = modelTier against task tier (hard floor: below floor is a skip), then usage pressure (lower is better) plus `expiryWeight` weighting from `assessUsage`, plus `continuityBonus` for `lastMemberId`, tie-broken by rotated `memberOrder` index. Skip text is a plain sentence per candidate. Pure function, no clock beyond `now`.
- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit** — `feat: rank pool members by task fit and window pressure`

### Task 5: The decision function (pinned, skips, exhaustion)

**Files:**
- Create: `src/core/decide.ts`
- Test: `test/decide.test.ts`

**Interfaces:**
- Consumes: `classifyTask`, `assessUsage`, `earliestReset`, `rankCandidates`.
- Produces: `type RouteResult = ({ kind: "selected"; memberId: string; skipped?: Record<string, string> } | { kind: "exhausted"; retryAt: string; skipped: Record<string, string> } | { kind: "unavailable"; skipped: Record<string, string> })` and `decideRoute(input: { request: { pinnedMemberId?: string; candidates: ReadonlyArray<{ memberId: string; model: string; provider: string; usage?: MemberUsage }>; memberOrder: readonly string[]; lastMemberId: string | null }; task: TaskClass; memory: ReadonlySet<string>; policy: RankingPolicy; now: Date }): RouteResult`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/decide.test.ts
it("always returns the pinned member", () => { /* pinnedMemberId + one candidate; expect selected that id even with memory */ })
it("routes on tier and fairness when no usage is observed", () => { /* no usage at all; expect selected + a note, never exhausted */ })
it("returns unavailable only when every candidate is observed and blocked", () => { /* all limits limitReached -> unavailable with skipped */ })
it("returns exhausted with the earliest reset when all observed candidates are blocked", () => { /* same, expect kind exhausted and retryAt === earliest resetsAt */ })
it("selects the tier 1 model for mechanical work when it is cheaper", () => { /* big tier gap, low pressure cheap vs strong -> mechanical picks cheap */ })
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — pinned short-circuit; rank; if a chosen member exists return `selected`; else if every candidate has `state === "blocked"` return `exhausted` with `retryAt` from `earliestReset` (fall back to `now + 15 minutes` when no reset is known); else `unavailable`. Never throw.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: decide route with pinned, skips, and exhaustion rules`

### Task 6: State, decision ring, and data handler

**Files:**
- Create: `src/core/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces:
  - `interface DecisionRecord { at: string; companyId: string; taskKey: string; agentId: string; chosen: string | null; skipped: Record<string, string>; signals: string[]; mode: "routed" | "dry-run" }`
  - `pushDecision(ring: readonly DecisionRecord[], entry: DecisionRecord, cap?: number): DecisionRecord[]` (newest first, cap default 200)
  - `interface FailureRecord { memberId: string; at: string; taskKey: string; class: "deterministic" | "outage" | "rate_limit" | "other" }`
  - `activeFailures(records: readonly FailureRecord[], now: Date, ttlMinutes: number): ReadonlySet<string>`
  - `failureKey(companyId: string, taskKey: string, memberId: string): string`

- [ ] **Step 1: Write the failing tests**

```ts
it("ring keeps the newest entries under its cap", () => { /* 205 pushes cap 200; length 200; first is newest; oldest gone */ })
it("active failures expire after the ttl", () => { /* failure 31 min old, ttl 30 -> absent; 29 min -> present */ })
it("failure keys partition by company", () => { expect(failureKey("a","t","m")).not.toBe(failureKey("b","t","m")) })
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — pure array helpers; no host imports.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: bounded decision ring and failure memory helpers`

### Task 7: Failure classification and event capture

**Files:**
- Create: `src/core/failures.ts`
- Modify: `src/worker.ts`
- Test: `test/failures.test.ts` and `test/worker.test.ts`

**Interfaces:**
- Produces: `classifyRunError(input: { error?: string | null; errorCode?: string | null }): "deterministic" | "outage" | "rate_limit" | "other"`; and worker behavior: one `ctx.events.on("agent.run.failed", handler)` registered inside `setup`, joining the event to the most recent decision for `(companyId, agentId)` and recording a failure for the member that was chosen, only when classification is `deterministic`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/failures.test.ts
it("recognises a request-shape rejection", () => { expect(classifyRunError({ error: "Invalid discriminator value. Expected 'user' | 'assistant'" })).toBe("deterministic") })
it("recognises an outage", () => { expect(classifyRunError({ error: "502 Bad Gateway" })).toBe("outage") })
it("recognises a rate limit", () => { expect(classifyRunError({ error: "429 Too Many Requests" })).toBe("rate_limit") })
it("defaults to other", () => { expect(classifyRunError({ error: "process exited with code 1" })).toBe("other") })
// test/worker.test.ts: with a fake ctx, route a task, fire agent.run.failed with a deterministic error,
// assert state.set was called with a failure record and that a subsequent route skips that member.
// Also assert that onRouteAiConnection never calls ctx.state.set itself.
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — regexes isolated in one module with a comment naming the future structured field; worker keeps `ctx` from `setup`, registers one handler, stores failures via `ctx.state.set` in the event path (not the route path).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: capture deterministic run failures and skip offenders`

### Task 8: The decisions page

**Files:**
- Create: `src/ui/index.tsx`, `src/ui/decisions.tsx`
- Modify: `src/worker.ts` (`ctx.data.register("decisions", ...)`)
- Test: `test/page.test.tsx`

**Interfaces:**
- Produces: `export function RouterDecisionsPage({ context }: PluginPageProps)` rendering: header, the last decisions (time, task key, chosen member or "none", mode), and per decision the skip reasons. Data comes from `usePluginData<DecisionsPayload>("decisions", { companyId: context.companyId })`; worker handler returns `{ decisions: DecisionRecord[]; members: Array<{ memberId: string; lastChosenAt: string | null; blocked: boolean }> }`.

- [ ] **Step 1: Write the failing test**

```tsx
// test/page.test.tsx
import { renderToStaticMarkup } from "react-dom/server"
it("renders decisions and skip reasons", () => {
  const html = renderToStaticMarkup(<RouterDecisionsPage context={{ companyId: "c1" } as never} data={{ decisions: [{ at: "2026-11-05T00:00:00Z", taskKey: "iss_1", agentId: "a", chosen: "m1", skipped: { m2: "weekly window 82% and resets in 2d" }, signals: [], mode: "routed", companyId: "c1" }], members: [] } as never} />)
  expect(html).toContain("iss_1")
  expect(html).toContain("weekly window 82%")
})
```

The component takes an optional `data` prop for tests and uses `usePluginData` when it is absent.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — plain semantic markup, no UI kit dependency, system fonts, readable at 1280px and 390px; empty state explains that routing will appear after the first task.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: decision history page`

### Task 9: Dry-run shadow mode, config, and docs

**Files:**
- Modify: `src/worker.ts` (agree config + dry run)
- Create: `docs/INSTALL.md`, `docs/LIMITATIONS.md`, `README.md`
- Test: `test/dry-run.test.ts`

**Interfaces:**
- Produces: `instanceConfigSchema` (JSON Schema) with `dryRun` (boolean, default false), `safetyMarginPercent` (int 50..100, default 85), `memoryMinutes` (int 5..240, default 30), `floorByTier` (object). In dry-run, `decideRoute` runs and a decision record with `mode: "dry-run"` is written, but the returned result is the reference rotation: `memberOrder` rotated from `lastMemberId`, skipping only observed-blocked candidates.

- [ ] **Step 1: Write the failing test**

```ts
it("returns the reference rotation in dry run while recording our choice", async () => {
  // fake ctx + config dryRun true; two candidates a,b; lastMemberId b
  // expect result memberId === 'a' (next after b in memberOrder) and a stored decision with mode 'dry-run'
})
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** and write the docs: README (what it does, the two usage modes stated plainly, install by npm name, the flag), INSTALL (enable `enableAiConnectionRouters`, create pool, point an agent, what you will see), LIMITATIONS (pinned tasks are surfaced not rerouted; usage missing on autonomous runs; model per member not per task; alpha SDK pinning; OSS does not render `skipped`).
- [ ] **Step 4: Verify pass** and full suite: `npm run check`.
- [ ] **Step 5: Commit** — `feat: dry-run shadow mode, configuration, and documentation`

### Task 10: End-to-end verification on a real instance

**Files:**
- Create: `docs/VERIFY.md` (the recorded run), no code changes unless a defect is found.

- [ ] **Step 1: Start a disposable instance**

Run: `cd /tmp && mkdir -p pcr && cd pcr && ANTHROPIC_API_KEY=<a real connected key or subscription> npx paperclipai@latest test-drive --data-dir ./.pc-router --no-browser`
Expected: server at `http://localhost:3100`, an initialized company.

- [ ] **Step 2: Enable routing and install the plugin**

Enable `enableAiConnectionRouters` through `PATCH /api/instance/settings/experimental` as an instance admin. Pack the plugin (`npm pack`) and install from the tarball, then set its status to ready.

- [ ] **Step 3: Create a pool with two members and point one agent at it.** Use the API from the docs (`POST /api/companies/{id}/ai-connection-pools`, mode `usage_aware`) with two connected accounts whose models differ by tier.

- [ ] **Step 4: Run three tasks of different classes and record** for each: chosen member, the decision page entry, the skip reasons, and the run's member shown in Paperclip. Expected: mechanical routes to the cheap member, architecture to the strong one, and every decision appears on the page with reasons.

- [ ] **Step 5: Verify degradation.** Disconnect usage observation (use a run with no responsible user) and confirm the router still selects (tier and fairness), with the page noting that usage was not observed. Confirm no task is deferred because of us.

- [ ] **Step 6: Write `docs/VERIFY.md`** with the commands, the observed choices, and any deviations, then commit: `test: record end-to-end verification on a local Paperclip instance`.

## Final review

After Task 10, run a whole-branch review with a fresh reviewer against the spec and this plan's Review Focus, then fix Critical and Important findings in one pass with tests. Publish only after the review is clean: `npm publish` (the owner completes 2FA), then a release tag and, if the project wants it, a Paperclip plugin showcase PR.
