# Architecture audit: OpenCode smart routing

**Date:** 2026-10-27
**Status:** research complete; no implementation or live installation performed
**Scope:** our disabled `opencode-smart-router`, plus four public OpenCode plugins

## Read in this order

| File | Purpose |
|---|---|
| `01-EXECUTIVE-FINDINGS.md` | Bottom line, strongest foundation, recommendation, top risks |
| `02-REPOSITORY-COMPARISON.md` | Verified repos, commits, licenses, activity, APIs, tests |
| `03-LIFECYCLE-ROOT-CAUSE.md` | Why the original plugin destabilised OpenCode, with source references |
| `04-COMPONENT-REUSE-MATRIX.md` | What can be reused, from where, under which license, at what cost |
| `05-ARCHITECTURE-OPTIONS.md` | Repair vs adopt vs hybrid, weighted scorecard |
| `06-RECOMMENDED-DESIGN.md` | Concrete target architecture and lifecycle |
| `07-IMPLEMENTATION-ROADMAP.md` | Phased engineering plan with acceptance criteria and rollback |
| `08-EVIDENCE-AND-TESTS.md` | What was inspected and executed, with reproducible commands |

## Evidence conventions

Every substantive claim is labelled:

- **Verified (source):** read directly in the pinned commit.
- **Verified (executed):** a command or probe was run in an isolated environment.
- **Documented:** stated in the project's own docs or issue tracker, not independently verified.
- **Inferred:** follows from code but was not executed.
- **Unknown:** insufficient evidence.

Scores are architecture judgments, not benchmarks. No provider credits were spent, and no live OpenCode configuration was changed.

## Repository pins

| Candidate | Commit | License |
|---|---|---|
| Ours | working tree at `~/Documents/opencode-smart-router` | none declared |
| `marco-jardim/opencode-model-router` | `d2837cc0d086bf814694811e359cf12a9c2c0a32` | GPL-3.0-only |
| `s-berdia/Opencode_router` | `54256a9c42842ad878111425a440bc5e2f381f33` | MIT |
| `sertdisk/OpenCode-Model-Router` | `0529a145e01b8c8eb588742b509eac2f852a963a` | MIT |
| `mynameistito/opencode-plugins` (usage-limits package) | `151405a66fd74f00b34f771e0a073ab57b4df3f0` | MIT |

The requested URL `s-berdia/opencode-router` returns HTTP 404. The author's matching repository is `s-berdia/Opencode_router`; see `02-REPOSITORY-COMPARISON.md`.
