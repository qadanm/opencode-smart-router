# Changelog

Notable changes to OpenCode Smart Router. Dates are the day the change landed on
`main`.

## Unreleased

### Added

- **Launch kit** (`docs/LAUNCH-KIT.md`): paste-ready copy for Discord, Hacker
  News, X, and the opencode.cafe submission, plus the demo film assets.

## 0.6.0 — 2026-11-06

Tier-3 work escalates by itself, paid from the plan-model pool.

### Added

- **Automatic flagship escalation** (`premium.mode: "auto"`, now the default):
  a tier-3 task routes to the plan-model pool (Claude Sonnet 5.5, GPT-6.1 Sol)
  without a per-task approval prompt while the pool has budget. When the pool
  is spent, escalation degrades to an approval gate and the router serves the
  task with the strongest ordinary model - a routing refusal never fails a
  serviceable task. Tier-1 and tier-2 work always stays on the ordinary pool.
- **Plan-model pool ledger**: monthly buckets tracking spend against the
  OpenDesign plan-model allowance (Pro: $120/month), persisted across
  restarts, separate from Design Plan credits and from other providers'
  premium spend. The cap is read from the resolved plan catalog.
- **Per-kind capability evidence**: `ModelRecord.capabilities` (coding,
  debugging, agentic, architecture) from named benchmarks with provenance,
  moving expected success by at most 4 points - enough to break a close
  ranking, never enough to overrule a gate. Unscored models stay neutral:
  absent evidence is unknown, not zero.
- **Context probes** (`scripts/probe-plan-model-context.py`): end-to-end
  800K-token verification with memorization sentinels and truncation checks.

### Changed

- GPT-6.1 Sol is scored (intelligence 55, Artificial Analysis v5.0.1) and
  auto-approved for tier-3 escalation along with Sonnet 5.5, both by owner
  instruction 2026-11-06. DeepSeek's observed 39.5 is untouched.
- Catalog context windows raised from measured (328K/400K) to probed-verified
  800K for both flagships after passed end-to-end probes on 2026-11-06; the
  advertised 1M is deliberately NOT claimed, and Sol's long-context surcharge
  above 272K was confirmed by the billed amounts.
- MiniMax M3.1 Flash is classified as a Design Plan model. The gateway serves
  it both inside and outside the Design Plan group and OpenDesign has not
  published which applies, so the conservative choice is made: treating an
  ordinary tier-2 workhorse as a plan model keeps routine work from draining
  the escalation pool. Before this, a tier-3 task could land on it as a
  premium model that a tier-2 flag itself made eligible.

### Fixed

- A partial settings file no longer produces a warning for every key it leaves
  out. Absent and invalid are now distinct: a key you did not write takes its
  default silently, while a key you did write with the wrong type still reports
  the problem. Before this, a config that only set `providers.opendesign.plan`
  emitted around fifty warnings and hid the ones that mattered.

## 0.5.0 — 2026-11-06

The router stops taking things that are not its to take.

### Changed

- **The router no longer renames sessions.** The `AUTO · OD · model — name`
  title prefix is gone, for new chats and for every chat going forward. A chat
  title is the owner's name for the work; status belongs in the panel, the
  terminal footer and the decision record. The `ui.titleIndicator` setting is
  removed and ignored if present.
- `/router-title off` now strips prefixes this plugin wrote in earlier versions
  and reports how many titles it cleaned. Titles that lost their separator are
  left alone rather than rewritten.
- Existing installs were repaired in place: every prefixed title was restored
  from its separator, or from the session's own first user message when the
  separator was already gone.

### Added

- Earlier review pass carried in this release: self-heal floor fallback, real
  safety-margin enforcement, task-scoped rejection memory, strict failure joins,
  request-clock threading, and metric-neutral decision notes.

### Removed

- **Sidebar project grouping (never released on npm).** The desktop app ships
  this natively behind Settings -> Experimental -> Organize vertical sidebar ->
  Projects (upstream commit `2bb4988`, after the installed v2.2.5). A plugin
  copy would duplicate app code and fight the native version. The reasoning and
  the prior-art notes are in `docs/SIDEBAR-GROUPING-TABLED.md`.

## 0.4.0 — 2026-11-05

Self-healing routing, and npm distribution.

### Added

- **Self-healing routing.** A rebuilt session can carry mid-session notices
  into the prompt as system roles, which kills the turn on any
  Anthropic-protocol model with a 400 error. The router folds those notices
  into user messages before the request leaves, refuses the host retry on a
  deterministic rejection, and continues the turn on the next best eligible
  model with one notice. The panel records what was rejected and what took
  over. Found on a live Command Code session: the error was
  "Invalid discriminator value. Expected 'user' | 'assistant' at
  messages.23.role".
