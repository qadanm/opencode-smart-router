# Self-healing routing: repair incompatible prompts, fail over deterministic rejections

Date: 2026-11-05
Status: approved approach C (repair + failover); builder check applied

## Intent and why

A routed session switched from `opendesign/glm-5.3-flash` to
`commandcode/claude-haiku-5-5`. The rebuilt prompt carried OpenCode's
mid-session `system` notices ("Today's date…", "New instructions…") as
`role: "system"` entries inside `messages[]`. The Anthropic-protocol path
rejects anything but `user | assistant`, so the whole turn died with:

```
provider.invalid-request: Invalid discriminator value. Expected 'user' |
'assistant' at messages.23.role
```

Evidence: session `ses_e55488493ffd7F4CTq0r6RWcCu` (tuck), `session_message`
rows 13, 44 (system notices), 50 (synthetic), 55 (failed attempt). Root cause
confirmed in OpenCode core `runner/to-llm-message.ts`:

```ts
case "system":
  return [Message.system(message.text)]
```

Upstream fix is not ours to ship (see `docs/UPSTREAM-ISSUE-billing-scope.md`
for the same posture on the billing 503). The user decision: the router
catches these failures and recovers, and the capability becomes a headline
feature — self-healing routing.

## Verified mechanics (host 2.2.5)

- `session.hook("context", …)` exists and the host's own bundled Claude
  integration **mutates `event.messages` in place** (`a.messages =
  a.messages.map(...)`). Prompt repair is an officially used pattern.
- The retry hook can only `{ retry: true, delay }` or `{ retry: false }`; it
  cannot change model mid-turn.
- The session API exposes `prompt`, `synthetic`, `switchModel`, `compact`,
  `interrupt` (strings confirmed in the host binary). Auto-continue after
  failure is mechanically possible; exact signatures verified at build time
  with a fallback (below).

## Goals

1. **Repair** prompts whose shape a provider will deterministically reject
   (system-role entries mid-conversation on Anthropic-protocol providers), so
   the turn continues on the chosen model with no user-visible error.
2. **Fail over** deterministic rejections we cannot repair: stop wasting
   retries, exclude the rejecting pair, continue the turn on the next best
   eligible model.
3. Make the recovery **visible and honest**: the decision record and panel
   show what was rejected and what took over ("self-healed"), never silently.
4. Marketing: README section + panel copy for self-healing routing.

## Non-goals

- Fixing OpenCode core or filing the upstream patch (tracked separately).
- Changing outage / rate-limit / quota behavior — those paths stay as they are.
- Repairing prompts on sessions the router does not own.

## Anti-goals (failure to avoid)

- Auto-continue loops: a repair or failover must never re-trigger itself past
  the caps below.
- Charging quota for doomed requests: zero immediate retries of a request the
  provider deterministically rejected.
- Ghost prompts: a synthetic continuation must be marked as router-generated
  in its text and capped at one per user prompt.

## Constraints

- Plugin API of host 2.2.5; degrade gracefully on older hosts (hook names
  guarded the same way `compact` already is).
- The `context` hook event (`SessionContext`) has fields `sessionID, agent,
  model, system, messages, options, tools` and **no `kind` field**; the
  primary-only gate is therefore implemented by latching `kind` from the
  `model.request` hook (its event carries `kind`), keyed by sessionID in a
  bounded map, with a build-time probe confirming the two hooks fire per
  request in `model.request`-then-`context` order. If ordering cannot be
  confirmed, the fold is skipped rather than guessed.
- Ownership: the context hook uses `ensureOwnership()` (the `session.get` +
  `projectMatches` + `claimSession` path), not the bare `ownerOf` check.
- Repair must be provider-conditional: only fold `system` entries when the
  target provider is Anthropic-protocol. Detection: the router's registry
  gains a `protocol` field (`"anthropic" | "openai-compat"`), seeded from the
  provider package/model family and overridable in settings. When unknown,
  fold anyway is the safer default for Anthropic-family models only.
- `role: "tool"` messages: repairing them is out of scope (a rewrite implies
  re-pairing call and result parts). If a provider rejects a tool-role entry,
  Layers 2 and 3 handle it: classified, no retry, failed over.

## Approach (C, as picked)

### Layer 1 — prompt repair (prevents the failure)

New `src/core/reprompt.ts`, wired in `registerHooks()`:

- `ctx.session.hook("context", ...)`; verify the event's session is routed by
  this bridge (same owner check as `model.request`).
- Only when `event.kind === "primary"` AND protocol is anthropic:
  fold every `messages[i]` with `role === "system"` where `i > 0` into a
  `user` message with identical content (prefix `[system]` preserved as
  plain text). Index 0 system stays untouched (the adapter hoists it into the
  system param; folding it would change Anthropic prompt-cache behavior).
- Record folded counts in diagnostics; a fold that changed nothing is a no-op.

Rationale for user-role folding rather than merging into the adjacent user
message: same downstream meaning, no adjacency edge cases, matches what
OpenAI-compat gateways do with mid-stream system content.

### Layer 2 — classification fix (stop paying for doomed requests)

`src/core/failures.ts`:

