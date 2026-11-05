# Smart Router GUI — design and delivery plan

Status: proposed. Not approved, not started.

## 1. Intent

The router makes a routing decision on every prompt and explains nothing where
a user can see it. Today that explanation exists only as terminal text from
`/router-status`, `/router-explain`, `/router-report`. The decision data behind
it — every candidate, its cost, its success probability, the exact reason each
one lost — is already computed and thrown away after a few hundred bytes of
text.

This plan puts that data in front of the user, in OpenCode Desktop, as a
first-class panel. The goal is not "a settings screen". The goal is: **at any
moment, a user can see what the router is doing, on what evidence, and why it
chose this model over the next-best one.**

### Why now

OpenCode Desktop 2.2.x ships a GUI plugin API (`@opencode/plugin/gui`): Solid
components, side panels, settings pages, commands, slots, persistent stores and
typed IPC into the Electron main process. The router already exposes 21 RPC
methods and 3 events. The data model is sufficient; only the surface is
missing.

### Success

- A user can answer "why this model?" in under 5 seconds without reading docs.
- A user can see which providers are configured, what each has left, and what
  happens when one runs out.
- A new user is asked which providers they have, once, instead of inheriting
  the author's defaults.
- Nothing shown is a guess presented as fact.

### Anti-goals

- Not a chat client. The conversation stays OpenCode's.
- Not a marketing surface. No dashboard decoration without a decision behind it.
- Not a place to hide failures. A provider that is down is shown as down.
- Not desktop-only by design. Every capability must have a terminal equivalent
  or an honest "desktop only" label.

## 2. What already exists (verified)

| Thing | State |
|---|---|
| `@opencode/plugin` | **2.1.4** pinned — no `./gui` export |
| `@opencode/plugin` latest | **2.2.5** — has `./gui`, `./gui/main`, `./gui/vite` |
| Installed desktop app | **2.2.5** — runtime supports GUI |
| RPC methods | 21 (`status`, `preview`, `report`, `usage`, `floor`, `diagnostics`, …) |
| RPC events | `decision`, `status`, `quota` |
| Per-candidate data | `CandidateEvaluation`: eligible, reason, estimatedUsd, effectiveCost, successProbability, switchPenaltyUsd, quotaPressure, credit/speed/marginal multipliers |
| Per-decision data | `RoutingDecision`: task class, chosen, reasons[], warnings[], candidates[], premium, quota, context tokens |
| Provider state | `ProviderQuotaSnapshot` per provider; monthly/weekly/rolling windows, `source: provider \| estimate \| unknown`, errors |

The "why" is not something the GUI has to invent. It is `candidates[].reason`
and `decision.reasons[]`, already written by the routing engine.

## 3. Approaches considered

**A. Server-only + richer slash commands.**
Cheapest. Zero new dependency. But it is the thing that already failed to
answer the question — text is the wrong medium for a ranked comparison of 40
candidates.

**B. TUI plugin only.**
Terminal users get parity, but the desktop app is where this user lives and
where panels, tabs and real layout exist. Also `cli.json` and `opencode.json`
are separate, so it is a second install surface.

**C. GUI plugin in the desktop app, TUI deferred.**
Uses the API built for this. Panel, settings page, command palette, slots.
Highest ceiling; the API is experimental, which is a real risk.

**D. GUI + TUI from one core.**
Share the view-model, render twice. Most work, but it is the only option that
satisfies "keep the terminal people in mind" without a second-class experience.

**Chosen: D, delivered as C first.** Build the shared view-model, ship the GUI,
then add the TUI renderer against the same model. The view-model is pure
functions over `RouterStatus` / `RoutingDecision`, so it is testable without a
renderer at all — which is what makes the TUI step cheap later.

## 4. The interface

Five surfaces, in priority order. Each is independently shippable.

### 4.1 Decision Inspector (the core)

A side panel showing the most recent decision:

