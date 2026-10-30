# Audit: why DeepSeek V4.1 Flash shows a 328,000-token context

Date: 2026-10-30. Read-only audit. No configuration was changed and no session was
modified, compacted, or switched during this investigation.

## Summary

The 328,000 figure is **not** a router restriction. It is a literal value in the
owner's OpenCode config, written during the OpenDesign Go era and carried forward
unchanged across the Pro upgrade. Two independent layers consume it:

1. `~/.config/opencode/opencode.json` declares `limit.context: 328000` for that
   model. OpenCode then compacts at `328000 - 24000 = 304000`.
2. The router's own `toLiveModels` reads the gateway's `context_budget` (328,000)
   and uses it as the model window, so its eligibility gate rejects the model
   above `328000 * 0.95 = 311,600`.

Both layers agree on the same number, which is why the limit looks systemic. It
is two separate decisions that happen to match.

## What each layer actually is

| Layer | Where | Value | Authority |
|---|---|---|---|
| Vendor window | gateway `metadata.context_limit` | 1,048,000 | the model can accept this |
| Gateway prompt budget | gateway `metadata.context_budget` | 328,000 | **see evidence below** |
| OpenCode model window | `opencode.json` `models[].limit.context` | 328,000 | hand-written config |
| OpenCode compaction trigger | `opencode.json` `compaction.buffer` | 24,000 | host behavior |
| Router model window | `src/core/providers/opendesign.ts:377` | 328,000 | derived from `context_budget` |
| Router eligibility gate | `src/core/policy/eligibility.ts:236` | 311,600 | `window * 0.95` |
| Router compaction trigger | `src/core/context/strategy.ts:77` | 311,600 | same, native mode only |
| Go plan definition | router and gateway | irrelevant to context | context is not plan-scoped |

## Exact code paths

### Provider metadata to router window

`src/core/providers/opendesign.ts:374-384`

```ts
const spec = OPEN_DESIGN_MODEL_BY_ID.get(model.id)
const vendorLimit = model.contextLimit > 0 ? model.contextLimit : 0
const reported = model.contextBudget ?? vendorLimit
const context =
  reported > 0 && (vendorLimit === 0 || reported <= vendorLimit)
    ? reported
    : vendorLimit > 0
      ? vendorLimit
      : (spec?.context ?? OPENDESIGN_FALLBACK_CONTEXT)
```

For `deepseek-v4.1-flash` the gateway reports `contextBudget: 328000`, so
`reported = 328000` and `context = 328000`. The 1,048,000 vendor limit is read
and then discarded.

### Router window to eligibility rejection

`src/core/policy/eligibility.ts:235-236`

```ts
const requiredContext = Math.max(input.contextTokens, task.scope.promptTokens) + 20_000
if (model.context > 0 && requiredContext > model.context * 0.95) {
```

At 328,000 this rejects a transcript above 311,600 tokens.

### Router window to compaction

`src/core/context/strategy.ts:76-77`

```ts
const required = contextTokens + CONTEXT_ELIGIBILITY_MARGIN_TOKENS  // 20_000
const safeLimit = effectiveWindow * CONTEXT_SAFE_WINDOW_FRACTION    // 0.95
const overflow = required > safeLimit
```

In `native` mode compaction fires only when `overflow` is true, so the same
311,600 threshold applies. `native` is the active mode.

### OpenCode's own compaction

`~/.config/opencode/opencode.json`

```json
"compaction": { "auto": true, "keep": { "tokens": 12000 }, "buffer": 24000 }
```

The host compacts at `limit.context - buffer`. This is not the router; it fires
whether or not the plugin is loaded.

## Evidence that the router's compaction is not what stops long sessions

Every auto-compaction in the last 30 days, with the context measured
immediately before it, and the model's declared `limit.context`:

| When | Model | Context before | `limit.context` | `limit - 24000` | Delta |
|---|---|---|---|---|---|
| 10-24 07:42 | deepseek-v4.1-flash (Command Code) | 849,378 | 1,000,000 | 976,000 | -126,622 |
| 10-26 11:00 | deepseek-v4.1-flash (OpenCode Go) | 975,867 | 1,000,000 | 976,000 | -133 |
| 10-27 18:14 | deepseek-v4.1-flash (OpenCode Go) | 975,798 | 1,000,000 | 976,000 | -202 |
| 10-28 18:30 | glm-5.3-flash (OpenDesign) | 208,064 | 232,000 | 208,000 | +64 |
| 10-28 23:16 | deepseek-v4.1-flash (OpenDesign) | 303,827 | 328,000 | 304,000 | -173 |
| 10-29 08:34 | deepseek-v4.1-flash (OpenDesign) | 299,230 | 328,000 | 304,000 | -4,770 |
| 10-29 22:22 | deepseek-v4.1-flash (OpenDesign) | 303,871 | 328,000 | 304,000 | -129 |
| 10-30 04:22 | deepseek-v4.1-flash (OpenDesign) | 303,631 | 328,000 | 304,000 | -369 |

