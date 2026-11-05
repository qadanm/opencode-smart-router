# Paperclip Router: subscription-aware, task-aware routing for Paperclip

Date: 2026-11-05
Status: approved (three product positions settled after builder check)

## Intent

Paperclip runs a company of agents across harnesses (Claude Code/ACP, Codex,
OpenCode) and lets each agent use a "connection pool" of saved AI accounts.
The platform supplies rotation, per-task pinning, usage probing, and the setup
UI. A router plugin supplies the decision. Today's reference behavior is round
robin, or a flat "skip accounts at 90%" gate.

Smart Router showed that the real problem is richer: tasks differ in how much
intelligence they need, subscriptions differ in which windows they are draining
and when those windows reset, and providers sometimes reject a request shape
deterministically. This plugin makes Paperclip's pool decision that smart:

1. Pick the member (account, harness, model) that fits the task class and is
   cheapest against the allowance windows that are actually at risk.
2. Skip members for stated reasons, never silently.
3. Avoid members that just rejected a request deterministically, and let the
   task's normal retry land on a different member.
4. Show every decision in a paper-trail page: task, chosen member, score
   components, and why each other member lost.

It is a standalone product: it needs nothing beyond Paperclip's documented
plugin SDK, so it does not require OpenCode or Smart Router. It shares design
DNA and (later) code with Smart Router, and the two are designed to run side
by side without interfering.

## What Paperclip already gives us (verified)

- Plugin runtime: `@paperclipai/plugin-sdk`, worker per plugin, manifest
  capabilities, worker JSON-RPC, host clients for issues/agents/companies,
  scoped state, activity log, UI contributions. Plugins are alpha; versions
  must be pinned.
- Router contract (`packages/shared/src/ai-connection-router.ts`):
  - Manifest: `capabilities: ["ai.connections.route"]` plus
    `aiConnectionRouter: { name, description }`.
  - Hook: `onRouteAiConnection(request)` with a 5 second host timeout.
  - Request: `companyId`, `pool` (config plus id/revision), `agentId`,
    `taskKey` (the issue id, derived in
    `server/src/modules/wake-queue/domain/context.ts`), `lastMemberId`,
    `cursorVersion`, `memberOrder`, optional `pinnedMemberId`, and
    `candidates: { member, runtimeConfig, notes, usage? }[]`, plus `now`.
  - Result: `{ kind: "selected", memberId, skipped? }` or
    `{ kind: "exhausted", retryAt, skipped }` or
    `{ kind: "unavailable", skipped }`. The host re-validates authorization.
- Member shape: one member per connection, with `profile.provider`
  (`codex` | `acpx` | `opencode`), optional `acpxAgent` (`claude` | `grok`),
  `model`, optional `effort`. Routing targets are therefore
  (account, harness, model) triples.
- Usage observations: per candidate, `AiConnectionUsage` with
  `limits[] { id, label, scope, windowDurationSeconds, resetsAt,
  usedPercent, remainingPercent, limitReached, allowed }`, plan type, status,
  and freshness (`checkedAt`). Provided only when the pool mode is
  `usage_aware` and the caller has a user context.
- Pinning: each task pins to the member selected at its first run; later runs
  reuse it. Router decisions happen only while unpinned, and `pinnedMemberId`
  must be respected when present (return that member).
- Platform constraints: instance flag `enableAiConnectionRouters`; pools are
  company-scoped; the plugin appears in the Connectors catalog.

## Goals

1. One plugin, `@qadanm/paperclip-router`, installable from npm into a
   self-hosted Paperclip, that replaces round robin with an explained,
   window-aware, task-aware selection.
2. Task classification runs locally (no model call) from the issue title and
   description, reusing the classifier approach proven in Smart Router.
3. Window-aware pricing: prefer spending allowance that is about to expire and
   headroom that is cheap; protect the strongest accounts for substantive work.
4. Deterministic-rejection memory: a member that produced a provider-side
   request rejection for a task signature is skipped for that prompt with a
   stated reason, so the task retry lands elsewhere.
