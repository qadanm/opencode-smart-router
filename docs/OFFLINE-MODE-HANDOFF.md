# Offline development mode: work in progress handoff

Written 2026-10-30. Branch `feature/offline-mode`, commit `d26e014`.

This document exists so the work can be resumed without re-deriving anything.
It states what is done, what is not, and the exact next action. Nothing here is
aspirational: every claim has been run on the machine.

## Where things stand

| Area | State |
|---|---|
| Router enforcement (offline isolation) | Done, tested |
| Settings and validation | Done, tested |
| Local model installed and verified | Done |
| Online routing preserved | Done, asserted |
| CLI commands (`opencode-offline` etc.) | **Not started** |
| Screenshot workflow scripts | Not started |
| Benchmark harness | **Not started**, and blocked |
| Vision quality verdict | **Unresolved**, fixture is at fault |
| Disconnected-network test | **Not run** |

`npx tsc --noEmit` passes. `npx vitest run` passes: 415 tests, 32 files.

## Environment, measured

- OpenCode **v2.1.4**, V2 plugin API (`@opencode/plugin` 2.1.4)
- Machine: MacBook Pro 18,1, M1 Pro, 10 cores, 16 GB
- Xcode 26.4.1, iOS 18.6 and 26.4 runtimes
- Internal disk: 114 GB free at install time
- External `/Volumes/Mac-Archive`: **slow, 4.5 MB/s write** measured. Do not put
  a model store there. Decision taken: internal SSD only, no external dependency.
- Ollama **0.40.13** via Homebrew, installed at `/opt/homebrew/bin/ollama`
- Model `qwen3.5:4b-q4_K_M`, 4.2B params, 3.3 GB, at `~/.ollama/models`
- Ollama server runs on `127.0.0.1:11434`, loopback only, no login item

Started by this work, still running, safe to stop:

```bash
pgrep -f "ollama serve"   # PID was 37242
```

## Files added

| Path | Purpose |
|---|---|
| `src/core/offline/mode.ts` | Offline policy. Allow-list of one provider, blockers with remedies, loopback enforcement, per-request Ollama options, memory-fit math. Deliberately free of host I/O so it is exhaustively testable. |
| `test/offline-mode.test.ts` | 40 tests. Refusal reasons, allow-list, loopback, margin scaling, routing boundaries. |
| `test/online-routing-regression.test.ts` | 4 tests. The four recorded online decisions, captured before any change. |
| `scripts/probe-local-model.py` | Real measurements through Ollama's HTTP API. Avoids curl JSON quoting bugs. Subcommands: `text`, `think`, `vision`, `tools`, `memory`. |
| `scripts/make-vision-fixtures.py` | Generates a broken/clean screenshot pair with four planted faults, so vision can be scored against ground truth. |
| `scripts/score-vision.py` | Scores the model on those fixtures: recall, false positives, latency, image tokens. |

## Files modified

- `src/core/routing/engine.ts` , candidate narrowing is the **first** thing
  `routeTask` does, before quotas, escalation, premium and costing. This is the
  single enforcement point. Empty result returns an explicit refusal.
- `src/core/policy/eligibility.ts` , the intelligence floor is exempted for
  local models **only while offline**. Also now reads the shared context
  constants instead of literals.
- `src/core/context/strategy.ts` , added `replyMarginFor(window)`. A flat 20,000
  margin exceeded an 8,192-token window entirely.
- `src/core/models/registry.ts` , added `modelsForOffline()`.
- `src/core/models/seed.ts` , added the local model, deliberately `approved:
  false` and scored below the online floor so it can never win an online route.
- `src/core/config.ts` , `validateOffline`, plus an `ollama` provider entry.
- `src/core/types.ts` , `offline?: OfflineSettings` on `RouterSettings`.
- `src/server/controller.ts` , added `routingModels()`.

## The single design decision that matters

Offline enforcement is an **allow-list of one provider** applied at the top of
`routeTask`, not a deny-list of known hosted providers. A deny-list fails open
when someone later adds a provider; an allow-list fails closed. The tests assert
that an unrecognized provider is refused offline.

## Measured model behavior

These are facts, not estimates.

**Thinking consumes the output budget.** This is the biggest gotcha. At
`num_predict: 800` the model spent all 800 tokens on thinking and returned empty
`content`. Results:

| num_predict | eval | thinking chars | content chars | complete |
|---|---|---|---|---|
| 200 | 200 | 805 | 0 | no |
| 400 | 400 | 1514 | 0 | no |
| 800 | 800 | 2853 | 0 | no |
| 1600 | 748 | 1438 | 1165 | yes |
| 3000 | 834 | 2049 | 754 | yes |

Disabling it via the OpenAI-compatible shim, which is the path OpenCode uses:

| setting | eval tokens | wall | result |
|---|---|---|---|
| `reasoning_effort: "none"` | 414 | 21 s | full output |
| `think: false` (native API only) | , | , | works natively, **not** forwarded by the shim |
| `chat_template_kwargs.enable_thinking:false` | , | , | **ignored** |
| default | 791 | 38 s | partial |

`reasoning_effort: "none"` is the setting to use. The `think` parameter is not
forwarded through `/v1/chat/completions`.