Each event lands on `limit.context - 24,000` regardless of provider. Compaction
tracks the **host's config value**, not any router threshold. The router's own
trigger (311,600) never fired first because the host fires at 304,000.

## Evidence about whether `context_budget` is enforced

### External, from a project that reverse-engineered this gateway

`@lokeraar/pi-opendesign-bridge` documents the fields directly:

> `context_limit` is the window, `output_budget` is the answer ceiling ... It is
> never derived from `context_budget`, which measures how much the prompt may
> occupy, not how much the model may answer

and, decisively:

> `metadata.context_limit` outranks `context_budget` because the first is the
> model capability and the second the share one deployment accepts.

Two points follow. `context_budget` is a **deployment share**, not a model
incapability. And an independent client chose the vendor limit as the context
window. That is a design opinion, not proof of enforcement.

### Internal, from 45 days of this machine's own request history

| Model | Peak observed input | Calls above 328,000 |
|---|---|---|
| minimax-m3.1-flash | 506,877 | **371** |
| deepseek-v4.1-flash | 303,871 | 0 |
| glm-5.3-flash | 208,064 | 0 |
| deepseek-v4-flash | 183,258 | 0 |

All 371 calls above 328,000 were on `minimax-m3.1-flash`, which reports no
`context_budget` at all, so the gateway accepted 506,877 tokens on a model whose
vendor limit is 1,000,000. Their `finish` values were 370 `tool-calls` and 1
`stop`. No `length` finish, no errors, no truncation.

There is also no context-length error anywhere in the archive. The only errors
matching "context" are `workspace_billing_scope_unavailable`, which is an
upstream billing API timeout, unrelated to context.

### What this does and does not prove

It proves the gateway does not reject a 1M-window model at 328,000 tokens. It
proves nothing about the 232,000-400,000 range on models that *do* report a
budget, because no such model has ever been sent a transcript above its own
budget on this machine.

It does **not** prove the gateway accepts `deepseek-v4.1-flash` above 328,000.
DeepSeek has never been sent a transcript that large on this gateway. Its peak is
303,871, which is below the router's own gate. The two facts are consistent with
either "the budget is advisory" or "the budget is enforced per model", and this
archive cannot distinguish them.

That gap is the honest answer to "is 328,000 real". It is unresolved.

## Did the router write these limits?

No. `grep -rn "opencode.json" src/ scripts/` finds only `install.sh`,
`uninstall.sh` and the lab canary script. `install.sh` reads the config to check
it exists and backs it up; it never writes a `models` block or a `limit`.

The block was written by hand during Go onboarding. `opencode.json`'s provider
entry is still named `"OpenDesign Go"`, and the `limit` values match the gateway
metadata of 2026-10-28 rather than any stale Go-era table.

## Go-era leftovers that did survive

| Item | Status | Impact |
|---|---|---|
| `providers.opendesign.name = "OpenDesign Go"` | stale label | cosmetic; the plan is separately `pro` |
| `limit.context: 328000` for DeepSeek | current metadata, but a hard cap | the actual restriction |
| Router uses `context_budget` over `context_limit` | deliberate, documented | the second restriction |
| `contextManagement.mode: native` | correct for Pro | none; does not compact early |
| `contextManagement.compactAtTokens: 0` | correct; only used by `budget-optimized` | none |
| `routing.longContextFloorTokens: 1000000` | **dead setting** | declared and validated, never read by any code |
| Plan resolution | `pro`, correct | none |

The Go-era early-compaction subsystem is **not** active. `native` mode compacts
only on real overflow, and the evidence shows the host's own compaction fires
first anyway.

## Effective ceiling today

| Route | Ceiling | Set by |
|---|---|---|
| DeepSeek V4.1 Flash on OpenDesign | 304,000 compaction / 311,600 router rejection | `opencode.json` + router |
| MiniMax M3.1 Flash on OpenDesign | 976,000 compaction / 950,000 router rejection | `opencode.json` 1,000,000 |

A session on DeepSeek loses its history at 304,000 tokens while the model may
well accept 1,048,000.
