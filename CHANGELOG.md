# Changelog

Notable changes to OpenCode Smart Router. Dates are the day the change landed on
`main`.

## Unreleased

### Added

- **Self-healing routing.** The router repairs prompts a strict provider would
  reject (mid-session system notices on the Anthropic protocol), refuses to
  retry a deterministic request rejection, and fails a rejected turn over to
  the next best eligible model, continuing it with one router-marked notice.
  The panel's last decision records what was rejected and what took over.
  Discovered on a live Command Code session where a rebuilt prompt reached
  the Anthropic path with a system role inside `messages[]` and died with
  "Invalid discriminator value. Expected 'user' | 'assistant'".

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