```
┌ Decision ──────────────────────────── 2s ago ─┐
│ Prompt classified:  code · tier 2 · 8.2k ctx  │
│                                                │
│  ✓ Chosen   opendesign/deepseek-v4.1-flash     │
│             $0.0042 · 87% success · tier 2     │
│                                                │
│  Why it won                                   │
│   • cheapest above the 39.5 intelligence floor │
│   • same provider as current (no switch cost)  │
│   • 62% of monthly allowance remaining         │
│                                                │
│  9 considered · 3 eligible · 6 blocked  [ ▸ ]  │
└────────────────────────────────────────────────┘
```

Expanded, every candidate is a row:

| Model | Verdict | Est. | Effective | Success | Why |
|---|---|---|---|---|---|
| `opendesign/deepseek-v4.1-flash` | **chosen** | $0.0042 | $0.0042 | 87% | cheapest eligible |
| `commandcode/deepseek/deepseek-v4.1-flash` | eligible | $0.0051 | $0.0051 | 84% | +$0.0009, no gain |
| `opencode-go/gpt-6-luna` | blocked | — | — | — | weekly allowance 94% used |

That "blocked, and here is the sentence" column is the feature. It is also the
answer to the bug found on 2026-11-04: a model that 400s should never have been
`eligible` in the first place, and a user should be able to see that it was.

### 4.2 Live status

Header strip, always visible via a `sidebar` or `prompt.footer` slot:

`AUTO · balanced · opendesign/deepseek-v4.1-flash · floor 39.5 · 62% left`

Colour is never the only signal (accessibility). State is also a word.

### 4.3 Providers

Per provider: enabled, plan, credential source, each window as a bar with
`provider` / `estimate` / `unknown` labelled explicitly. An estimated number
says "estimated". An unknown says "not probed", not "0%".

This is where the 2026-11-04 confusion lives: OpenDesign disabled by default is
correct, but it was invisible.

### 4.4 First-run setup: find, don't ask

The thing that replaces hardcoded defaults. A blank questionnaire is a last
resort; the machine already knows most of the answer.

**The principle: show evidence, not a form.**

A new user should never be asked "which providers do you have?" when we can
look. The panel opens with what was found, where it was found, and a checkbox:

```
We looked on this machine. Here is what we found.

  ┌ Detected ────────────────────────────────────────────────┐
  │ ✓ OpenCode Go       connected via OpenCode               │
  │                     used 41 times, last 2 days ago       │
  │                                                           │
  │ ✓ Command Code      key at ~/.config/opencode/code.key    │
  │                     used 6 times                          │
  │                                                           │
  │ ✓ OpenDesign        "OpenDesign Go" in OpenCode's         │
  │                     credential store                      │
  │                                                           │
  │ ○ Ollama            running at localhost:11434            │
  │                     local models only, never auto-routed  │
  └───────────────────────────────────────────────────────────┘

  ◻ Show 3 providers we found no evidence for   ▸

  [ Enable 4 providers ]        [ Review config before saving ]
```

The distinction that makes this honest: **a credential is not the same as
usage.** "We found a key" and "you have used this" are different evidence, shown
differently, and the user can act on either. A provider with usage history and
no key is still worth surfacing — it tells the user what they were doing before
and why the router cannot currently reach it.

#### Sources, in order of confidence

| Evidence | Source | Confidence |
|---|---|---|
| Provider credential | `~/.config/opencode/opencode.json` → `providers.<id>.settings.apiKey` (inline, `{file:…}`, `{env:…}`) | strong |
| Provider credential | `~/.config/opencode/*.key`, `*.env` | strong |
| Provider credential | `~/.commandcode/auth.json` | strong |
| Integration credential | session DB `credential` table — read `label`, `integration_id`, `active` only | strong |
| Provider credential | process env and exported shell-profile keys | strong |
| Usage history | session DB `message.data` → `providerID`, `modelID`, counts, last-seen | medium |
| Spend history | session DB `session.cost`, `tokens_*` | medium |
| Installed locally | `GET localhost:11434/api/tags` (Ollama) | strong |
| Configured elsewhere | project `.opencode/opencode.json`; other OpenCode installs | medium |

#### Rules that make this trustworthy

1. **Secrets never leave the machine and are never displayed.** A credential is
   reported as *where it was found* and *that it exists*. Never the value, not
   even a suffix. The write step references the existing location rather than
   copying the secret into a new file.
