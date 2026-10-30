# 05 — Architecture options

## Option A — Repair our plugin

Keep the routing engine, policy, ledger, classifier, and quota adapters. Finish the shared-core/per-location-bridge split, remove the remaining lifecycle assumptions, and harden fail-closed behavior.

**Pros**

- The only option that already satisfies the full requirement set.
- Behaviour can be preserved exactly: AUTO/MANUAL/PAUSED/DRY RUN titles, commands, RPC, quota policy, premium approval, cache affinity.
- Incremental: every phase can be tested against the existing 77-test suite.
- No new license or dependency.

**Cons**

- We own the lifecycle complexity, including the v2 SDK edge cases that caused the incident.
- The current code is large (7,204 source lines) and the docs drift.
- There is no external community to share maintenance.

**Compatibility:** proven on OpenCode 2.1.4.
**Relative effort:** medium.
**Requirements lost:** none, if the fail-open and lifecycle gaps are fixed.

## Option B — Fork and extend an existing router

The only serious fork candidate is marco. It has the strongest lifecycle engineering and test suite. Extending it would mean adding Go/Command Code quota accounting, a deterministic per-prompt selector, intelligence/vision/design floors, premium approval, and cache-aware pricing.

**Pros**

- Mature lifecycle machinery, 342 test files, CI, active maintenance.
- Existing subagent delegation, escalation, and enforcement.

**Cons**

- GPL-3.0-only would force the combined work under GPL. That is a product decision, not a technical detail.
- About 120,000 source lines and a second product's concepts (executor, guard, leases, TUI).
- The architecture is instruction/delegation-first; adding deterministic root-model switching would fight it.
- No quota model; no OpenCode Go or Command Code endpoints.
- Upstream churn: 142 stars, 15 open issues, frequent releases. A fork would diverge quickly.

**Compatibility:** v1 + v2 adapter; strong.
**Relative effort:** high (likely 2–3× the repair).
**Requirements lost:** none only after substantial new code; otherwise 2, 4–11.

Sberdia is a smaller fork candidate, but it is v1-only and lacks most functional requirements; forking it converges on Option C with less proven lifecycle code.

## Option C — Minimal hybrid

Build a smaller plugin that keeps our routing/policy core but adopts proven external patterns:

- shared-core + thin bridge lifecycle (ours, simplified);
- quota adapter semantics and tests from usage-limits;
- per-model cooldown/allowance health from sberdia;
- explicit ownership and dispose barriers (concept from marco);
- no delegation protocol, no web UI, no TUI dependency.

This is effectively Option A with a stricter scope: delete anything that is not required for correctness, and borrow only patterns that reduce risk.

**Pros**

- Preserves the requirement set while reducing surface.
- Reuses verified endpoint and edge-case knowledge without new dependencies.
- Can be delivered in small phases with rollback.

**Cons**

- Still our code and our maintenance.
- Requires discipline to actually delete code rather than add more.
- The “hybrid” label can hide scope creep; the roadmap must enforce boundaries.

**Compatibility:** v2 / 2.1.4.
**Relative effort:** medium (similar to A, slightly higher upfront design).
**Requirements lost:** none.

## Option D — Adopt an existing solution with minimal configuration

Pick sberdia (Go quota failover) or marco (delegation), install, and configure.

**Pros**

- Fastest to try; no new code.
- MIT for sberdia; active for marco.

**Cons**

- Sberdia does not load on the v2 host without a port; it is Go-only; it does not implement requirements 1–8, 10–11, 13, 15.
- Marco changes the operating model (delegation), adds 3–6 K characters per message, has no Go/CC quota, and is GPL.
- Neither protects premium spend or enforces vision/design/intelligence floors.
- Neither offers fail-closed admission.

**Compatibility:** sberdia no (v1); marco yes (v2 adapter).
**Relative effort:** very low to install, very high to reach parity.
**Requirements lost:** most of the differentiators.

This option is reasonable only as a temporary, explicitly reduced-scope experiment, not as the final router.

## Option E — Fourth option: config-only / CLI router (no prompt hook)

Generate per-agent model assignments and a periodic quota refresh in a CLI, writing `opencode.json`; no server plugin, no prompt interception.

**Pros**

- Very stable: no hooks, no event stream, no in-process lifecycle.
- Easy to disable (remove the config entry).
- Can reuse sberdia's approach and tests.

