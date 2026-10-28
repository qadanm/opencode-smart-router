# Breadcrumbs — OpenCode provider integration, for the next agent

Notes for whoever picks this up. It records the non-obvious things that cost
time, so you do not rediscover them the hard way.

---

## 1. Why there appear to be two servers

There are not two OpenCode servers. There are three separate things, plus this
session's own lab.

| Port | What it is | Who owns it |
|---|---|---|
| **49374** | The OpenCode backend, `…/ai.opencode.desktop/cli/2.2.0-arm64/opencode-cli serve --service` | The desktop app |
| **53133** | An Electron helper listening, not a model server | The desktop app |
| **49500** | Isolated three-provider canary server | The router lab |
| **4200** | Mock gateway for the canary | The router lab |
| **8774** | PermitPath owner-review server | Earlier task |

**The important one:** the backend on 49374 is parented to **launchd (PID 1)**,
not to the Electron app. **Quitting and reopening OpenCode Desktop does not
restart it.** To restart it you must kill the PID directly; launchd respawns it.

This cost real time: a config fix was applied at 09:02 but the server had
started at 08:59, so the UI kept showing stale data and the restart appeared not
to work. Always compare the server's start time against the config's mtime:

```bash
lsof -ti tcp:49374 -sTCP:LISTEN | head -1        # server pid
ps -o lstart= -p <pid>                            # when it started
stat -f '%Sm' ~/.config/opencode/opencode.json    # when config changed
```

Find the server's password with `jq -r '.password' ~/.config/opencode/service.json`,
then query `http://127.0.0.1:49374/api/model` and `/api/provider`.

---

## 2. Adding a custom OpenAI-compatible provider to OpenCode

Two schema details that are easy to get wrong and that fail **silently**:

1. **Use `settings`, not `options`.** OpenCode ignored an `options` block
   entirely: the provider registered, its models even appeared in
   `/api/model`, but it had no API key attached and the desktop picker hid it.
   The working shape is the one `commandcode` and `ollama` use:

   ```json
   "opendesign": {
     "name": "OpenDesign Go",
     "package": "@opencode/ai/providers/openai-compatible",
     "settings": { "baseURL": "https://…/v1", "apiKey": "…" },
     "models": { … }
   }
   ```

2. **Every model needs `"type": "chat"`.** Without it the server lists the
   model but the desktop picker does not show it. Add `family` too — the picker
   groups by it, and models with no family get no group label.

Diagnose with a field-by-field diff against a provider that already works:

```bash
curl -s -u "opencode:$PASS" http://127.0.0.1:49374/api/model \
  | jq -c '[.data[] | select(.providerID=="commandcode")][0] | keys'
```

Compare that key list against the new provider's. Anything missing is a
candidate cause.

To check whether the UI can see a model at all, use the model search rather
than the picker, which removes the UI from the question.

---

## 3. Adding a provider is not the same as the router knowing about it

Adding `providers.opendesign` to `opencode.json` makes the models **selectable
by hand**. It does **not** make the smart router route to them.

The router is configured separately in `~/.config/opencode/smart-router.json`.
Until `providers.opendesign.enabled` is `true` there, the router ignores the
provider completely — which is the correct default, and why adding the provider
is safe to do first.

Picking a model from the dropdown sets a manual override, and the router leaves
manual sessions alone. So a user can always hand-pick a model the router does
not know about, and nothing breaks.

---

## 4. The smart router's test suite reads your real config

`loadSettings` merges `~/.config/opencode/smart-router.json` **over** the
plugin options. The test suite calls the same code, so tests were silently
picking up the developer's live router config. Three tests failed on this
machine and passed anywhere without that file.

Fixed by pointing `process.env.HOME` at a temp directory in
`test/helpers/ctx.ts`. If you add a test that depends on settings, make sure it
goes through `makeCtx` so it stays hermetic.

---

## 5. A model that drops streams was invisible to the router

The router only counted `capability` failures against a model's reliability.
A stream that died after the response started was classified `unknown`, which
counted against nothing, so a flaky model kept a perfect record and kept being
selected.

The signatures to know, because the HTTP status is 200 in both cases and the
status code never identifies them:

- `provider.internal` — "Streaming response failed: [500] EngineCore encountered an issue."
- `provider.invalid-output` — "OpenAI Chat stream ended without finish_reason"

Both now classify as `provider_outage`, are attributed to the model the host is
actually serving, and put the model into a cooldown that lengthens on repeat.
User interrupts classify as `interrupted` and never count against a model.

`session.execution.failed` and `session.execution.interrupted` carry **no
`outcome` field** — only `sessionID` and `error`. The event type itself is the
signal. `session.idle` does carry an `outcome`.

---

## 6. OpenDesign specifics

- The gateway is `https://amr-link.open-design.ai/v1` — the path already
  contains `/v1`. Never append it twice.
- Read-only model discovery is `GET /v1/models` and consumes no credits. It
  returns `architecture.input_modalities` and `metadata.context_budget`,
  `context_limit`, `output_budget`.
- **`context_budget`, not `context_limit`, is the usable window.** 228k–400k,
  against a vendor limit of up to 1.05M. Routing against the vendor limit sends
  requests the gateway rejects.
- There is **no quota API for an inference key**. `/v1/usage` and `/v1/me` are
  404; the account-control host rejects the inference key with 401. Upstream
  issues #8674 and #8870 are still open.
- The gateway resolves a **billing scope** before answering, even for a
  read-only `/models` call. It returned a transient `503
  workspace_billing_scope_unavailable` during this work and succeeded on retry.
- Do not use the Anthropic-messages protocol for DeepSeek V4.1 Flash — upstream
  #8687 reports it drops reasoning and stalls tool-calling agents.
- Go plan caps: **$120 monthly**, **$30 per 7 days**, **$10 per 5 hours**. The
  windows are nested inside the monthly maximum, never added.

---

## 7. This machine's constraints

16 GB unified memory, frequently tight on disk. Keep it in mind:

- Run at most one heavy local workstream; the canary server, mock, and soak are
  already one workstream.
- Bound every command that can produce large output.
- The OpenCode database is over 600 MB; query it read-only and with indexes.
- Stop any lab server, mock, or soak you start once the task is done, and say
  what is still running.
