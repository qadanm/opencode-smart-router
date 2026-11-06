# Sidebar grouping: tabled

Status: removed from the plugin in 0.5.1. Do not rebuild it.

## What we built

Between 0.5.0 and 0.5.1 this repo shipped an opt-in feature that grouped the
desktop sidebar's sessions under project headings, with a new-session button per
project and a toggle in the router panel. It patched the app's markup, because
the desktop app exposes no sidebar API to plugins.

## Why it was removed

The desktop app already ships this natively, and it landed before we got there.

- Upstream commit `2bb4988` (2026-11-04), "feat(app): add project-organized side
  tabs with session previews (#61700)", adds `SidebarOrganized` in
  `packages/app/src/shell/titlebar/sidebar-organized.tsx`.
- It groups side tabs under a collapsible **Projects** section, with per-project
  session lists, project icons, drag-to-reorder, "Show more / Show less" per
  project, and an empty state. It persists collapse/expand and order.
- It is behind **Settings -> Experimental -> Organize vertical sidebar ->
  Projects** (`general.sidebarOrganize`), described upstream as
  "Group side tabs by project or show one list. Only applies to side tabs."
- The installed app at the time was v2.2.5 (released 2026-10-30), five days
  before that merge, which is why the setting was not present locally.

A plugin reimplementation would duplicate maintained app code, break when the
app's markup changes, and, worst of all, run alongside the native version and
fight it. Two grouping layers on one list is a defect, not a feature.

## What to do instead

1. Update OpenCode to a build after v2.2.5.
2. Turn on Settings -> Experimental -> Organize vertical sidebar -> Projects.

## Prior art, for the record

- `ephraimduncan/opencode-plus` (MIT) prefixes its DOM patches with `data-plus-*`
  and groups the **Inbox** sidebar. It does not touch the chatting-mode (vertical
  tabs) sidebar or the top bar, and its README states the 2.2.5 pin plainly.
- No public MIT project was found that groups the vertical-tabs sidebar. That is
  because the app team shipped it themselves.

## If this ever comes back

Only if the native setting is removed or the app gains a plugin API for sidebar
layout. In that case, group by reading session ids from the DOM and resolving
projects through the client API, never by scraping labels, and prove each
surface (vertical tabs, inbox, home) against the live app before claiming it
works.