**Vision token cost scales with pixel area.**

| image | pixels | prompt tokens | wall |
|---|---|---|---|
| 1170×1170 | 1.37 MP | 970 | 4.8 s |
| 1170×2700 | 3.16 MP | 3,196 | 3.6 s |

Downscale screenshots before sending. A raw 1640×2360 simulator capture is
3,839 prompt tokens, which leaves no room for output in an 8K window.

**Tool calling works.** Correct `read_file` call, consumed the tool result,
continued with a sensible answer, no repeated call. The component it generated
had a real bug (`styles.active` applied unconditionally instead of
`active && styles.active`), which is a normal 4B limitation.

## Context budget arithmetic

With `contextTokens: 8192`, `CONTEXT_SAFE_WINDOW_FRACTION` 0.95 and
`replyMarginFor(8192)` = 1,024:

```
usable transcript = floor(8192 × 0.95) − 1024 = 6,758 tokens
```

Verified at the boundary: 6,758 routes, 6,759 is refused. Whether 6,758 tokens
is enough for a real component edit plus a screenshot has **not been tested**.

## The unresolved problem: vision scoring

Current score, `python3 scripts/score-vision.py --reasoning none`:

```
recall 3/4, false_positive_categories 2, avg_wall 2.4s, avg_image_tokens 3196
```

Do **not** treat this as a model verdict. The fixture is partly at fault: the
button sits close enough to the canvas edge that "the Continue button is clipped
at the bottom" is a defensible reading of the **clean** image too. A clean image
that looks broken cannot measure false positives.

Next action on this: give the button at least 200 px of clearance on both
fixtures, re-render, re-score. Only then is the number meaningful. If false
positives persist on a genuinely clean image, record it as a limitation and
require the human to confirm any visual diagnosis before applying an edit.

## Next actions, in order

1. **Fix the vision fixture.** Add bottom clearance in
   `scripts/make-vision-fixtures.py`, rebuild, re-score. This is a five-minute
   job and it unlocks the only unresolved capability question.
2. **Write the CLI wrappers.** `opencode-offline`, `opencode-online`,
   `opencode-offline-status`, `opencode-offline-preflight`. They go in
   `scripts/` with a small installer. Requirements already decided:
   - `opencode-offline` verifies the endpoint, the model, and free memory, then
     launches OpenCode with `offline.enabled: true`.
   - It must **not** start a duplicate server if one is already listening.
   - It must fail with a clear message if the model is missing, never pull one.
   - `opencode-online` restores the previous settings without touching
     credentials. The reversible mechanism still needs choosing.
3. **Fix the stale `opencode.json` ollama block.** It names
   `qwen2.5-coder:7b` and `qwen3:8b`, neither installed, and uses
   `localhost:11434` while the router validates `127.0.0.1:11434`.
4. **Benchmark, but only when the machine is quiet.** Not yet possible: 4 QA
   simulators were booted, 12.7 GB of the 14 GB swap was in use, and free memory
   was 18%. Any timing measured then is invalid. The owner said QA would take
   about 20 minutes from roughly 23:50.
5. **Screenshot workflow.** Reuse `xcrun simctl io booted screenshot`, downscale
   to ~1170 px wide, then hand the model the file. Do not build a framework.
6. **Disconnected test.** A script that runs with no network and proves the
   request path never reaches a hosted provider. Not written.

## Traps already found, do not rediscover

- `curl` with JSON containing model output breaks on control characters. Use
  `scripts/probe-local-model.py`.
- `qlmanage` renders SVG to a **square** thumbnail, silently cropping a tall
  fixture and removing the faults being tested. The fixture script now renders
  tall then resizes with `sips`.
- `DEFAULT_SETTINGS.offline` must exist, or the block reads as absent rather
  than off.
- `validateSettings` expects merged config. Passing a fragment produces dozens of
  unrelated warnings about absent sibling blocks; that is pre-existing behavior,
  not a regression.
- The router's `preview` RPC ignores a caller-supplied `contextTokens` and reads
  it from the ledger session instead, so it cannot be used to probe the context
  gate. Test the engine directly.
- `replyMarginFor` must be used by both `eligibility.ts` and `strategy.ts` or the
  two gates drift. A structural test asserts the literals are gone.

## Rollback

Nothing in this work changes online behavior unless `offline.enabled` is true,
and it defaults to false. To abandon entirely:

```bash
cd ~/Documents/opencode-smart-router
git checkout feature/pro-plan-migration   # the branch before this work
```

The deployed plugin artifact is unchanged by this work. If offline mode was
enabled in `~/.config/opencode/smart-router.json`, set
`offline.enabled` to `false` and restart the backend:

```bash
kill "$(lsof -nP -iTCP:49374 -sTCP:LISTEN -t | head -1)"
```

To remove the local model and server (only if desired):

```bash
ollama rm qwen3.5:4b-q4_K_M
brew uninstall ollama
```

## Honest status summary

The routing half is done and tested. The model is installed and its capabilities
are verified with real measurements. The parts a user would actually touch, the
commands and the screenshot loop, do not exist yet. No benchmark exists. Vision
quality is unresolved and the fixture, not the model, needs fixing first.
