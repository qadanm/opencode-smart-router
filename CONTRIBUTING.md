# Contributing

This project is small and deliberately narrow in scope, so a precise bug report
is usually more useful than a large patch.

## Before you start

Open an issue describing what you want to change and why. For anything touching
credential handling, routing eligibility, or quota arithmetic, please discuss it
first. Those areas carry security and correctness properties that are easy to
break from the outside, and a short conversation saves a rejected pull request.

## Ground rules

**Every change ships with a test.** `npm test` must pass. If behavior is hard to
test, treat that as a design signal.

**Never commit a credential, a token, an account identifier, or a personal file
path.** Every path in the codebase derives from `homedir()`. Keep it that way.
`safeError()` and `redact()` exist for this reason.

**Do not weaken a safety property to make a test pass.** When a test fails, the
test may be wrong (it has happened) or the code may be wrong. Work out which
before editing either.

**Provider facts need a source.** Allowances, multipliers, context windows, and
prices are claims about the world. Cite where a number came from, with a
retrieval date, in a comment. An unsourced number that looks authoritative is
worse than an admitted gap.

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run check            # both
npm run build:server     # the plugin bundle
npm run build:allowance  # the standalone allowance core
```

Node 20.12 or newer.

## Architecture boundaries

Two rules keep this maintainable and publishable.

**The allowance core stays portable.** `src/allowance.ts` is the public,
host-independent surface. It may import only `core/plans/catalog`,
`core/context/strategy`, `core/quota/report`, and `core/types`. It must never
touch the filesystem, the network, the environment, or the host's plugin API.
`test/allowance-api.test.ts` enforces this. If that test fails, the change is
wrong, not the test.

**Plans are data, not code.** A subscription tier is a `PlanDefinition` in
`src/core/plans/catalog.ts`. Do not add `if (plan === "pro")` to a routing or
quota module. If a new tier needs different behavior instead of different
numbers, that is an architecture discussion.

Provider HTTP handling belongs in `src/core/quota/*-provider.ts`. Routing policy
belongs in `src/core/routing/` and `src/core/policy/`.

## Adding a provider

A provider adapter documents four things before it is accepted:

- which credential it needs, and whether that credential can read usage;
- every host it contacts, and whether each call is read-only;
- how it reports confidence (`provider`, `estimate`, or `unknown`), and why;
- what it does when the usage source is unavailable.

A provider whose limits cannot be read must report `estimated` or `unknown`. It
must never report an unknown allowance as unlimited.

## Adding a plan

Add a `PlanDefinition` with a source citation and a retrieval date. Add a test
for the pool shape, the nesting invariants, and the absence of windows the plan
does not have. A plan with no five-hour window must not report "0% of a five-hour
limit," because that implies a ceiling nothing can hit.

## Commit messages

Explain why, not what. The diff already shows what. A commit that fixes a subtle
bug should say how the bug showed up, because that part is not recoverable from
the code.

## Out of scope

Likely to be declined:

- spending money on your behalf;
- acquiring credentials or control keys automatically;
- disabling provider-side prompt caching;
- silently truncating or discarding conversation history;
- telemetry or analytics.