5. Honest degradation: missing usage never fabricates an "exhausted"; unknown
   members stay selectable with a note. When all observed members are at their
   limit and every candidate is observed, return `exhausted` with the earliest
   reset so Paperclip's own wait/resume works.
6. Explanation: the `skipped` map is always populated and a plugin page lists
   the decision history with score components.

## Non-goals

- No standalone proxy, no gateway, no OpenAI-compatible endpoint. (Rejected in
  the conversation: commodity layer, subscription credentials live in hosts.)
- No model mutation inside a run. The router chooses among configured members;
  it does not rewrite an agent's model mid-turn.
- No cloud service, no hosted ledger, no auth beyond Paperclip's own.
- No changes to Paperclip core.

## Anti-goals (failure modes to avoid)

- A router that can deadlock a company: never return `exhausted` or
  `unavailable` when at least one candidate is plausibly usable, and never
  because our own state is stale or unreadable.
- A router that ignores a pinned member, or that fights the task composer's
  explicit model override.
- A router that takes longer than the 5 second budget under load. No network
  calls inside the route hook beyond cached reads.
- A router that blames a whole account for one model's failure, or that keeps
  routing to a member that rejected the last three tasks.
- A router whose reasons are unreadable at a glance; the skipped text is user
  facing.

## Approaches considered

A. **Paperclip router plugin (chosen).** Uses the host's own contract, ships
   as npm, and turns pools into routing targets. Smallest new surface, native
   governance and pinning, and the explanation channel (`skipped` + plugin
   page) exists.
B. **Standalone routing core plus local proxy.** Works for any harness but
   competes with LiteLLM-class gateways, cannot see subscription windows, and
   would take months. Rejected.
C. **Modify Paperclip core.** Not maintainable as an outside contributor and
   duplicates work the plugin API already does. Rejected.

Inside approach A, three levels of intelligence:

i. Round robin plus a better threshold. Duplicates the host and adds nothing.
ii. Usage-only scoring. Handles expiry and drain, ignores task class, so a
    mechanical rename can burn the strongest account.
iii. **Task-aware scoring plus failure memory (chosen).** Fits the product's
    differentiator, and every input is available in the router request.

## Design

### Repository and layout

New repository `qadanm/paperclip-router` (MIT, same author). Single package,
no monorepo yet, so the plugin installs cleanly by npm name:

```
src/
  manifest.ts        plugin manifest (capabilities, aiConnectionRouter)
  worker.ts          definePlugin + onRouteAiConnection + setup
  core/
    classify.ts      task classification from issue text (pure)
    windows.ts       allowance scoring from AiConnectionUsage (pure)
    score.ts         member ranking, skips, continuity, fairness (pure)
    decisions.ts     decision record types and formatting (pure)
    memory.ts        per-member failure memory (pure, host state injected)
  host.ts            thin adapters: issues.get, events, state, activity
  ui/                plugin page: decisions and member state
tests/               unit tests per core module, contract tests, fixture tests
docs/                design, install, limitations
```

The core is dependency-free TypeScript so it can later move to a published
`@qadanm/router-core` shared with Smart Router. Reuse from Smart Router is by
porting the classifier and window-scoring logic, not by importing that repo.

### Route hook algorithm (v1)

Inputs are the request plus three cached lookups (5 s budget; all reads served
from in-worker caches):

1. Respect `pinnedMemberId`: return that member unless it is missing from the
   candidates, in which case fall through (host keeps its pin state
   authoritative).
2. Fetch the issue once for the task: `ctx.issues.get(taskKey, companyId)`.
   Cache by `taskKey` with a short TTL (60 s) and reuse across retries. If the
   fetch fails, classify as `unknown` and continue; routing must not depend on
   it.
3. Classify task: `kind` (mechanical, docs, test, feature, debug, refactor,
   security, architecture, design, unknown), `tier` (1 to 3) and `signals`
   (e.g. file counts, stack traces, "refactor", "migration", "no tests").
   Same structure and heuristics as Smart Router's classifier, smaller surface.