- New class `prompt_rejected`, matched **before** the provider-stream rule
  that currently swallows it (and before the generic `invalid_request`
  message rule). Match on: `type === "provider.invalid-request"`, or
  Anthropic `invalid_request_error` bodies naming `messages.<n>.role`
  positions, or `Invalid discriminator value` / `Expected 'user' |
  'assistant'` patterns. **No status requirement**: a locally built
  InvalidRequestError may carry no status at all, and the tuck error string
  ("Invalid discriminator value...") does not contain the words
  "invalid request", so message-text matching alone is insufficient.
- Properties: `retryable: false`, `countAgainstModel: false` (the model is
  healthy; the prompt shape was the problem — with Layer 1 this should
  already be repaired), `providerScoped: false`, cooldown short (5 min) and
  reason text explaining the failover.
- Registry bookkeeping: add `prompt_rejected` to the `FailureClass` union
  (`src/core/types.ts`) and to `emptyFailureCounts()` in the ledger.
- This kills the current bug where `provider.invalid-request` lands in the
  `provider.` stream rule, gets classified as `provider_outage`, and tells
  the host to retry a deterministic 400 (exactly the retry-then-die loop the
  user observed).

### Layer 3 — failover + auto-continue (recovers the turn)

`src/server/controller.ts`, `registerHooks()`:

- On `retry` with class `prompt_rejected`: `event.decision = { retry: false }`,
  record the pair (providerID, modelID) into a **session-scoped exclusion**
  for the current prompt. Home: an in-memory controller map keyed by
  sessionID (bounded, pattern of `expectedSwitch`), passed into the failover
  routing call as a synthetic cooldown entry; cleared on the next `prompt`
  hook. Not persisted — it is one prompt wide.
- Candidate selection: re-call the routing engine with the prompt's stored
  `RoutingDecision.task` (no prompt text needed); the engine's cooldown and
  switch-penalty gates already apply, and the excluded pair enters as a
  synthetic cooldown. `switchModel` may need the candidate's `variant`.
- Switch timing: the codebase refuses mid-turn switches while a step is
  queued (`sessionBusy`). With `retry: false` the doomed execution is ending,
  so the switch is performed immediately in the retry hook under a
  `sessionBusy` guard; if somehow still busy, the switch defers to the
  `session.idle` handler. Precedent: this is not the busy-switch case that
  produced "Model unavailable" on 2026-11-03 — that was switching under a
  live queued step, which the guard prevents.
- Auto-continue: reuse the production synthetic pattern that already exists
  (`ctx.session.synthetic({ sessionID, text, description: "Smart Router",
  resume: false })`): one synthetic continuation per user prompt, text
  `[router] <model> rejected the request (invalid request). Continuing on
  <candidate>.`, keyed by the prompt hook's `messageID` (currently dropped by
  the prompt handler; it will be stored alongside the routed decision).
  Build-time probe answers whether a synthetic after a failure launches a
  fresh execution or waits for the idle wake; if it only wakes later, the
  failover still ships — recovery happens at wake time and the panel says so.
- Guards for auto-continue: a next-best candidate exists; the synthetic call
  is available; the failed attempt produced **zero tool parts** (no side
  effects to duplicate); cap of exactly one per prompt; never twice
  consecutively.
- If no candidate or a guard fails: leave the turn failed, but the session
  exclusion plus cooldown still make the **next prompt** route elsewhere.
  Panel note is set either way (Layer 4).

### Layer 4 — visibility (decision record + panel + marketing)

- Decisions gain a `selfheal` annotation: rejected model, reason, action
  (repaired | failed-over-to X | noted-for-next-prompt).
- Panel "Last decision" renders the line when present.
- README: a "Self-healing" section with the true story — prompts repaired in
  flight, doomed requests never retried, one-step failover — plus CHANGELOG.

## What is left to the builder

- Live probe: whether a synthetic injected after a failed turn runs at once
  or at the idle wake; both outcomes have a defined recovery shape above.
- Probe: `model.request` fires before `context` for the same request (the
  kind-latch depends on it; fold skips if it cannot be confirmed).
- The `protocol` settings override requires extending
  `validateDefinitions` (`src/core/config.ts`), which currently drops
  unknown keys from `models.definitions`.
- Test harness additions: assistant fixture must carry content (tool vs
  text) for the zero-tool-parts guard; retry-hook tests claim the session
  first (pattern of `test/retry-backoff.test.ts`). Synthetic calls are
  already captured in `test/helpers/ctx.ts` (`syntheticCalls`).
- Whether the adapter hoists a mid-conversation system at index != 0 (tests
  encode the tuck fixture; a fixture with system at index > 0 must come out
  folded to user; system at index 0 must stay untouched, including the
  separate `event.system` Array of SystemPart being an entirely different
  channel from `event.messages`).
- Tests: classifier fixture for the exact error string with no status; repair
  unit tests incl. system-at-0 untouched, system-mid folded, non-primary
  kinds skipped, fold noop when nothing changes; failover loop-guard tests
  (cap, zero-tool-parts guard, no candidate, busy deferral).
- Docs-consistency test constraints (no em/en dashes and no British
  spellings anywhere in README or docs; README test count must match the
  real count after new tests land).
- Panel copy stays short; the decision line may be truncated.

## Rollout / verification

- Full suite `npm run check` green; the tuck-session error reproduced as a
  fixture must end "repaired, no retry", and a forced-unrepairable variant
  must end "failed over once, capped".
- Install locally, replay a session that hits the system-notice path on a
  claude-protocol model, confirm the turn completes.
