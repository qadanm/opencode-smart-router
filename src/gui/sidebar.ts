import { planGroups, type SidebarRow, type SidebarPlacement } from "./groups.js"

/**
 * Applies project grouping to the desktop app's session surfaces.
 *
 * The app renders sessions in three different shapes depending on the layout
 * setting, and they share no markup:
 *
 * - **Vertical tabs** (the sidebar in chatting mode): session tabs are
 *   `[data-titlebar-tab][data-orientation="vertical"]` inside
 *   `[data-slot="vertical-tabs-sidebar"]`, and each carries its project name in
 *   `[data-slot="tab-project"]`.
 * - **Inbox**: `[data-slot="sidebar-inbox-item"]` rows inside
 *   `[data-slot="sidebar-inbox-scroll"]`, with the project in the first line.
 * - **Home**: `[data-component="home-session-row-container"]` rows grouped by
 *   date today, with the project in `[data-slot="home-session-label"]` when the
 *   row shows one.
 *
 * We support all three because picking one is how the first attempt silently
 * grouped nothing. Every selector miss is a no-op, and `probe()` reports what was
 * found so the panel can say "on, but this layout has no groups" instead of
 * showing an On switch that does nothing.
 */

const GROUP = "data-router-group"
const HEADING = "data-router-heading"
const KEY = "data-router-key"
const ADD = "data-router-add"

type Surface = "vertical" | "inbox" | "home"

interface Adapter {
  readonly surface: Surface
  readonly container: Element | null
  readonly list: Element | null
  rows: () => Element[]
  project: (row: Element) => string | undefined
  working: (row: Element) => boolean
}

const text = (node: Element | null | undefined) => node?.textContent?.trim() || undefined

const verticalAdapter = (): Adapter | null => {
  const container = document.querySelector('[data-slot="vertical-tabs-sidebar"]')
  if (!container) return null
  const list =
    container.querySelector('[data-titlebar-tab-list][data-orientation="vertical"]') ??
    container.querySelector('[data-titlebar-tab-list]') ??
    container
  const rowsSelector = '[data-titlebar-tab][data-orientation="vertical"]'
  return {
    surface: "vertical",
    container,
    list,
    rows: () => Array.from(list.querySelectorAll(rowsSelector)).filter((row) => !row.closest('[data-slot="mobile-tabs-drawer"]')),
    project: (row) => text(row.querySelector('[data-slot="tab-project"]')),
    working: (row) => row.getAttribute("data-status") === "busy",
  }
}

const inboxAdapter = (): Adapter | null => {
  const container = document.querySelector('[data-slot="sidebar-inbox"]')
  if (!container) return null
  const list = container.querySelector('[data-slot="sidebar-inbox-scroll"]') ?? container
  return {
    surface: "inbox",
    container,
    list,
    rows: () => Array.from(list.children).filter((child) => child.matches('[data-slot="sidebar-inbox-item"]')),
    project: (row) => text(row.querySelector(":scope > span:first-child > span.truncate")),
    working: (row) => row.getAttribute("data-status") === "working",
  }
}

const homeAdapter = (): Adapter | null => {
  const list = document.querySelector('[data-slot="home-sessions-list"]')
  if (!list) return null
  return {
    surface: "home",
    container: list,
    list,
    rows: () => Array.from(list.querySelectorAll('[data-component="home-session-row-container"]')),
    project: (row) =>
      text(row.querySelector('[data-slot="home-session-label"]')) ??
      text(row.querySelector('[data-slot="home-session-labels"] > span')),
    working: (row) => row.getAttribute("data-status") === "busy",
  }
}

export const pickSurface = (): Adapter | null => verticalAdapter() ?? inboxAdapter() ?? homeAdapter()

/** What the panel shows so an On switch never lies about doing nothing. */
export interface SidebarProbe {
  readonly surface: Surface | null
  readonly rows: number
  readonly withProject: number
}

export const probeSidebar = (): SidebarProbe => {
  const adapter = pickSurface()
  if (!adapter) return { surface: null, rows: 0, withProject: 0 }
  const rows = adapter.rows()
  return {
    surface: adapter.surface,
    rows: rows.length,
    withProject: rows.filter((row) => adapter.project(row) !== undefined).length,
  }
}

/** The CSS the plugin contributes while grouping is on. */
export const styles = `
[${HEADING}] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 6px 2px;
  padding-inline-start: 10px;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--v2-text-text-faint, var(--color-v2-text-text-muted, currentColor));
  user-select: none;
}
[${HEADING}]:first-child { margin-top: 2px }
[${HEADING}] > [${ADD}] {
  margin-inline-start: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px; height: 18px;
  border: 0; border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 13px; line-height: 1;
  opacity: 0; cursor: pointer;
}
[${HEADING}]:hover > [${ADD}], [${HEADING}] > [${ADD}]:focus-visible {
  opacity: 1;
  background: var(--v2-overlay-simple-overlay-hover, rgba(127,127,127,0.14));
}
`

