## A defect in the router can no longer stop the editor

Version 0.6.0 could refuse every prompt, in every mode, until the plugin was removed by hand. This release fixes that, and adds the test layer whose absence let it happen while 801 tests passed.

**Upgrade if you are on 0.6.0.** That release is not safe to run.

### What went wrong

Two defects compounded.

1. The process-wide shared core adopted whatever object it found in `globalThis`, with no version check. A new bundle could inherit a core built by an older release, whose ledger had no `planPoolSpent()`, so `premiumState()` threw on every prompt.
2. `routing.failClosed` defaulted to `true`, so that internal `TypeError` became a refusal to serve the prompt. Manual mode and paused routing did not exempt it.

Neither alone was fatal. A stale core with fail-open would have logged a warning. A correct core with fail-closed would have been annoying but usable. Together they disabled the editor.

### The contract now

A defect in this plugin degrades to "do not route", never to "do not work".

- **Blocking is opt-in.** `routing.failClosed` defaults to `false` and means one thing: what to do when this plugin cannot produce a decision. An internal defect now serves the prompt with the model already selected, exactly as if the plugin were not installed, and records the reason in warnings.
- **Quota safety is separate and unconditional.** A provider configured for probing with no reading is still refused, because that is a spending decision about a provider the router cannot see, not a response to its own failure.
- **Hooks cannot throw or hang.** Verified against a real OpenCode process: the host does not catch a throwing hook (HTTP 500) and does not time out a hanging one. Protection has to come from the plugin, so every hook is wrapped in `containHook()` and routing runs against a 10 second deadline, after which the prompt proceeds unrouted.
- **A failed setup installs no hook.** It used to leave a "minimal fail-closed" hook that refused every message, turning a failed setup into a disabled editor.
- **A foreign shared core is replaced, not adopted.** The core is stamped with `SHARED_CORE_API`.

### Also fixed

- **Routing only considers models the host can serve.** The router offered the whole seed catalog as candidates and switched a fresh session onto `opencode-go/claude-haiku-5-5`, which that machine did not have. Candidates are now the intersection with the host's own model list. An empty result means no route, not an unfiltered fallback, because the fallback is how the unservable model got chosen.
- **Model discovery is awaited on the first routing decision**, closing the startup window in which routing could see an empty list.

### Proof rather than assertion

The suite passed while the product was unusable, so unit tests were not enough. `scripts/isolated-e2e.sh` now runs a real OpenCode process in a throwaway HOME and asserts only that OpenCode still answers a prompt. It runs against a loopback model stub it starts itself, so it needs no credentials, spends nothing, and cannot be blocked by provider quota. A CI job runs it on every push.

Its `stale-shared-core` scenario reproduces the production failure at host level, planting a previous version's core before the bundle loads. On the 0.6.0 bundle it fails with HTTP 500. On this release it passes. The scenario is red on the old code, so it measures the defect that actually occurred.

Current state: 822 tests across 75 files, all 69 mutation properties caught, clean-room verification with an empty HOME, and 7 host-survival scenarios passing with 2 documented host limitations.

### Upgrading

Install the new version and reload. Nothing about the old configuration needs to change; `failClosed` simply defaults to the safe value. If you had set `routing.failClosed: true` deliberately, it still works, but now it covers plugin faults only.

The full account, including the exact production log lines, is in [docs/INCIDENT-2026-11-06-prompt-lockout.md](https://github.com/qadanm/opencode-smart-router/blob/main/docs/INCIDENT-2026-11-06-prompt-lockout.md).