2. **Scanning is scoped and disclosed before it happens.** Step one reads only
   this OpenCode install's config. Reading the session database, shell profiles
   or other applications' configs is a separate, explicit action with a one-line
   explanation of what will be read and that nothing is uploaded.
3. **Every row is reversible.** Enabling writes one boolean per provider; the
   panel shows the exact JSON diff before it is applied.
4. **No credential is invented.** If nothing is found, the panel says so plainly
   and links to where each key would go. It does not guess.
5. **Usage history is advisory.** It orders the list and explains the past; it
   never enables a provider the user did not confirm.
6. **Idempotent.** Re-runnable from Settings at any time; a second run shows the
   current state rather than re-onboarding.

#### Where the work lives

Discovery is **server-side**, because it needs filesystem and SQLite access, and
because the TUI must be able to do the same thing. It is a new RPC method,
`discoverProviders`, returning evidence rows — the first genuinely new method in
this plan, and justified by that.

The GUI renders it; the TUI renders the same rows through `ui.dialog.select`.
Neither renderer knows how discovery works, which is what keeps them in step.

### 4.5 Settings

Mode, floors, reserves, premium budget, approved/excluded models. Every control
shows the value in force and the default it overrides, so it is obvious what
this machine changed versus what the project ships.

### 4.6 Session titles: stop hijacking them

Found on 2026-11-04. `DEFAULT_SETTINGS.ui.titleIndicator` is `true`, and
`applyTitleNow` rewrites every session title to:

```
AUTO · OD · DeepSeek V4.1 Flash — <user's chat name>
```

The chat name is recovered by `stripTitlePrefix()`, which requires an em-dash
separator to find it. The regex returns `""` when the shape does not match:

```ts
const match = /^(AUTO|MANUAL|PAUSED|DRY RUN|BLOCKED) · [^—]*(?: — ([\s\S]*))?$/.exec(title)
return (match[2] ?? "").trim()
```

Three paths lose the name outright:

1. `compact` mode returns the bare prefix before the base is ever appended.
2. A `BLOCKED` rewrite can drop the base if `session.baseTitle` is empty.
3. The fallback `session.baseTitle || stripTitlePrefix(currentTitle) || session.title`
   reads `session.title` — which is **already the prefixed string**. Once the
   base is lost it is never recovered; the prefix becomes the name.

**Decision: the title is not a status channel.**

- Default `ui.titleIndicator` to `false`. A plugin that renames a stranger's
  chats on install is a bug, not a feature.
- The GUI status strip (§4.2) and footer slot take over the job properly.
- For anyone who still wants it, the indicator becomes strictly additive: the
  base title is stored separately on first sight, never re-derived from the
  visible title, and removal restores it exactly. `restoreTitles()` already
  exists and is the right shape for this.
- Add a regression test: rename a session five times with a model switch
  between each, and assert the base survives every round trip.

This is a behaviour change for existing users. It belongs in the changelog, and
the release note should say plainly that the router no longer edits chat names.

## 5. Design standards (the "large team" part)

Not decoration. These are the things that distinguish a product from a demo:

- **Tokens first.** One source of truth for colour, type scale, spacing
  (4px grid), radius, elevation, motion duration. Semantic names
  (`text.secondary`, `surface.raised`), never raw hex in components.
- **Honest states.** Every data surface implements loading, empty, error,
  partial and stale. "No quota data" is a distinct state from "0%".
- **Density with hierarchy.** Tabular numerals for all money and percentages.
  Right-aligned numerics. One primary action per view.
- **Accessibility.** WCAG 2.2 AA: 4.5:1 text, 3:1 UI, visible focus, full
  keyboard operation, `prefers-reduced-motion` respected, no colour-only meaning.
- **i18n from day one.** `ctx.t()` keys, no string literals in components.
  English only at first, but the plumbing is not retrofitted later.
- **Copy discipline.** Sentence case, no exclamation marks, no "Oops". Errors
  say what happened, what it means, and what to do.
- **Performance.** Panel opens under 100ms; no layout shift; expensive work in
  `createKeyed`, not module scope.