export interface SidebarOptions {
  readonly enabled: boolean
  readonly onNewSession?: ((project: string) => void) | undefined
}

export interface SidebarHandle {
  readonly run: () => void
  readonly destroy: () => void
  readonly probe: () => SidebarProbe
}

const readPlacement = (row: Element): SidebarPlacement | undefined => {
  const raw = row.getAttribute(GROUP)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as SidebarPlacement
  } catch {
    return undefined
  }
}

export const mountSidebar = (options: SidebarOptions): SidebarHandle => {
  let destroyed = false
  let frame = 0
  let adapter: Adapter | null = null
  const headings = new Map<string, HTMLElement>()

  const clear = () => {
    document.querySelectorAll(`[${GROUP}]`).forEach((row) => {
      row.removeAttribute(GROUP)
      row.removeAttribute(KEY)
    })
    document.querySelectorAll(`[${HEADING}]`).forEach((heading) => heading.remove())
    headings.clear()
  }

  /**
   * The app's own row types are buttons and grid containers. Reordering means
   * moving nodes, which is safe because the app re-renders from state; a heading
   * inserted between them is not part of that state, so it is removed first on
   * every pass and re-inserted in place. Reusing the node keeps hover and focus.
   */
  const run = () => {
    if (destroyed) return
    if (!options.enabled) {
      clear()
      return
    }
    adapter = pickSurface()
    if (!adapter) {
      clear()
      return
    }
    const rows = adapter.rows()
    if (rows.length === 0) {
      clear()
      return
    }

    const keyed = rows.map((row) => {
      const existing = row.getAttribute(KEY)
      if (existing) return { row, key: existing }
      const id =
        row.getAttribute("data-session-id") ??
        row.getAttribute("data-tab-id") ??
        row.getAttribute("data-key") ??
        row.querySelector('[data-slot="tab-title"]')?.textContent?.slice(0, 24) ??
        `row-${rows.indexOf(row)}`
      row.setAttribute(KEY, id)
      return { row, key: id }
    })

    const input: SidebarRow[] = keyed.map(({ row, key }) => ({
      key,
      project: adapter!.project(row),
      working: adapter!.working(row),
    }))

    if (input.every((row) => row.project === undefined)) {
      // No row exposes a project name in this layout. Leave the surface alone.
      clear()
      return
    }

    const plan = planGroups(input, true)
    const byKey = new Map(keyed.map(({ row, key }) => [key, row]))

    // Remove headings first so they never end up before the wrong row.
    document.querySelectorAll(`[${HEADING}]`).forEach((heading) => heading.remove())

    for (const placement of plan) {
      const row = byKey.get(placement.key)
      if (!row) continue
      row.setAttribute(GROUP, JSON.stringify(placement))
      if (!placement.heading) continue

      const existing = headings.get(placement.heading)
      const heading = existing ?? document.createElement("div")
      if (!existing) {
        heading.setAttribute(HEADING, placement.heading)
        heading.setAttribute("role", "heading")
        heading.setAttribute("aria-level", "3")
        const label = document.createElement("span")
        label.textContent = placement.heading
        heading.append(label)
        if (options.onNewSession) {
          const add = document.createElement("button")
          add.type = "button"
          add.setAttribute(ADD, "")
          add.setAttribute("aria-label", `New session in ${placement.heading}`)
          add.title = `New session in ${placement.heading}`
          add.textContent = "+"
          add.addEventListener("click", (event) => {
            event.preventDefault()
            event.stopPropagation()
            options.onNewSession?.(placement.heading!)
          })
          heading.append(add)
        }
        headings.set(placement.heading, heading)
      }
      row.before(heading)
    }

    // DOM order is the group order. Moving a row that is already in place is a
    // no-op, so a pass with no changes touches nothing.
    const container = adapter.list ?? adapter.container
    if (!container) return
    for (const placement of plan) {
      const row = byKey.get(placement.key)
      if (!row) continue
      container.append(row)
    }
  }

  const schedule = () => {
    if (frame || destroyed) return
    frame = requestAnimationFrame(() => {
      frame = 0
      run()
    })
  }

  const observer = new MutationObserver(schedule)
  // Watch the whole document once: the surfaces swap when the layout setting
  // changes, so a container-scoped observer would go blind after a mode change.
  if (typeof document !== "undefined" && document.body) {
    observer.observe(document.body, { childList: true, subtree: true })
  }

  run()

  return {
    run,
    probe: probeSidebar,
    destroy: () => {
      destroyed = true
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      clear()
    },
  }
}
