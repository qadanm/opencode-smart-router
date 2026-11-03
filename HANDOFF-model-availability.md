# Handoff: model-availability fixes (in progress)

Branch `feature/offline-mode`, HEAD `ec40871`, **uncommitted changes in the working tree.**
`tsc --noEmit` is clean. `npx vitest run` → **484 pass, 1 fail** (the failing one is
expected and explained below).

## The live defect being fixed

`Model unavailable: opendesign/deepseek-v4.1-flash` killed six live sessions on 2026-11-03.
Verified NOT the gateway, key, subscription, or config: the model is in `opencode.json`,
in `opencode models`, and on the gateway.

Root cause, from OpenCode's log:

```
02:47:49.181  loading plugin  opencode-smart-router
02:47:49.846  watcher stopped path=.../index.js
02:47:50.225  ModelUnavailableError: opendesign/deepseek-v4.1-flash
```

Four of six failures landed within 10s of a plugin load; three within 1 second. The plugin
directory was being replaced under a running server (`rm -rf` in the old installer, then a
non-atomic rename). Deleting/invalidating the plugin mid-session empties the provider's model
list, so the next `SessionRunner.advanceToStep` cannot resolve the model it holds.

## Four fixes

### 1. `modelResolvable()` — COMMITTED in `ec40871`
Before switching, ask `ctx.model.get(providerID, modelID)` and skip the switch if the host
answers "no". A **missing or throwing** API means "allow", not "refuse": a host that cannot
answer must not silently stop all routing. Test: `test/model-resolvable.test.ts` (4 cases),
validated by reverting the guard and watching the skip case fail.

### 2. `sessionBusy()` gate — DONE, uncommitted
`src/server/controller.ts`. Defer any `switchModel` while the session is mid-turn, because the
switch applies to the *next* step and that step is what dies.

Two signals, both needed:
- `this.stepStarted` — precise, in-process, but emptied by a plugin reload.
- `ledger.getSession(id).status === "busy"` — persisted, survives a reload.

A false positive only defers to the next prompt; a false negative breaks the turn.

### 3. Installer — DONE, uncommitted
`scripts/install.sh`. Was `rm -rf $INSTALL`; now writes temp + atomic rename, replaces the
`node_modules` symlink the same way, and warns when OpenCode is running.

**This is NOT sufficient and the handoff owner must finish it.** The atomic rename still
triggers the watcher — the 06:20:26 failure happened 0.4s after an atomic-rename install. The
agreed fix is to install to a **versioned path** and update the config pointer, so the running
module is never invalidated in place.

### 4. Fail-closed on missing quota — DONE, uncommitted, HAS ONE FAILING TEST
`src/core/policy/eligibility.ts` + `src/core/routing/engine.ts`.

`providerLimitReached` started `if (!snapshot) return undefined` — absent quota meant *allowed*.
During the ~1.5s before `QuotaService` starts, every provider looks available, so a decision
routes straight into an exhausted allowance. That is how GOAT was selected with
`rolling.usedPct = 100, exceeded = true`.

Added `quotaIsKnown` (true when any snapshot has a non-`unknown` source). Missing snapshot now
fails closed **only when other providers have fresh data** — when nobody has reported we are
blind and must keep routing.

**FAILING TEST:** `test/opendesign.test.ts > falls back to another provider when OpenDesign is
cooling down`
(`expected 'opendesign' not to be 'opendesign'`, line 859).

The fixture supplies a snapshot for opendesign only, so under the new rule the fallback provider
is treated as unprobed and blocked, and the decision stays on the cooling provider. **Decide
which behaviour is correct before committing:**

- If a cooling swap must still work, the rule needs to exempt providers that were simply not
  part of this decision's probe set — i.e. distinguish "unprobed" from "probed and empty".
- If staying put is right, the test fixture is unrealistic and should supply snapshots for all
  enabled providers.

Note the deliberate asymmetry already in the code: an **absent** snapshot blocks, but a
**failed probe** (which yields an `unknownSnapshot`) does not — it falls through to
`unknownQuotaLimit`, whose default policy is `"route"`.

### 5. Sticky exhaustion — NOT STARTED
`read()` marks snapshots `stale: true`, but eligibility uses `stale` only as a 0.15 cost penalty
(`eligibility.ts:505`). A stale *permission* is also used as a stale *refusal*, so the moment a
probe ages out, an exhausted provider becomes eligible again.

Also unaddressed: `refresh()`'s `.catch()` in `src/core/quota/service.ts` overwrites a good
snapshot with an `unknownSnapshot` on probe failure, which erases a known-exhausted state.

Intended rule: a recently-observed `exceeded` keeps blocking until a **fresh** probe contradicts
it, rather than expiring with the cache.

## Evidence files (from the live machine, read-only)

- `~/.local/share/opencode/log/opencode.log` — failure and reload correlation.
- `~/.local/share/opencode/opencode.db`, table `kv`, key
  `plugin:<hex>:quota-cache-v1` — the real snapshots. GOAT:
  `rolling usedPct=100 exceeded=true`; opendesign `monthly source=estimate, remainingUsd≈346.76`.
- `plugin:<hex>:ledger-v1` — 120 decisions, **newest 2026-10-31T07:51Z**, i.e. the router
  recorded no decisions for three days. The session in question was `manualOverride: true`,
  pinned to `opendesign/deepseek-v4-flash` while the config default is `deepseek-v4.1-flash`.
  Worth understanding before trusting any "the router chose X" claim.

## Do not

- Do not reinstall into a running OpenCode until fix #3 is properly finished.
- Do not treat the six failures as network faults. There ARE real transport failures
  (`opencode.ai/console/api/v2/config` → `ENOTFOUND`/`ECONNREFUSED`, plus `opentunnel.xyz`
  certificate fetch failures, 77 today), but their timestamps do **not** overlap the
  `ModelUnavailable` events. They are a separate, intermittent issue — a plausible cause of the
  model disappearing from the picker, since the provider list is fetched remotely.
