# Self-Healing Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The router repairs prompts a provider will deterministically reject, stops wasting retries on doomed requests, and fails a rejected turn over to the next best model with a capped synthetic continuation.

**Architecture:** Three layers added to the existing plugin: (1) a `context` hook that folds mid-conversation `role: "system"` entries into user messages for Anthropic-protocol providers (the official host 2.2.5 mutation pattern), (2) a new `prompt_rejected` failure class matched before the generic stream rule, (3) failover in the retry hook: `retry: false`, per-prompt exclusion, re-route via the existing engine, guarded `switchModel`, one synthetic continuation. Visibility flows through `RoutingDecision.selfheal` into the panel.

**Tech Stack:** TypeScript (same strictness as repo), Vitest (repo suite), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-self-healing-routing-design.md`

## Global Constraints

- Host API: `@opencode/plugin` 2.2.5 (repo `package.json` pins it). Guard every new hook/`switchModel`/`synthetic` call with a `typeof === "function"` check the way `compact` is guarded (`src/server/controller.ts:1972`).
- Docs and README prose: no em dashes, no en dashes, no British spellings, comma-only alt text (`test/docs-consistency.test.ts:33-40`). README test count must match the real suite count (`test/docs-consistency.test.ts` enforces it).
- Every `RoutingDecision` recorded must remain shape-valid: new optional fields only.
- The repo's own rule from registerHooks comments: never switch model while a turn is queued (`sessionBusy()`), except behind the guard defined in Task 5.
- Commit after every task; run the task's tests before committing.

## Review Focus

1. A `system` message at index 0 must never be folded (folding it would change Anthropic prompt-cache behavior and the system prompt channel). Test: Task 3, `repairs no-op when the only system message is at index 0`.
2. Utility requests (compaction, title, generate) must never be repaired; a fold there corrupts summaries. Test: Task 3, `latches kind and skips folding for non-primary kinds`.
3. One auto-continue per prompt, never consecutive: regression here spams the session. Test: Task 5, `caps the auto-continue at one per prompt`.
4. Classification regression: `provider.invalid-request` must land `prompt_rejected`, and previously-passing stream strings (`provider.internal`, `enginecore encountered an issue`) must still be `provider_outage`. Tests: Task 1 classifier cases.
5. Foreign sessions must never be repaired or failed over. Test: Task 3, unowned session context hook is a no-op; Task 5 reuses `ensureOwnership`.

---

### Task 1: `prompt_rejected` failure class

**Files:**
- Modify: `src/core/types.ts` (FailureClass union, after `"quota_exhausted"`)
- Modify: `src/core/failures.ts` (new rule, before the `providerType`/`streamFailure` block)
- Modify: `src/core/ledger.ts` (`emptyFailureCounts()`)
- Test: `test/classifier.test.ts` (append cases in the existing style)

**Interfaces:**
- Consumes: `classifyFailure(input: FailureInput, session?): FailureAssessment` (existing).
- Produces: the string `"prompt_rejected"` as a `FailureClass`, with assessment fields `retryable: false`, `capabilityFailure: false`, `escalate: false`, `countAgainstModel: false`, `providerScoped: false`, `cooldownMs: 300_000`.

- [ ] **Step 1: Write the failing tests** — append to `test/classifier.test.ts`:

```ts
// The tuck-session error, verbatim. It contains neither "invalid request"
// nor a status code, which is why it slipped into the stream rule.
test("classifies the anthropic role-discriminator 400 as prompt_rejected", () => {
  const a = classifyFailure(
    { type: "provider.invalid-request",
      message: "Invalid discriminator value. Expected 'user' | 'assistant' at messages.23.role",
      status: 400 },
  )
  assert.equal(a.class, "prompt_rejected")
  assert.equal(a.retryable, false)
  assert.equal(a.countAgainstModel, false)
})

test("classifies invalid-request with no status as prompt_rejected", () => {
  const a = classifyFailure({ type: "provider.invalid-request", message: "Invalid discriminator value. Expected 'user' | 'assistant' at messages.2.role" })
  assert.equal(a.class, "prompt_rejected")
})

test("prompt_rejected matches anthropic invalid_request_error bodies naming message positions", () => {
  const a = classifyFailure({ type: "provider.invalid-request", message: "invalid_request_error: messages.67.role Invalid discriminator value" })
  assert.equal(a.class, "prompt_rejected")
})