- **npm package** (`@qadanm/opencode-smart-router`). One self-contained file
  with no runtime dependencies, loadable with a single `plugin` entry so the
  router appears in OpenCode's own ecosystem path. The full experience stays
  with the installer.

## 0.3.0 — 2026-11-05

The release where the router gained a face, and where several numbers it had been
asserting turned out to be wrong.

### Added

- **Desktop panel** (`./gui-experimental`). A side panel in OpenCode Desktop that
  shows the last routing decision, why the chosen model won, every candidate that
  lost with the reason, per-provider allowances with all their windows, and the
  provider list. Built on the OpenCode GUI plugin API, which the SDK marks
  experimental.
- **First-run onboarding.** Reports the providers found on this machine, what was
  imported from history, and what the router will do — before asking for anything.
  Evidence rather than a questionnaire, because detection already did the finding.
- **Terminal parity** (`./tui`). `/router-why` and `/router-quota`, plus a footer
  status slot. Same view-model as the panel, so the two cannot disagree.
- **Calibration.** The safety margin is now measured from the charges the provider
  reported rather than assumed. Narrows with evidence; stays wide and warns when
  the charges imply a wrong price.
- **History import from OpenCode's own database.** Per-message, so each event
  carries its real timestamp and the model that actually served it. This is what
  makes a fixed seven-day window accurate instead of smeared onto session
  boundaries.
- **Per-session automatic-routing switch.** Stops the router changing the model
  without disabling it. `SessionState.paused` existed but nothing read it, so this
  also fixed a switch that would have silently done nothing.
- **Account reading by paste.** OpenDesign exposes no usage API, so the estimate
  can only see traffic the router routed. Pasting the Plan & balance page seeds
  the real figure. Reconciled against the catalog, which reports disagreement
  rather than absorbing it.

### Fixed

- **Thirteen OpenDesign models were priced wrong**, some by 4x in both directions.
  The catalog stored a base price and then applied the Design Plan multiplier on
  top, and several entries already had the multiplier baked in. Verified against
  the published CoRouter catalog and pinned by 36 assertions.
- **The Plus tier had no weekly cap**, making it look able to spend a whole month
  in one week.
- **The seven-day window was modelled as rolling** when the vendor documents it as
  fixed from the subscription start, and the estimator ignored the declaration
  entirely even after the catalog was corrected.
- **The reported cost was discarded.** Every step carries the real charge, and the
  estimator recomputed an approximation of it from a static table instead.
- **Command Code's DeepSeek V4.1 Flash sent a model id the gateway rejects**, which
  surfaced as "The provider rejected this request" on manual selection.
- **Session titles were rewritten, and could be destroyed.** `titleIndicator`
  defaulted to true and compact mode returned the prefix alone, losing the name
  irrecoverably. It now defaults to false and never derives a name from its own
  previous output.
- **Every provider was enabled by default** regardless of whether the machine had
  an account, so a new install produced authentication failures for providers the
  user never claimed. Enablement now follows discovered credentials, and an
  explicit configuration always wins.
- **A spent allowance was not recognised.** There was no `quota_exhausted` failure
  class, so a 402 was retried and never marked the provider spent. It now stops
  the turn and holds the provider back until its window resets.
- **`DEPLOYMENT.json` could not be trusted.** It recorded the commit but not that
  the tree was dirty, so three installs were attributed to the wrong revision. It
  now records the diff hash, the changed file count and the GUI bundle hash.

### Changed

- **`ui.titleIndicator` now defaults to `false`.** The router no longer edits chat
  names. Anyone who wants the indicator back can set it, and turning it off again
  restores any prefix a previous version added.
- **Provider enablement is credential-aware.** A provider the user never mentioned
  is enabled only when a credential or connection exists for it.
- Prices, ceilings and multipliers are now checked against vendor documentation by
  tests, so they cannot drift silently.

### Known limitations

- OpenDesign has no usage API for an inference key, and the account-control
  endpoints require a credential the product does not issue. `nexu-io/open-design`
  issue #8674 requests one and remains open. The estimate plus a pasted reading is
  the best available figure.
- The GUI plugin API is marked experimental by the SDK and may change between
  OpenCode releases.

## 0.2.0 — prior to this changelog

Subscription-aware routing across OpenCode Go, Command Code GOAT and OpenDesign,
with nested usage windows, multi-pool credit accounting and context policy. See
`docs/ARCHITECTURE.md`.
