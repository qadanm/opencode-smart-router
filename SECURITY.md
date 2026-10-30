# Security policy

## Reporting a vulnerability

Open a private security advisory at
`https://github.com/qadanm/opencode-smart-router/security/advisories/new`, or
email the maintainer listed in `package.json`. Please don't open a public issue
for a suspected vulnerability.

Include what you can: the version or commit, your configuration, what you saw,
and the smallest reproduction. You'll get an acknowledgment within a few days.
This is a single-maintainer project with no paid support, so those dates are
intentions, not a contract.

## What this software does with credentials

A tool that reads credentials from disk owes you a precise account of which files
it touches, why, and what happens to the values.

### The short version

- The router reads **bearer credentials you already store on your own machine**,
  for providers you already connected.
- It sends a credential **only** to that credential's own provider, in an
  `Authorization` header, either to read usage or to make an inference request you
  asked for.
- It **never** logs, prints, persists, or transmits a credential anywhere else.
- Automatic discovery from predictable paths is **off by default**.

### Discovery requires opt-in

Reading well-known credential files requires either:

```jsonc
// ~/.config/opencode/smart-router.json
{ "providers": { "commandcode": { "credentialSource": "auto" } } }
```

or the environment flag `SMART_ROUTER_ALLOW_KEY_DISCOVERY=1`.

Without one of those, the router reads only:

- credentials named by `credentialPath` in configuration, and
- credentials in the environment (`COMMAND_CODE_API_KEY`, `OPENDESIGN_API_KEY`)
  or in the provider settings the host already holds.

`credentialSource: "off"` disables filesystem reads entirely.

### It does not read other applications' credential stores

Only paths belonging to this router's configuration directory or to the named
provider are considered. The router **does not read OpenCode's own `auth.json`**.
That file is another application's unified store: it holds OAuth material for
every provider you connected, and reading it would mean handling tokens the
router was never asked about.

If you find a code path that reads a foreign credential store, treat it as a
vulnerability and report it.

### Filesystem hardening

Each credential file is:

- opened **once**, with `O_NOFOLLOW`, so a symlink cannot redirect the read;
- checked against the **open descriptor** instead of a separate `stat` call,
  which closes a time-of-check/time-of-use race where the path could be swapped
  between the permission check and the read;
- required to be a **regular file** with **no group or world permission bits**.
  Anything else is refused, because on a shared machine another account could
  otherwise influence which credential the router picks;
- **capped at 64 KiB** before any read is attempted;
- always **closed**, on every path out of the function.

A file found by discovery must also be owned by the current user. See the next
section for why that check is narrower than it sounds.

#### Containers and bind mounts

The ownership check compares a **discovered** file's uid with `process.getuid()`.
Inside a container the process often runs as a different uid than the one that
owns the mounted file, so discovery refuses it. That is deliberate. When scanning
well-known locations, the router cannot tell "my own secret under another uid"
from "someone else's secret."

A file you **name** (`credentialPath`, `controlKeyPath`) skips the uid comparison,
because naming a path is already a deliberate trust decision. The group and world
permission check still applies to named files.

If discovery refuses a credential in a container, you have three options:

1. run the process as the file's owner (`--user $(id -u):$(id -g)`);
2. `chown` the mounted secret to the container's uid;
3. name the file with `credentialPath`, or pass the credential through the
   environment (`COMMAND_CODE_API_KEY`, `OPENDESIGN_API_KEY`).

No configuration switch disables the permission check itself.

### Secrets do not reach output

- No credential is written to the ledger, a routing decision, a session title, a
  diagnostic bundle, an event, or a log line.
- Error strings from a credential read pass through `redact()`.
- Diagnostic output identifies a credential source by a fixed label and, for
  files, the **final path segment only**: `file (commandcode.key)`. Never a path
  prefix, never a value. An unrecognized source string is reported as `configured`
  instead of being echoed, so a caller cannot turn that field into an arbitrary
  channel into a persisted note.
- Warnings *do* name the path that was rejected, for example "Ignoring Command
  Code credential file with group/world permissions: /path/to/key". You need the
  path to fix the permission. It is not a secret, but on a multi-user machine it
  does reveal part of a directory layout. Keep credentials inside your home
  directory if that matters.
- `test/credentials-security.test.ts` asserts each of these properties.

### The privileged control key

An OpenDesign account-control key can read billing state, so it is treated as a
privileged credential:

- it is **never** discovered from the environment or by scanning;
- it is read **only** when you name a file with `controlKeyPath`;
- the router never requests, generates, or acquires one.

### No spending

The router is subscription-only by default. It does not spend wallet balance,
does not enable automatic top-up, and does not fall back to pay-as-you-go pricing
unless `allowExtraUsage: true` is set explicitly.

## Data this software stores

The local ledger records, per request: timestamp, provider, model, token counts
(input, output, cache read, cache write), an estimated dollar cost, and an
outcome. It lives in the host's local database.

It does **not** store prompt text, file contents, model responses, or
credentials. Prompt text storage is a separate setting (`logging.storePromptText`)
that is off by default and that this project does not recommend turning on.

Aged usage events fold into hourly aggregates with the same fields, so totals
survive without keeping per-request detail forever.

## Network endpoints

The router contacts only:

| Purpose | Host |
|---|---|
| Model inference | whichever provider the host selected |
| OpenCode Go usage | `opencode.ai` |
| Command Code usage | `api.commandcode.ai` (read-only `GET` on undocumented alpha routes) |
| OpenDesign usage | the configured gateway host (read-only, only with a control key) |

There is no telemetry, no analytics endpoint, and no update check. Two
qualifications on that:

- **`status` and `usage` make no inference call.** They spend no tokens and cost
  you nothing.
- **`status` may start a background quota probe** if a cached snapshot is older
  than `quota.probeIntervalMinutes` (5 by default). The probe is a `GET` to a
  provider's usage endpoint. It runs asynchronously and the command does not wait
  for it. With `probeUsage: false` on a provider, no probe happens.

## Supply chain

The runtime has one dependency, `@opencode/plugin`, which is the host's own
plugin SDK. The portable allowance core
(`@qadanm/opencode-smart-router/allowance`) bundles to a single file with **zero
external imports**, and a test enforces that it imports no Node built-ins and no
host modules.

## Supported versions

This is pre-1.0 software. Security fixes land on the latest version only.
