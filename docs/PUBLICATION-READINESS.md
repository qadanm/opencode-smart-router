# Publication readiness

Status: **not publishable yet.** The code is ready; the packaging and hosting are
not. This file records the decision so it does not have to be rediscovered.

## Verified blockers

Checked 2026-10-29.

| Item | State |
|---|---|
| npm name `opencode-smart-router` | **Taken.** Owned by `metalbolicx`, v1.11.0, GPL-3.0-only, a different project (`MetalbolicX/opencode-smart-router`). This package can never use the unscoped name. |
| `@qadanm` npm scope | Available. User `qadanm` exists and is the logged-in npm identity. |
| `github.com/qadanm/opencode-smart-router` | **404.** Does not exist. `package.json` previously pointed at it, which would have produced dead `repository` and `bugs` links. |
| git remote | **None configured.** 58 commits on `feature/pro-plan-migration`, nothing pushed. |
| git history | 58 commits on `feature/pro-plan-migration`, nothing pushed. |
| secrets in history | **None.** Every object in all 878 reachable objects was scanned and compared against the live credential files by full value: no real key appears. The 8 key-shaped matches are test fixtures (`sk-a-test-inference-key-value`, `sk-amr-abcdefghijklmnop`, `sk-ant-oat-foreign-provider-secret`). |
| home path in history | **Present in 16 commits.** `302579b`/`8a05c8b` rewrote the working tree, not the history, so `git log -S` still finds it. Not a secret, but it is this machine's directory layout. |

## Decisions

1. **Package name is `@qadanm/opencode-smart-router`.** The unscoped name is
   held by an unrelated GPL-3.0 project, so reusing it is not possible and
   publishing under a confusingly similar name would be worse than a scope.
   Note for users: the two projects are unrelated. Installing
   `opencode-smart-router` gets the other author's GPL plugin, not this one.
2. **`private: true` stays for now.** It turns an accidental `npm publish` into
   an immediate, obvious failure instead of creating a partial release under a
   name associated with someone else's project. Removing it is part of the
   release step, not a prerequisite.
3. **One repository, two entry points.**
   `@qadanm/opencode-smart-router` (the plugin) and
   `@qadanm/opencode-smart-router/allowance` (the host-independent core) ship
   from the same repo. The core already builds to a standalone 17 kB artifact
   with zero external imports (`npm run build:allowance`), so splitting it into
   its own package later remains possible; it does not need to happen first.
4. **MIT applies to the whole repository**, including the plugin. The core is
   the differentiated part, but a split license would only add friction.

## Before any release

- [ ] Create `github.com/qadanm/opencode-smart-router` and push.
- [ ] Decide whether to publish the existing history or start from a squashed
      root commit. No real credential is in history (verified), but the home
      path appears in 16 commits. A squash is the simplest fix and costs
      nothing here, since nothing has been pushed.
- [ ] Remove `private: true`.
- [ ] Confirm `@qadanm` scope ownership on npm (`npm access ls-packages`).
- [ ] Re-run `npm run check` and both builds.
- [ ] Tag a version and write release notes from the commit log.
- [ ] Re-read `SECURITY.md` against the code one final time. Two review passes
      found real overclaims; assume a third pass can too.

## What is not claimed

- No external review has run `tsc` or `vitest` itself. Every green result
  recorded in this repository comes from the maintainer's own runs.
- The OpenDesign quota path is `estimated`, not verified, because the account
  has no control key. `minimax-m3.1-flash`'s credit multiplier is unpublished
  and modelled as neutral 1×.
- OpenCode Go reports percentage windows only; per-model dollar allowances are
  the router's interpretation, not provider-published figures.
