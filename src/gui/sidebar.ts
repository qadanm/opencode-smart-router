import { planGroups, type SidebarRow, type SidebarPlacement } from "./groups.js"

/**
 * Applies project grouping to the desktop app's sidebar.
 *
 * Why this works on markup: OpenCode Desktop has no plugin API for the session
 * sidebar, so a GUI plugin reaches the same document the app renders and tags
 * rows. That is how the reference implementation (opencode-plus, MIT) does it,
 * and their selector list is the best available description of the sidebar's
 * shape on 2.2.5.
 *
 * Where this differs from the reference, deliberately:
 * - A real heading element is inserted per group instead of a `::before` on a
 *   row. Pseudo-element headings are invisible to screen readers and to the
 *   app's keyboard navigation.
 * - The observer watches the sidebar container, not `document.body`, and runs
 *   at most one pass per animation frame.
 * - Existing heading nodes are reused and moved instead of recreated, so focus
 *   and hover survive a re-render.
 * - Every selector miss is a no-op, never a throw: an app update degrades to
 *   "no grouping", not a broken plugin.
 */

const INBOX = '[data-slot="sidebar-inbox"]'
const SCROLL = '[data-slot="sidebar-inbox-scroll"]'
export const ROW = '[data-slot="sidebar-inbox-item"]'

const GROUP = "data-router-group"
const HEADING = "data-router-heading"
const SHELF = "data-router-shelf"
const ADD = "data-router-add"

/**
 * The app's own project name for a row. It is the first line's project badge
 * text; when the app changes that markup, grouping turns itself off rather
 * than mislabeling rows.
 */
const projectOf = (row: Element): string | undefined => {
  const span = row.querySelector(":scope > span:first-child > span.truncate")
  const name = span?.textContent?.trim()
  return name || undefined
}

const rows = (list: Element | null): Element[] =>
  list ? Array.from(list.children).filter((child) => child.matches(ROW)) : []

const keyOf = (row: Element, index: number) => row.getAttribute("data-router-key") ?? `row-${index}`

/** The CSS the plugin contributes while grouping is on. */
export const styles = `
[${HEADING}] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 4px 2px;
  padding-inline-start: 22px;
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  letter-spacing: 0.02em;
  color: var(--color-v2-text-text-muted, currentColor);
  user-select: none;
}
[${HEADING}]:first-child { margin-top: 2px }
[${HEADING}] > [${ADD}] {
  margin-inline-start: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px; height: 18px;
  border-radius: 4px;
  opacity: 0;
  cursor: pointer;
}
[${HEADING}]:hover > [${ADD}], [${HEADING}] > [${ADD}]:focus-visible {
  opacity: 1;
  background: var(--color-v2-overlay-simple-overlay-hover, rgba(127,127,127,0.14));
}
@media (prefers-reduced-motion: no-preference) {
  [${ROW}] { transition: opacity 140ms ease }
}
`

export interface SidebarOptions {
  /** Whether grouping is enabled. */
  readonly enabled: boolean
  /** Called when the user presses the new-session button of a project heading. */
  readonly onNewSession?: (project: string) => void
  /** Called when the app's sidebar scrolls in a way that may reveal new rows. */
  readonly observe?: boolean
}

export interface SidebarHandle {
  readonly destroy: () => void
  readonly run: () => void
}

const placementFor = (row: Element): SidebarPlacement | undefined => {
  const raw = row.getAttribute(GROUP)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as SidebarPlacement
  } catch {
    return undefined
  }
}

/**
 * Mount grouping. Returns a handle so the panel can toggle the feature without a
 * plugin reload; `destroy` restores the sidebar to the app's own order.
 */
export const mountSidebar = (options: SidebarOptions): SidebarHandle => {
  let destroyed = false
  let frame = 0
  const headings = new Map<string, HTMLElement>()

  const clear = () => {
    document.querySelectorAll(`[${GROUP}]`).forEach((row) => {
      row.removeAttribute(GROUP)
      row.removeAttribute("style")
      row.removeAttribute("data-router-key")
    })
    document.querySelectorAll(`[${HEADING}]`).forEach((heading) => heading.remove())
    headings.clear()
  }

  const run = () => {
    if (destroyed) return
    if (!options.enabled) {
      clear()
      return
    }
    const inbox = document.querySelector(INBOX)
    const scroll = inbox?.querySelector(`:scope > ${SCROLL}`) ?? inbox
    if (!scroll) return

    const list = rows(scroll)
    if (list.length === 0) {
      clear()
      return
    }

    list.forEach((row, index) => {
      if (!row.getAttribute("data-router-key")) row.setAttribute("data-router-key", `k${index}`)
    })

    const input: SidebarRow[] = list.map((row, index) => ({
      key: keyOf(row, index),
      project: projectOf(row),
      working: row.getAttribute("data-status") === "working",
    }))
    const plan = planGroups(input, true)
    if (plan.every((placement) => placement.grouped === false)) {
      // The app's markup did not yield a project for any row. Leaving rows
      // untouched is the correct failure: grouping needs that data.
      clear()
      return
    }

    const byKey = new Map(list.map((row, index) => [keyOf(row, index), row]))
    let cursor: Element | null = scroll.firstElementChild

    for (const placement of plan) {
      const row = byKey.get(placement.key)
      if (!row) continue
      row.setAttribute(GROUP, JSON.stringify(placement))

      if (placement.heading) {
        const key = placement.heading
        let heading = headings.get(key)
        if (!heading) {
          heading = document.createElement("div")
          heading.setAttribute(HEADING, key)
          heading.setAttribute("role", "heading")
          heading.setAttribute("aria-level", "3")
          const label = document.createElement("span")
          label.textContent = key
          heading.append(label)
          if (options.onNewSession) {
            const add = document.createElement("button")
            add.type = "button"
            add.setAttribute(ADD, "")
            add.setAttribute("aria-label", `New session in ${key}`)
            add.title = `New session in ${key}`
            add.textContent = "+"
            add.addEventListener("click", (event) => {
              event.preventDefault()
              event.stopPropagation()
              options.onNewSession?.(key)
            })
            heading.append(add)
          }
          headings.set(key, heading)
        }
        if (heading.nextSibling !== row) row.before(heading)
      }
    }

    // Reorder rows to the plan. `order` on the parent is avoided because the app
    // also sets inline styles on rows; explicit DOM order keeps both honest.
    for (const placement of plan) {
      const row = byKey.get(placement.key)
      if (row && row !== cursor) scroll.append(row)
      cursor = row ?? cursor
    }
  }

  const schedule = () => {
    if (frame || destroyed) return
    frame = requestAnimationFrame(() => {
      frame = 0
      run()
    })
  }

  let observer: MutationObserver | undefined
  if (options.observe !== false) {
    observer = new MutationObserver(schedule)
    const target = document.querySelector(INBOX) ?? document.body
    observer.observe(target, { childList: true, subtree: true })
  }

  run()

  return {
    run,
    destroy: () => {
      destroyed = true
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      clear()
    },
  }
}
