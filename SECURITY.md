# Security policy

## Reporting a vulnerability

Open a private security advisory at
`https://github.com/qadanm/<repo>/security/advisories/new`, or email the
maintainer listed in `package.json`. Please do not open a public issue for a
suspected vulnerability.

Include what you can: the version or commit, the configuration, what you
observed, and the smallest reproduction you have. You will get an
acknowledgement within a few days. This is a single-maintainer project with no
paid support tier, so timelines are honest rather than contractual.

## What this software does with credentials

This is the important section. A tool that reads credentials from disk owes its
users a precise account of which files it touches, why, and what it does with
the values.

### Short version

- The router reads **bearer credentials you already store on your own machine**
  for providers you have already connected.
- It sends a credential **only** to that credential's own provider host, in an
  `Authorization` header, to read usage information or to make an inference
  request you asked for.
- It **never** logs, prints, persists, or transmits a credential anywhere else.
- Automatic discovery from predictable file paths is **off by default**.

### Longer version

#### It is never implicit

Discovery of well-known credential files requires explicit opt-in, either:

```jsonc
// ~/.config/opencode/smart-router.json
{ "providers": { "commandcode": { "credentialSource": "auto" } } }
```

or the environment flag `SMART_ROUTER_ALLOW_KEY_DISCOVERY=1`.

Without one of those, the router reads only:

- credentials named by `credentialPath` in configuration, and
- credentials supplied in the environment (`COMMAND_CODE_API_KEY`,
  `OPENDESIGN_API_KEY`) or by the host's own provider settings.

`credentialSource: "off"` disables filesystem reads entirely.

#### It does not read other applications' credential stores

Only paths belonging to this router's configuration directory or to the named
provider are considered. The router **explicitly does not read OpenCode's own
`auth.json`**. That file is another application's unified store: it holds OAuth
material for every provider the user has connected, not just the one being
probed, and reading it would mean handling tokens the router was never asked
about.

If you find a code path that reads a foreign credential store, that is a
vulnerability and should be reported as one.

#### Filesystem hardening

Each credential file is:

- opened **once**, with `O_NOFOLLOW`, so a symlink cannot be used to redirect
  the read;
- checked against the **open descriptor** rather than a separate `stat` call,
  which removes a time-of-check/time-of-use race in which a path could be
  swapped between the permission check and the read;
- required to be a **regular file**, owned by the **current user**, with **no
  group or world permission bits**. Anything else is refused, because a shared
  machine could otherwise influence which credential the router selects;
- **size-capped at 64 KiB** before any read is attempted;
- always **closed**, on every path out of the function.

#### Secrets do not leak into output

- No credential is ever written to the ledger, a routing decision, a session
  title, a diagnostic bundle, an event, or a log line.
- Error strings derived from a credential read pass through `redact()`.
- Diagnostic output identifies a credential **source** by a fixed label and, for
  files, the **final path segment only** — `file (commandcode.key)`, never a
  path prefix and never a value. An unrecognised source string is reported as
  `configured` rather than echoed, so a caller cannot introduce an arbitrary
  channel into a persisted snapshot note.
- Warning messages *do* name the file path that was rejected (for example
  "Ignoring Command Code credential file with group/world permissions:
  /path/to/key"). The path is included so a user can fix the permission; it is
  not a secret, but on a multi-user machine it does reveal a directory layout.
  If that matters to you, keep credentials inside your home directory.
- A test suite asserts each of these properties; see
  `test/credentials-security.test.ts`.

#### The privileged control key

An OpenDesign account-control key can read billing state. It is treated as a
privileged credential:

- it is **never** discovered from the environment or by scanning;
- it is read **only** when the user names a file with `controlKeyPath`;
- the router never requests, generates, or acquires one.

#### No spending

The router is subscription-only by default. It does not spend wallet balance,
does not enable automatic top-up, and does not fall back to pay-as-you-go
pricing unless `allowExtraUsage: true` is set explicitly.

## Data this software stores

The local ledger records, per request: timestamp, provider, model, token counts
(input, output, cache read, cache write), an estimated dollar cost, and an
outcome. It is stored in the host's local database.

It does **not** store prompt text, file contents, model responses, or
credentials. Prompt text storage is a separate, off-by-default setting
(`logging.storePromptText`) that this project does not recommend enabling.

Aged usage events are folded into hourly aggregates holding the same fields, so
totals survive without retaining per-request detail indefinitely.

## Network endpoints contacted

The router contacts only:

| Purpose | Host |
|---|---|
| Model inference | whichever provider the host selected |
| OpenCode Go usage | `opencode.ai` |
| Command Code usage | `api.commandcode.ai` (read-only `GET` on undocumented alpha routes) |
| OpenDesign usage | the configured gateway host (read-only, only with a control key) |

No telemetry is sent anywhere. No analytics endpoint exists. No update check
calls home.

Two honest qualifications:

- **`status` and `usage` make no *inference* call.** They never spend tokens and
  never cost you money.
- **`status` may trigger a background read-only quota probe** if a cached
  snapshot has aged past `quota.probeIntervalMinutes` (default 5). That probe is
  a `GET` to a provider's usage endpoint, issued asynchronously; it is not
  awaited by the command. With `probeUsage: false` on a provider, no probe is
  made at all.

## Supply chain

The runtime has exactly one dependency, `@opencode/plugin`, which is the host's
own plugin SDK. The portable allowance core (`opencode-smart-router/allowance`)
bundles to a single file with **zero external imports**; a test enforces that it
imports no Node built-ins and no host modules.

## Supported versions

This is pre-1.0 software. Security fixes land on the latest published version
only.
