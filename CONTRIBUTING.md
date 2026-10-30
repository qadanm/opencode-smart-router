# Contributing

Thanks for looking. This project is small and deliberately conservative about
scope, so the most useful contribution is usually a precise bug report rather
than a large patch.

## Before you start

Open an issue describing what you intend to change and why. For anything
touching credential handling, routing eligibility, or quota arithmetic, please
discuss it first — those areas have security and correctness properties that are
easy to break from the outside, and a short conversation saves a rejected PR.

## Ground rules

**Every change ships with a test.** `npm test` must pass. If behaviour is hard
to test, that is usually a design signal rather than an excuse.

**Never commit a credential, a token, an account identifier, or a personal
file path.** The codebase derives every path from `homedir()`; keep it that way.
`safeError()` and `redact()` exist for a reason.

**Do not weaken a safety property to make a test pass.** If a test fails, the
test may be wrong (it has happened) or the code may be wrong — determine which
before editing either.

**Provider facts need a source.** Allowances, multipliers, context windows and
prices are claims about the real world. Cite where a number came from, with a
retrieval date, in a comment. An unsourced number that looks authoritative is
worse than an admitted gap.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run check         # both
npm run build:server  # the plugin bundle
npm run build:allowance  # the standalone allowance core
```

Node 20.12 or newer.

## Architecture boundaries

Two rules keep the project maintainable and publishable:

1. **The allowance core must stay portable.** `src/allowance.ts` is the public,
   host-independent surface. It may import only `core/plans/catalog`,
   `core/context/strategy`, `core/quota/report` and `core/types`. It must never
   touch the filesystem, the network, the environment, or the host's plugin API.
   `test/allowance-api.test.ts` enforces this; if it fails, the change is wrong,
   not the test.

2. **Plans are data, not code.** A subscription tier is a `PlanDefinition` in
   `src/core/plans/catalog.ts`. Do not add `if (plan === "pro")` to a routing or
   quota module. If a new tier needs different *behaviour* rather than different
   numbers, that is an architecture discussion.

Provider-specific HTTP handling belongs in `src/core/quota/*-provider.ts`.
Routing policy belongs in `src/core/routing/` and `src/core/policy/`.

## Adding a provider

A provider adapter must document four things before it is accepted:

- which credential it needs, and whether that credential can read usage;
- every host it contacts, and whether each call is read-only;
- how it reports confidence (`provider`, `estimate`, or `unknown`), and why;
- what it does when the usage source is unavailable.

A provider whose limits cannot be read must report `estimated` or `unknown`. It
must never report an unknown allowance as if it were unlimited.

## Adding a plan

Add a `PlanDefinition` to the catalog with a source citation and a retrieval
date. Add a test asserting the pool shape, the nesting invariants, and that a
window the plan does not have is absent rather than zero — a plan with no
five-hour window must not report `0% of a five-hour limit`, because that implies
a ceiling that cannot be hit.

## Commit messages

Explain the *why*, not the *what*. The diff already shows the what. A commit that
fixes a subtle bug should say how the bug manifested, because that is the part
which is not recoverable from the code.

## Scope

Out of scope, and likely to be declined:

- spending money on the user's behalf;
- acquiring credentials or control keys automatically;
- disabling provider-side prompt caching;
- silently truncating or discarding conversation history;
- telemetry or analytics.
