# Debugging the desktop panel

Written after a session where the panel vanished and four plausible causes were
investigated before the real one. Read this before touching GUI code.

## Check the server version first

The desktop panel needs **OpenCode Desktop 2.2.x or newer**. A 2.1.x server has no
GUI plugin API: it will not report `gui` in `/api/plugin`, and it cannot load
`gui-experimental.cjs` at all.

```bash
opencode api get /api/info          # must say 2.2.x
opencode api get /api/plugin        # opcode-smart-router must have features.gui: true
```

**The common trap:** `opencode` on `PATH` may be an older Homebrew install than
the app. Running `opencode service restart` then restarts the *old* server, and it
takes the port the app was using. The app reconnects to it, and the panel stops
loading with no useful error.

```bash
which opencode && opencode --version           # CLI on PATH
ls ~/Library/Application\ Support/ai.opencode.desktop/cli/   # app's bundled CLI
```

They must both be 2.2.x. If they are not, either `brew upgrade opencode-v2` or
restart the app itself (`⌘Q`, then relaunch) instead of using the service command.
The app spawns its own bundled server, which is the one that can load a GUI.

## Then check the id rules

Documented in the GUI guide, and easy to misread:

> A plugin whose id "nests under one with a dot, has one nested under it, or is in
> the `opencode` namespace" does not load its GUI.

Concretely, this is wrong:

```
server part  id: "opencode-smart-router"
tui part     id: "opencode-smart-router.tui"     ◄ nests under the server id
```

The TUI id must be a sibling, not a child. `test/first-run.test.ts` asserts that no
two plugin ids nest, because the failure costs the entire panel and produces only
a generic request failure in the app.

## What the symptoms actually mean

| Symptom | Usual cause |
|---|---|
| `Request failed / UnsupportedContentType` | Client and server versions disagree, or the GUI never registered |
| Tab strip resets to the new-tab page | No GUI entry was loaded for that plugin |
| `features` has no `gui` | Server too old, or the plugin id nests |
| Panel renders but RPC fails | Server part failed to load — a plugin with no server part has no GUI |
| Panel blank, no error | Something in `setup()` threw. A GUI whose setup throws loses the plugin, not just the panel |

## Rules that keep this debuggable

1. **`features.gui: true` is the single fact to check first.** It answers "did the
   app even find my GUI" before any speculation about bundles, exports or code.
2. **Never gate a required surface on an optional check.** The panel once rendered
   as an empty box because it waited for `onboarding()` to settle, and that call
   did not. Show the normal state; let optional data arrive later.
3. **A convenience must never be able to break the product.** The auto-open path
   touches four host APIs inside `setup()`; it is wrapped so a throw cannot remove
   the plugin.
4. **Test the version you think you are testing.** `/api/info` reports the server
   actually running, which is not necessarily the one you started.
