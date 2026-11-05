# Screenshot persona

The screenshots under `assets/screenshots/` are renders of the real panel UI
(hand-built as HTML in this directory from the panel's own design tokens, then
captured at 2× with headless Chrome) filled with a **fictional usage profile**.
No real account, session or ledger data is shown.

## The fictional user

An independent product engineer on **OpenDesign Pro**, with Command Code Pro
also configured and OpenCode Go discovered but left off. They use OpenCode
daily for a long-running TypeScript refactor.

## The mock session

`router-panel.png`, `router-decision.png` and `router-allowances.png` place the
panel inside a mock OpenCode app frame (`.appframe` / `.appbody` in
`styles.css`) so the shots read as the product in use, not a floating panel:

- **Chat pane:** a session titled *checkout-validation refactor*. The user asks
  to fix plus-address email validation; the assistant reply (styled as the
  routed model, `opendesign/glm-5.3-flash`) answers with a small code diff.
- **Composer chip** matches the panel's current model, so chat and panel agree
  on the same task, model and numbers. One message per shot: the panel shot
  shows state, the decision shot zooms the reasoning card, the allowances shot
  zooms the budget rows.
- **Onboarding** (`router-onboarding.png`) keeps the app frame but shows the
  draft setup state on the left and the payoff ("Recorded.") on the right.
- All data in the chat and panel is invented; no real conversation is depicted.

## The dataset, and where each number comes from

Every figure is calibrated against the plan catalog (`src/core/plans/catalog.ts`)
and the panel's own formatting rules (`src/gui/viewmodel.ts`), so the shots
read exactly as the app would render them:

| Figure | Value | Basis |
|---|---|---|
| Plan pools | $360 + $120 of $480 | OpenDesign Pro published caps exactly ($100/mo) |
| 7-day window | ≥53% of $90, resets in 3d | Pro's $90 weekly cap; `≥` because the estimate is a lower bound |
| Monthly window | ≥15%, resets in 21d | $52.99 of $360 used |
| Plan model credits | $108.40 of $120.00 | Separate pool, never summed with Design Plan |
| Routing winner | `opendesign/glm-5.3-flash`, $0.0005 est. | $0.075/1M credits × 0.5× multiplier — the real published price |
| Runner-up | `claude-haiku-5-5` at +$0.0001 switch cost | The effective-cost ranking including switch penalty |
| Blocked | `gpt-6.1-sol` (unapproved), `gpt-6-luna` (below floor) | Real eligibility rules |
| History | 1,284 requests | Plausible for weeks of daily use |

## Disclaimer

The figures are illustrative, not a benchmark. The chips, windows, reasons and
the `≥` lower-bound prefix are all rendered by the real product logic
reproduced in markup; the amounts behind them are invented.