- **Documentation.** Every panel has a one-paragraph "what this is" in the repo,
  written for a stranger.

## 6. Constraints and risks

| Risk | Impact | Mitigation |
|---|---|---|
| GUI API is experimental | Breaking changes on upgrade | Pin `@opencode/plugin`; isolate every GUI call behind one adapter module; TUI path shares the view-model |
| SDK bump 2.1.4 → 2.2.5 | Server plugin API may have changed | Bump on a branch, run the 491-test suite, verify the installed bundle loads before merging |
| Panel needs server data | RPC payload is `additionalProperties: true` — untyped | Define Effect schemas; validate at the boundary; never trust shape |
| Only one plugin id namespace | id collision with app plugins | Use the existing `opencode-smart-router` id; GUI inherits it |
| Build adds Vite/Solid | Bundle must be one CJS file | Use the official `gui()` Vite preset; add to CI |
| Desktop-only reach | Terminal users excluded | View-model shared; TUI renderer is phase 5, not a rewrite |

## 7. Phases

Each phase ends with a shippable, tested state.

**P0 — Spike (½ day).** Bump SDK to 2.2.5 on a branch. Add a `./gui-experimental`
entry rendering one panel that prints `ctx.app.version` and a live decision
count. Confirms: desktop loads it, reload works, no id collision. If this
fails, the whole plan stops here — that is what a spike is for.

**P0b — Title fix (½ day, independent of the GUI).** Ship §4.6 on its own:
`titleIndicator` defaults to `false`, base titles are stored once and never
re-derived, plus the five-rename regression test. This does not need the GUI
and should not wait for it.

**P0c — Credential-aware provider defaults (1 day, independent of the GUI).**
Ship §9.1's default: a provider is enabled when a usable credential was found,
and not otherwise. Removes the "enabled but throwing auth errors" class of bug
and makes setup unnecessary for most users. Needs care — it changes behaviour
for existing installs, so it ships with a one-time notice and a documented
override in `smart-router.json` (`providers.<id>.enabled: true` must always win
over detection).

**P1 — View-model (1 day).** Pure functions mapping `RouterStatus` and
`RoutingDecision` to display structs: decision summary, candidate table rows,
provider cards, status strip. Unit tested against fixtures. No renderer.

**P2 — Decision Inspector + status strip (2 days).** The panel from §4.1 and
the footer slot from §4.2, wired to `ctx.client.rpc()` and the `decision` /
`status` events. Read-only.

**P3 — Providers + Models (1–2 days).** §4.3, plus the approved/excluded model
list with intelligence/design/tier and the reason each is in or out.

**P4 — First-run setup: discovery + confirmation (2–3 days).** §4.4. Server-side
`discoverProviders` RPC (config, key files, env, session DB, Ollama probe), the
GUI checklist with evidence rows, and the scoped opt-in for the deeper scan. This
is the phase that retires the "author's providers" assumption.

**P5 — Mutations + Settings (2 days).** §4.5. Mode, floors, reserves, premium,
pause/dry-run, pin/unpin — through existing RPC methods, with optimistic UI and
rollback on failure.

**P6 — TUI parity (2 days).** `./tui` entry: status slot, a decision dialog via
`ui.dialog.select`, and the setup wizard via the same view-model.

**P7 — Hardening (1–2 days).** Empty/error/stale states everywhere, a11y pass,
keyboard-only walkthrough, reduced-motion, i18n sweep, docs, CI build check.

Rough total: **11–14 working days.** P0–P2 is the useful minimum and lands in
about 3.5 days.

## 8. Decisions I am making (correctable)

1. **Read-only before writable.** Showing truth is worth more than editing it,
   and it cannot corrupt a user's routing.
2. **The decision panel is the product.** Everything else is supporting cast.
3. **No new server RPC surface unless a phase needs it.** The 21 methods cover
   most of this; adding `getConfig`-adjacent methods is a last resort.
4. **English-only strings, fully keyed.** i18n plumbing without translation.
5. **No telemetry.** A router that explains itself does not need to phone home.
6. **The session title is the user's.** Status belongs in the GUI and the TUI
   status slot. The title indicator is opt-in and reversible, never destructive.