test("stream engine faults stay provider_outage", () => {
  const a = classifyFailure({ type: "provider.internal", message: "enginecore encountered an issue" })
  assert.equal(a.class, "provider_outage")
})

test("generic bad requests stay invalid_request", () => {
  const a = classifyFailure({ message: "The request shape was invalid: unsupported parameter foo", status: 400 })
  assert.equal(a.class, "invalid_request")
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/classifier.test.ts`; the four new cases fail (tuck case currently returns `provider_outage`).
- [ ] **Step 3: Implement** — in `src/core/failures.ts`, insert before the `const providerType = ...` line:

```ts
// A deterministic request-shape rejection: the provider refused the prompt
// before generating anything (HTTP 400 carries no billing, rate or capacity
// meaning). Retry cannot change the outcome; the request itself is the
// problem, so the router repairs or fails over instead of retrying.
const promptRejected =
  type.includes("invalid-request") ||
  type.includes("invalid_request") ||
  includes(message, [
    "invalid_request_error",
    "expected 'user' | 'assistant'",
    "expected \"user\" | \"assistant\"",
    "invalid discriminator value",
  ]) ||
  /messages\.\d+\.role/i.test(input.message)
```

then a returning branch that yields `class: "prompt_rejected"`, `cooldownMs: 300_000`, `reason` naming the failover behavior, `countAgainstModel: false`, `providerScoped: false`. In `src/core/types.ts` add `| "prompt_rejected"` to `FailureClass` with a short doc comment. In `src/core/ledger.ts` `emptyFailureCounts()` add `prompt_rejected: 0`.
- [ ] **Step 4: Verify pass** — `npx vitest run test/classifier.test.ts`; then `npx vitest run test/provider-backoff.test.ts test/reliability.test.ts` to prove no external class changed (`streamFailure` ordering intact).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: add prompt_rejected failure class for deterministic request rejections"`

### Task 2: protocol field and `providerProtocol()`

**Files:**
- Modify: `src/core/types.ts` (`ModelRecord`: add `readonly protocol?: "anthropic" | "openai-compat"`)
- Modify: `src/core/models/seed.ts` (`SeedModel`: add optional `protocol` of the same union)
- Modify: `src/core/models/registry.ts` (`fromSeed` passes it through; `fromLive` leaves it undefined)
- Create: `src/core/models/protocol.ts` (heuristic helper)
- Test: `test/protocol.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `providerProtocol(record: Pick<ModelRecord, "protocol" | "providerID" | "modelID">): "anthropic" | "openai-compat"` — returns `record.protocol` when set; otherwise `"anthropic"` when providerID or modelID matches `/anthropic|claude|commandcode/i` and the modelID matches `/claude/i`; else `"openai-compat"`.

Deliberate scope note: the spec's settings override for `protocol` is deferred (the `validateDefinitions` whitelist would need extending and no current user needs it). Seed + heuristic is the whole contract for now.

- [ ] **Step 1: Write the failing tests** in `test/protocol.test.ts`:

```ts
test("explicit protocol wins", () => { assert.equal(providerProtocol({ protocol: "anthropic", providerID: "x", modelID: "y" }), "anthropic") })
test("claude family infers anthropic", () => { assert.equal(providerProtocol({ providerID: "commandcode", modelID: "claude-haiku-5-5" }), "anthropic") })
test("everything else is openai-compat", () => { assert.equal(providerProtocol({ providerID: "commandcode", modelID: "deepseek-v4.1-flash" }), "openai-compat") })
```

- [ ] **Step 2: Run to verify fail.** (`npx vitest run test/protocol.test.ts`)
- [ ] **Step 3: Implement** the helper and the two type/registry shims (`fromSeed` copies `...(seed.protocol ? { protocol: seed.protocol } : {})`).
- [ ] **Step 4: Verify pass** plus `npx vitest run test/classifier.test.ts` (unchanged).
- [ ] **Step 5: Commit** — `feat: add model protocol field with claude-family heuristic`

### Task 3: prompt repair (`reprompt.ts` + `context` hook)

**Files:**
- Create: `src/core/reprompt.ts`
- Modify: `src/server/controller.ts` (`registerHooks`: new `context` hook; new bounded `requestKinds` map; `model.request` hook latches `event.kind`; `dispose` clears the map)
- Test: `test/reprompt.test.ts` (new, pure-function cases) and extend `test/behavior.test.ts` or a new `test/repair-hook.test.ts` (controller-level)

**Interfaces:**
- Consumes: `providerProtocol` (Task 2), existing `ensureOwnership(sessionID): Promise<boolean>`, existing `model.request` hook registration site.
- Produces:
  - `repairMessages(messages: ReadonlyArray<any>, input: { protocol: "anthropic" | "openai-compat" }): { messages: any[]; folded: number }` — pure; returns the original array (same identity, `folded: 0`) when protocol is not anthropic or nothing needs folding; otherwise returns a new array where every message with `role === "system"` at index > 0 becomes `{ ...message, role: "user" }`, and index 0 is untouched.
  - Controller behavior: the `context` hook fires with `{ sessionID, agent, model, system, messages, options, tools }`; the handler (1) resolves ownership via `ensureOwnership`, (2) reads the latched kind (default `"primary"` when unknown, since the primary agent loop is the overwhelmingly common case and skipping the fold on a miss would leave the bug live), (3) resolves protocol from `this.registry` via the latched/session model or `event.model`, (4) applies `repairMessages` to `event.messages` when `folded > 0`.

- [ ] **Step 1: Write the failing tests** — pure cases first:

```ts
test("folds mid conversation system roles into user", ...)
// input: [{role:"user"},{role:"system",content:"New instructions"},{role:"assistant"}]
// expect folded === 1 and the second message role === "user" with content preserved
test("leaves a system message at index 0 untouched", ...)
test("returns the original array when nothing needs folding", ...)
// identity: result.messages === input messages, folded === 0
```

Controller cases (use `test/helpers/ctx.ts`): fire `hooks.get("model.request")` with `{ sessionID: "ses_x", kind: "title" }`, then `hooks.get("context")` with a messages array containing a mid-conversation system role; assert the array is unchanged. Then kind `"primary"` (or no model.request first) → assert the fold happened and that an unowned session (`"ses_other"` after restoreHome reset / different project) is untouched. The ctx helper needs no changes if the context event is dispatched manually.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `src/core/reprompt.ts` and the hook in `registerHooks()`:

```ts
this.registrations.push(
  await this.ctx.session.hook("context", async (event: any) => {
    if (!this.repairEnabled()) return
    if (!(await this.ensureOwnership(event.sessionID))) return
    const kind = this.requestKinds.get(event.sessionID) ?? "primary"
    if (kind !== "primary") return
    const record = ...// registry lookup by event.model (fallback session.lastModel)
    const result = repairMessages(event.messages ?? [], { protocol: providerProtocol(record ?? {}) })
    if (result.folded > 0) event.messages = result.messages
  }),
)
```

`repairEnabled()` is a `typeof this.ctx.session.hook === "function"` no-op-proof guard pattern; latch in `model.request` via `this.requestKinds.set(event.sessionID, event.kind)` with a bounded eviction like `expectedSwitch` (same 500-entry cutoff pattern, `controller.ts:1397-1402`). Consume the latch one-shot in the context hook (`this.requestKinds.delete(event.sessionID)` after reading), so a stale kind can never survive to a later request. Meta-probe required during implementation: record (debug log) the first `model.request` then `context` ordering pair per process and assert in tests that the latch is consistently fresh; if a test ever observes context firing before model.request for the same request, the one-shot default (missing latch reads as `"primary"`) already keeps the fold live for agent turns, and utility-turn protection then relies on compaction/title using their own hooks (`session.hook("compaction")` etc., not `"context"`), which is the case in the 2.2.5 typings.
- [ ] **Step 4: Verify pass** — `npx vitest run test/reprompt.test.ts test/repair-hook.test.ts`.
- [ ] **Step 5: Commit** — `feat: repair anthropic-incompatible prompts in flight via the context hook`

### Task 4: prompt-route tracker

**Files:**
- Create: `src/server/route-tracker.ts`
- Modify: `src/server/controller.ts` (prompt hook stores the entry; `dispose` cleanup)
- Test: `test/route-tracker.test.ts`

**Interfaces:**
- Produces: `class PromptRouteTracker` with `set(sessionID: string, entry: { messageID?: string; task: TaskClass; decision: RoutingDecision; at: number }): void`, `get(sessionID: string): entry | undefined`, `clear(sessionID: string): void`, and a 500-session bounded size evicting oldest by `at` (mirror the `expectedSwitch` eviction loop verbatim in shape).

- [ ] **Step 1: Write the failing test** — set/get/clear round-trip, overwrite on second prompt, and eviction when 501 distinct sessions are inserted.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.** The prompt hook (`controller.ts:1545`) records `tracker.set(sessionID, { messageID: event.messageID, task: decision.task, decision, at: Date.now() })` right after `routePrompt` resolves (both success and manual/paused paths: routePrompt returns the decision in both, so one capture point after `await this.routePrompt(...)` covers both).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `feat: track the routed task per prompt for failover`

### Task 5: failover in the retry hook

**Files:**
- Modify: `src/server/controller.ts` (retry hook: new branch after `capability` and before `rate_limit`; new private `attemptFailover(sessionID, event, assessment)`)
- Test: `test/failover.test.ts` (new; uses `test/retry-backoff.test.ts` as the template — claim the session first via `sharedCore.claimSession("ses_x", controller.bridgeID)`)

**Interfaces:**
- Consumes: `classifyFailure` with class `"prompt_rejected"` (Task 1), `routeTask` via the existing private re-route pattern, `PromptRouteTracker` (Task 4), `providerProtocol` (Task 2, not used here), existing `expectedSwitch`, `switchModel` and `synthetic` calls, `sessionBusy()`.
- Produces: on a `prompt_rejected` retry event the controller: sets `event.decision = { retry: false }`; re-routes `tracker.get(sessionID).task` with `cooldowns` = ledger cooldowns plus `{ [modelKey(rejected)]: Date.now() + 300_000 }`; if the engine picks a different `chosenModel` and `chosenModel.key !== rejected key` and `ctx.session.switchModel` is a function and not `sessionBusy()`: switches (`expectedSwitch.set` with the new key), synthesizes once, records a decision annotated `selfheal` (Task 6 field). Guards make any missing piece degrade to "turn fails, cooldown steers the next prompt".

- [ ] **Step 1: Write the failing tests** (fire `hooks.get("retry")` with the tuck error and a fabricated `model: { providerID: "commandcode", modelID: "claude-haiku-5-5" }`, `attempt: 1`):

```ts
test("does not retry a deterministic rejection", ...)
// assert event.decision equals { retry: false }, switched records the engine's next best
// and syntheticCalls has exactly one entry whose text starts with "[router]"
test("excludes the rejecting model for the same prompt when no candidate exists", ...)
// engine constrained so nothing else is eligible: switched empty, syntheticCalls empty,
// but a recorded decision with selfheal.action === "noted" exists (readable via the ledger)
test("caps the auto-continue at one per prompt", ...)
// fire the retry hook twice with the same tracker entry: second call switches nothing and synthesizes nothing
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement `attemptFailover()`.** Sequence: read `tracker.get`; compute cooldown map; call the same `routeTask` input shape used in `routePrompt` (`runtime`, `settings`, `mode`, `models`, `current: lastModel`, `session`, `quota`, `premium`, `contextTokens`, `cachedTokens`, `dryRun: false`/`this.settings.dryRun`); if the chosen key differs from the failed key: `await this.ctx.session.switchModel({ sessionID, model: { providerID: chosen.providerID, id: chosen.modelID } })`, `this.expectedSwitch.set(sessionID, { key: modelKey(...), at: Date.now() })`, then one `ctx.session.synthetic({ sessionID, text: \`[router] ${rejected.providerID}/${rejected.id} rejected the request (invalid request). Continuing on ${chosen.providerID}/${chosen.modelID}.\`, description: "Smart Router", resume: false })`; mark the tracker entry healed (`healedAt`). Record the decision (clone the routed decision, set `chosen`, `switched: true`, `switchReason: "selfheal"`, `selfheal` annotation) through `this.ledger.recordDecision`. Every host call guarded: `typeof this.ctx.session.switchModel === "function"`, `typeof this.ctx.session.synthetic === "function"`, `!this.sessionBusy(sessionID)` before the switch, and the whole handler wrapped so a failover error becomes `this.settingsWarnings.push(...)` and never rethrows out of the hook.
- [ ] **Step 4: Verify pass** — `npx vitest run test/failover.test.ts test/retry-backoff.test.ts`.
- [ ] **Step 5: Commit** — `feat: fail over deterministic rejections to the next best model`

### Task 6: decision annotation, panel line, marketing copy

**Files:**
- Modify: `src/core/types.ts` (`RoutingDecision`: add `readonly selfheal?: { rejected: string; action: string }`)
- Modify: `src/gui/viewmodel.ts` (`DecisionView` gains `readonly selfheal?: string`; `summariseDecision` maps it to a short label: `"repaired <rejected> · continued on <chosen>"` / `"noted for next prompt"`)
- Modify: `src/gui/index.tsx` (render the label under the last decision when present; follow the existing reason-line styling)
- Modify: `README.md` (new "Self-healing" section, comma-only prose, no dashes; update the test count it quotes), `CHANGELOG.md` (Unreleased entry)
- Test: `test/plan-display.test.ts` (extend) and `test/docs-consistency.test.ts` (already guards copy)

**Interfaces:**
- Consumes: `RoutingDecision.selfheal` written by Task 5.
- Produces: `DecisionView.selfheal?: string`.

- [ ] **Step 1: Write the failing test** in `test/plan-display.test.ts`: a decision with `selfheal: { rejected: "commandcode/claude-haiku-5-5", action: "continued on commandcode/deepseek-v4.1-flash" }` produces `DecisionView.selfheal === "rejected commandcode/claude-haiku-5-5 · continued on commandcode/deepseek-v4.1-flash"`; without it, undefined.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** the type, the mapping, and the GUI render (one conditional text line).
- [ ] **Step 4: Write the README section** — name the capability, describe the three behaviors honestly (repairs Anthropic-incompatible prompts in flight; refuses to retry deterministic rejections; fails over to the next best choice and continues the turn), note it resolves the observed `provider.invalid-request` failure loop. Keep it free of em/en dashes and British spellings; quote no error text with a dash in it.
- [ ] **Step 5: Verify pass** — `npx vitest run test/plan-display.test.ts` then `npm test -- docs-consistency` equivalent: `npx vitest run test/docs-consistency.test.ts` (update the README test count it quotes to the new `npx vitest run` total).
- [ ] **Step 6: Commit** — `feat: surface self-heal decisions in the panel and document capability`

### Task 7: end-to-end verification

**Files:**
- Test: `test/selfheal-e2e.test.ts` (new)
- Modify: nothing else

**Interfaces:**
- Consumes: everything above through the public `makeCtx` harness.

- [ ] **Step 1: Write the end-to-end test** — one file, three flow tests against the real controller:

```ts
// Flow A (repairs): prompt hook routes to a commandcode claude model; fire
// model.request { kind: "primary" }; fire context with mid-conversation
// system roles; assert the outgoing messages carry no system role above
// index 0, and the retry hook never fires.
// Flow B (fails over): context fires with nothing to fold (or events bypass it);
// retry hook gets the tuck error; assert: retry decision { retry: false },
// switchModel called once to the next best, exactly one synthetic starting
// with "[router]", a decision with selfheal recorded, and a second retry
// event does nothing.
// Flow C (guards): same as B but the engine has no other eligible model;
// assert no switch, no synthetic, decision selfheal.action === "noted", and
// the cooldown map contains the rejecting key expiring ~5 minutes out.
```

- [ ] **Step 2: Run it** — `npx vitest run test/selfheal-e2e.test.ts`; fix only wiring gaps it exposes (expected pass after Task 5; treat any failure here as a bug in Tasks 1-6, not as a reason to weaken the test).
- [ ] **Step 3: Full check** — `npm run check` (lint, types, full suite); update README's quoted test count if the final total differs, re-run `test/docs-consistency.test.ts`.
- [ ] **Step 4: Install and verify live** — `npm run build:server`, then `./install --yes`; with the machine's real config, route one prompt to a claude-protocol provider in a session with instructions notices (or replay by prompting twice with a mid-session instruction change) and confirm no `Invalid discriminator value` error appears in the session.
- [ ] **Step 5: Commit** — `test: end-to-end self-heal flows` (and any README count fix riding the same commit).