**Cons**

- Cannot route per prompt; only per agent.
- Cannot enforce intelligence/vision/design requirements for a specific task.
- Cannot fail closed at admission.
- Quota changes require a config rewrite and a reload.
- Does not satisfy requirements 1–8 or 15.

**Compatibility:** high.
**Relative effort:** low–medium.
**Requirements lost:** the core value proposition.

This is a plausible fallback if the v2 hook API proves unstable beyond repair, but it is not the recommended design.

## Weighted scorecard

Weights: stability 30%, functional fit 20%, quota 15%, simplicity 15%, performance 10%, security/SDK 10%.

Scores are 0–10 architecture judgments. Evidence labels: **S** source inspection, **X** executed, **D** documented, **I** inferred.

| Option | Stability | Fit | Quota | Simplicity | Performance | Security/SDK | Weighted | Evidence |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A. Repair ours | 6.0 | 9.0 | 9.0 | 5.0 | 7.0 | 7.5 | **7.2** | S/X/D/I |
| B. Fork marco | 8.5 | 4.0 | 1.0 | 2.0 | 4.0 | 7.0 | **4.9** | S/D/I |
| C. Minimal hybrid | 8.0 | 9.0 | 9.0 | 7.0 | 8.0 | 8.5 | **8.2** | S/X/I |
| D. Adopt sberdia as-is | 4.0 | 4.5 | 5.0 | 8.5 | 8.0 | 4.0 | **5.3** | S/X/D |
| E. Config-only | 9.0 | 3.0 | 5.0 | 9.0 | 9.0 | 9.0 | **6.8** | S/I |

These are the same candidate-level scores used in `01-EXECUTIVE-FINDINGS.md`. A fork that adds our routers and quota policy would carry that new code's risk; its stability would not automatically remain at the candidate's score.

Notes on the scores:

- **A** keeps the full fit but carries the incident history and the unresolved fail-open defect; stability cannot be scored high until a fresh soak passes.
- **B** scores marco's own lifecycle engineering highly, but loses fit because the delegation model cannot deterministically satisfy the quota/quality requirements without substantial new code. GPL lowers the security/legal score.
- **C** is the target: it inherits A's fit and adds the lifecycle discipline that the incident lacked.
- **D** is sberdia as-is: simple and MIT, but it targets the v1 API, so it does not load on 2.1.4 without a port; it is Go-only and lacks most routing policy.
- **E** is the most stable and simplest, but fails the core requirements.

For completeness, usage-limits scored **6.7** as a router foundation (functional fit 2.0) but **8.8** as a quota component (fit 9.5, quota 9.5, simplicity 8.0). That is why it is recommended as a reference/oracle, not as the base.

## Why the hybrid wins

1. **Requirement coverage is non-negotiable.** The user's differentiators (intelligence floor, vision, design, two-provider quota, premium protection, cache affinity) are not present in any external candidate. Dropping them would be a different product.
2. **The incident was lifecycle, not routing.** The routing engine and policy were not the cause of the 420-load storm. Rewriting them would add risk without addressing the failure.
3. **External code does not remove lifecycle risk.** Marco's machinery is larger and GPL; sberdia's per-instance accounting is unsafe at 20 locations; sertdisk's web server is per location.
4. **The proven quota work is small.** Our adapters already exist; the external project is a test oracle. There is no need to import a TUI stack.
5. **Phased delivery is possible.** Each lifecycle fix can be tested in isolation before the next.

## What would change this recommendation

- **A supported v2 model-picker/router API** that lets a plugin register a routing policy without prompt hooks. That would make Option E viable and dramatically simpler.
- **A maintained external router that implements both providers' quota accounting, deterministic task routing, and v2 lifecycle with tests.** None exists today.
- **Evidence that v2 prompt-hook rejection or `switchModel` is deprecated.** That would force a delegation or config-only design.
- **A decision to accept GPL for the combined work.** Then a marco fork becomes more plausible, though still a poor fit.

## Decision

Adopt **Option C: repair and simplify our existing plugin**, with the scope boundaries in `06-RECOMMENDED-DESIGN.md` and the phases in `07-IMPLEMENTATION-ROADMAP.md`.

Do not fork marco, do not adopt sberdia as the base, do not install sertdisk, and do not add usage-limits as a runtime dependency.