## 9. Decisions taken (maintainer)

These were open questions. They are now settled, with the reasoning recorded so
a future contributor can challenge the decision rather than guess at it.

### 9.1 First-run setup: polite, non-modal, and usually unnecessary

**Decision: a dismissible banner in the status strip. Never a modal on first
load.**

A modal on first launch is the single most common way a plugin loses a user in
the first thirty seconds: it blocks the thing they installed the product to do,
it cannot be scripted past, and it interrupts before the user has any reason to
trust us. Auto-opening is what a team does when it has not thought about the
person on the other end.

A banner alone is not enough either, because a banner that can be ignored
forever leaves a user running on defaults that may not match their accounts.
The fix is not a louder prompt, it is a better default.

**The default becomes credential-aware.** On load, the router detects which
providers have usable credentials and enables exactly those. A user who has one
provider gets one provider, correctly, with nothing to answer. This removes the
need for setup in the majority case, and it fixes the underlying defect that
prompted this work: `commandcode` enabled with no key, producing an auth error
for an account the user never claimed.

The banner appears only when it has something to say:

| Condition | Banner |
|---|---|
| Credentials found for exactly the enabled providers | none |
| Credentials found for a provider that is off | "OpenDesign credentials found — enable it?" |
| No credentials found at all | "No provider credentials found — see setup" |

Dismissal is permanent per condition, stored in `ctx.stores`, and re-armed when
the condition changes. Setup is always reachable from the Settings page and from
the command palette, so dismissing is never a dead end.

### 9.2 The GUI writes `smart-router.json` — through one narrow gate

**Decision: yes, and the file remains the source of truth.**

A read-only GUI is a half-product: it tells a user their floor is wrong and then
makes them hand-edit JSON. That is not a control panel, it is a report.

But two writers to one file is how config systems rot. So the GUI never writes
directly. All mutation goes through a single `ConfigWriter` with these
properties, which are the actual design:

1. **User-initiated only.** The GUI writes on an explicit action. It never
   writes during load, detection, probing or migration.
2. **Minimal diff.** Only the keys the action touches are changed. Every other
   key, including ones this version does not know about, is preserved verbatim.
3. **Validated before write.** Through the same `validateSettings` the loader
   uses, so the GUI cannot produce a file the loader would reject or silently
   repair.
4. **Atomic.** Write to a temp file in the same directory, `fsync`, `rename`.
   A crash mid-write leaves the previous config intact.
5. **Backed up.** One timestamped `.bak` per write, rotating the last five.
6. **Conflict-aware.** A filesystem watch re-reads the file on change. If it
   changed underneath the GUI since it was read, the GUI reloads and shows
   "configuration changed on disk" instead of overwriting. Last writer does not
   silently win.

Known cost, stated plainly: writing JSON normalises formatting and drops
comments, because the format is JSON and not JSONC. The writer emits stable key
ordering so diffs stay readable, and this is documented. Users who hand-maintain
the file can set `ui.readOnlyConfig` to keep the GUI from ever writing.

Migration story: none is needed for the file format, because the shape does not
change. What changes is that a write now has an owner, a backup and a validation
step — strictly less risk than a human editing it in `vim`.

### 9.3 Unconfigured providers: shown, but not in the way

**Decision: shown in a collapsed "Not configured" group on the Providers page.
Never in the routing list. Never in the model picker.**
Hiding them entirely is the tempting option and it is wrong: a user who has an
OpenDesign subscription and cannot see that this router supports OpenDesign will
never find out, and support tickets are the cost. A router that silently
supports fewer providers than it does is lying by omission.

Equally, putting them in the main list is wrong: a provider that cannot be
selected is noise in the place where a user makes decisions.

So the Providers page has two sections:

- **Active** — configured providers, with their windows and quota.
- **Not configured (n)** — collapsed by default, one line each: what the
  provider is, what the router would use it for, and a single **Set up** action.
  Expanding shows where we looked for credentials and what we found, because
  "not configured" without that is a dead end.

The routing list and the model picker show only models that can actually be
chosen right now. A model the router will not route to does not appear as a
choice, and the Decision Inspector explains why it was excluded.

