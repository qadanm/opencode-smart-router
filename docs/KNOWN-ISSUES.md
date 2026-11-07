# Known issues

Defects that are understood but not yet fixed. Each entry records what is
wrong, how to tell you are hitting it, why it happens, and what it does and does
not affect. This file exists so that a known defect is never discovered twice
and never quietly forgotten.

Last updated 2026-11-07, against 0.6.1.

## KI-1. OpenDesign quota can be reported far too high (settings frozen per process)

**Severity:** high. It suppresses routing on OpenDesign and can suppress every
other route at the same time.

**Status:** open. Not fixed in 0.6.1.

### What is wrong

The router's OpenDesign weekly figure can be computed from an account reading
you already replaced. The number it shows and the number your account shows can
differ by more than half the weekly allowance.

Measured on 2026-11-07, with the account page showing 45 percent of the
seven-day Design Plan allowance used (Pro, `$90` weekly cap):

| Source | Weekly figure | State |
| --- | --- | --- |
| OpenDesign account page | `$40.50`, 45 percent | allowance remains |
| Router | `$92.87`, 100 percent | `exhausted` |

The router overstated usage by `$52.37`, which is 58 percent of the entire
weekly cap.

### How to tell you are hitting it

The router's percentage disagrees with the account page, and the arithmetic
decomposes onto an older reading rather than your current one:

```text
97% x $90 = $87.30        <- an earlier reading, not the current one
tracked     + $5.15
             --------
              $92.45     -> reported as 100 percent, "exhausted"

45% x $90 = $40.50        <- the account page
tracked     + $5.15
             --------
              $45.65     -> should be 51 percent, eligible
```

Run `grep -n designPlanUsedPct ~/.config/opencode/smart-router.json` and compare
it with the router. If the file says one figure and the router behaves as if it
were a larger one, you are hitting this.

### Why it happens

Three properties combine.

1. **Settings are read once, in the controller constructor.** Nothing watches
   `smart-router.json`. `reloadSettingsFromDisk()` has a single caller, the GUI
   save path, so a paste is applied only in the process that handled it.

2. **A long-lived process keeps the reading it started with.** A background
   `opencode serve` that started while the file held an older percentage holds
   that value for its whole lifetime, re-probes every five minutes, and writes
   the result to the shared `quota-cache-v1` row in the OpenCode database. Every
   other process reads that row.

3. **A stale refusal outlives the setting that caused it.** `providerLimitReached`
   checks `exceeded` before it looks at `stale`, deliberately, so that a provider
   that ran out does not silently resume. The effect here is that a persisted
   `exceeded: true` survives a restart until a fresh probe replaces it, and the
   stale process keeps putting it back.

Reproduced on 2026-11-07: a quota cache row fetched nine milliseconds after a new
reading was written still carried the previous reading. A probe was already in
flight and was returned through `state.inFlight` rather than restarted.

### What it does not do

It does not block prompts. This is a reporting and selection defect, not an
admission defect. Verification on the affected machine: zero `RouterBlocked`
events, and a prompt sent with automatic routing on completed normally on the
model already selected.

The failure mode is that the session is left alone. Zero candidates are found,
the router reports that no approved model meets every hard requirement, and
OpenCode continues on the current model. That is the intended fail-open
contract, driven by a wrong input.

### Consequence when it fires

Because OpenDesign is the provider the plan-model pool belongs to, a wrongly
exhausted OpenDesign also removes escalation. If the other providers are
simultaneously near their own reserves, the eligible set is empty and nothing is
routed at all, including tier-3 work that the plan-model pool could have funded.

### Workarounds until it is fixed

- Restart every OpenCode process after changing the account reading, not just
  the window in front of you.
- Confirm the figure with `grep -n designPlanUsedPct` against the router panel.
- If a wrong `exhausted` persists, clearing the cached quota row forces a fresh
  probe. This is a manual step and is not recommended without a backup.

### The shape of the fix

The snapshot must be anchored to the settings that produced it and discarded
when those settings change, and settings must be reloaded when the file changes
on disk. Either alone is insufficient: the first fixes the wrong number, the
second stops a long-lived process from reintroducing it.

## KI-2. The panel cannot show why a model was rejected

**Severity:** low. It affects explanation, not routing.

The decision card shows `0 eligible, 0 blocked` whenever no route was found. The
second number is always zero, because the decision record only stores candidates
that passed every gate. Rejected models are evaluated and then discarded, so the
panel has nothing to list and no reason to show.

The panel also labels the card `BLOCKED` whenever nothing was chosen, even though
the session was left running on its current model. The word is misleading in a
release whose point is that a router defect never blocks the editor.

Both are display defects. `test/gui-viewmodel.test.ts` asserts that a blocked
candidate renders with a reason, but it constructs that shape by hand. No engine
path produces a blocked candidate today, so the assertion guards the view model
rather than the pipeline that feeds it.