4. Score each candidate:
   - Eligibility: skip members whose only observed windows are at
     `limitReached`, or whose weakest window is past the configured safety
     threshold when the task is not the member's only chance. Skip members
     with an active failure memory entry for this task signature.
   - Window pressure: from `usage.limits`, compute a cost proxy. Full windows
     that reset late cost most; near-empty windows that reset soon cost least;
     expire-soon allowance is discounted (bounded), because letting it reset
     unused loses it. Missing usage contributes a neutral cost plus a note.
   - Model fit: map the member's `profile.model` to a capability tier using a
     curated table (shipped in the plugin, editable in config). Skip members
     below the intelligence floor for the task tier. Vision needs are out of
     scope in v1 (Paperclip tasks do not carry attachment modality in the
     router request).
   - Continuity: small preference for `lastMemberId` and the agent's current
     member, matching the cache-affinity idea from Smart Router.
   - Fairness: rotate by `memberOrder` and `cursorVersion` as a tiebreak, so
     equal scores do not pin every task to member one.
5. Return the best member with `skipped` populated for every other candidate
   (`"weekly window 82% and resets in 2d"`, `"below the tier 2 floor"`,
   `"rejected a request 4 minutes ago"`). If every candidate is skipped:
   - all candidates have fresh usage and all are over limit: `exhausted` with
     `retryAt` = earliest `resetsAt` among them;
   - otherwise: `unavailable` with the skips.

Deterministic scoring, no randomness, no clock reads beyond `request.now`.

### Failure memory

Subscribe to run completion events once per company. On a failed run, read the
run's error and the member that served it (attach from agent/run metadata).
Classify provider-side deterministic rejections (invalid request, role or tool
schema rejections, unsupported content) separately from outages, rate limits,
and user interruptions. Record `{ memberId, taskSignature, class, at }` in
plugin state with a short TTL (30 minutes for deterministic rejections). The
router skips matching members and states why.

Verification step in implementation: confirm the event payload exposes the
serving member id and error class. If it does not, record failure memory from
`ai_connection.pool_selected` activity plus the run outcome, or drop the
feature to a later version rather than inferring.

### Explanation surfaces

- `skipped` text in the pool UI (host renders it today).
- Plugin page: last 50 decisions, each with task link, chosen member, score
  components, and skip reasons; plus a member table with the last usage
  snapshot and failure memory.
- Activity log entry via `ctx.activity` for every decision, linking the task.

### Configuration (company-scoped)

- `floorByTier`: intelligence floor per task tier, with model tiers seeded.
- `safetyMarginPercent`: default 85 (more conservative than the host's 90).
- `expiryDiscount`: bounded discount for allowance resetting soon (defaults
  mirror Smart Router's window pricing).
- `continuityBonus`, `fairnessTiebreak`: small weights, documented.
- `memoryMinutes`: deterministic-rejection TTL, default 30.
- `dryRun`: decide and explain, but always return the host's round-robin
  choice (useful for a week of shadow comparison before trusting it).

### Testing

- Unit tests for every pure module, table-driven (classification fixtures,
  window scoring fixtures, ranking scenarios, skip text).
- Contract test: request/result shapes checked against the SDK types at build
  time; a fake host from `@paperclipai/plugin-sdk` `testing` helpers runs the
  worker through the JSON-RPC loop.
- Scenario tests with realistic usage payloads: expiring allowance wins;
  strongest account protected for architecture; all-exhausted returns the
  earliest reset; unknown usage never triggers exhausted; pinned member wins;
  failure memory skips the member once and expires.
- No test asserts on timing beyond the 5 s invariant (pure functions).

### Rollout and verification

1. Build and install into a local Paperclip instance (`npx paperclipai
   test-drive` or the user's instance), enable `enableAiConnectionRouters`.
2. Create a pool with members across at least two providers and models.
3. Point one agent at the pool, run three task classes (mechanical, feature,
   architecture) and verify the chosen member, the skip reasons, the plugin
   page, and the activity entries.
4. Run the dry-run mode for a day against real work and diff our choices
   against the host's rotation.
5. Publish to npm, add to the README/docs, and open a Paperclip plugin
   showcase PR if the project invites one.

## Decisions settled after the builder check

The host does not support three things the first draft assumed. These are now
part of the contract, not open questions.

### 1. Pinned tasks are surfaced, never rerouted

The host pins each task to its first-run member and passes exactly one
candidate on every later allocation, pinned failures included. The router must
return that member. Failure memory therefore steers only new, unpinned tasks;
for a task already pinned to a member with a recent deterministic rejection,
the decision page says so and names the action (unpin or reassign the task).
A pin-release API is a separate upstream request; it is not v1 work.

### 2. Explanation lives in our page

No OSS Paperclip surface renders the router's `skipped` map today. The plugin
page is the explanation channel: last N decisions with task link, chosen
member, score components, and every skip reason. No activity row per decision
(that would flood the company feed); activity is reserved for plugin errors.

### 3. Dual-mode usage, stated plainly

Paperclip attaches usage observations only when the pool is `usage_aware` and
the run has a responsible user. Autonomous and routine runs may have none. The
router is window-aware when observations exist, and otherwise falls back to
task tier, continuity, and fairness with a note on the decision. Missing usage
is never read as healthy or as exhausted. The README states this difference.

### Build order

1. Core scoring and the pinned-safe hook, with a decision page.
2. Failure memory for new tasks.
3. Dry-run shadow mode against the reference rotation.

Each step is usable alone, which protects against SDK churn.

### Corrections taken from the builder check

- The route hook runs even when a task is pinned, with a single candidate.
  Always return `pinnedMemberId`.
- The host's `thresholdPercent` is not enforced anywhere; there is no gate to
  replace, only rotation.
- The effective model is `candidate.runtimeConfig.model`, not
  `member.profile.model`; score that.
- `pool.members` in the request is the authorised candidate subset, not the
  roster. Keep the page honest about that.
- `ctx.state` has get/set/delete, no list. Decisions live in one bounded,
  company-keyed ring; writes happen outside the 5 second route budget.
- `ctx.entities` is not tenant-scoped. Do not use it for decision history.
- Exact manifest capabilities: `ai.connections.route`, `issues.read`,
  `events.subscribe`, `plugin.state.read`, `plugin.state.write`,
  `ui.page.register`, and `agents.read` if agent labels are shown.
- `taskKey` is an opaque correlation key that is usually, not always, an issue
  id or identifier. Classification degrades to `unknown` when the lookup
  returns null; keys are never normalised.
- Declare `multiCompanyConfig: true` and key all state by `companyId`.

## What is left to the builder

- Confirm the latest published versions of `@paperclipai/plugin-sdk` and
  `@paperclipai/shared` at scaffold time and pin them exactly.
- The plugin page data path: `ctx.data.register` (no capability) feeding a
  page entrypoint; confirm the exact UI entrypoint shape against the SDK.
- Run-event capture: subscribe once in `setup()` to `agent.run.failed`, store
  `{memberId, taskKey, agentId, at, class}` from our own route-time record,
  and classify the free-text error behind one module so a future structured
  category can replace the regex.
- Model tier table contents; unknown models are tier 2 with a note.
- Whether the reference round-robin baseline for dry-run matches
  `memberOrder` rotated from `lastMemberId`; replicate whatever the host
  actually does and say "reference rotation" in the UI.

## Risks

- Plugin SDK is alpha; pin versions and keep the surface thin.
- Host usage probing requires a user context; service-to-service heartbeats
  may lack it, in which case usage is missing and the router must stay
  conservative but never block.
- Pool member uniqueness means the router cannot switch models inside an
  account; the product story is "choose the right account and model pair",
  and the docs must say so plainly.
- If Paperclip ships smarter first-party routers, the plugin's staying power
  is the window math, failure memory, and explanation, all of which we own.
