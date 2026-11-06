import { mountSidebar, styles, type SidebarHandle } from "./sidebar.js"

/**
 * The sidebar feature as the panel sees it: one mount, one setting, and a guard
 * against the one other plugin that patches the same markup.
 */

/**
 * opencode-plus marks its own patches with `data-plus-*` attributes. Two plugins
 * reordering the same rows produce load-order-dependent results, so when it is
 * present this feature stands down entirely. Detecting it is a courtesy, not a
 * dependency: with opencode-plus installed alone, its grouping simply wins.
 */
const plusPresent = () => document.querySelector("[data-plus-group], [data-plus-shelf], [data-plus-add]") !== null

/** Whether the app is showing a surface this feature can group. */
export const surfaceAvailable = () => document.querySelector('[data-slot="vertical-tabs-sidebar"], [data-slot="sidebar-inbox"], [data-slot="home-sessions-list"]') !== null

export interface SidebarController {
  /** Re-read the setting and the page; cheap to call on every poll. */
  readonly sync: (enabled: boolean) => void
  /** What the app's sidebar currently exposes, for the panel to report honestly. */
  readonly probe: () => { surface: string | null; rows: number; withProject: number }
  /** Ask the new-session flow for this project. */
  readonly onNewSession: (handler: (project: string) => void) => void
  readonly destroy: () => void
  /** Whether the feature is currently applied. False when disabled or yielding. */
  readonly active: () => boolean
}

export const createSidebar = (): SidebarController => {
  let handle: SidebarHandle | undefined
  let enabled = false
  let newSession: ((project: string) => void) | undefined
  let destroyed = false

  const stop = () => {
    handle?.destroy()
    handle = undefined
  }

  const sync = (next: boolean) => {
    if (destroyed) return
    enabled = next
    if (!enabled) {
      stop()
      return
    }
    if (plusPresent()) {
      // Another plugin owns this surface right now. Do not fight it.
      stop()
      return
    }
    if (!handle) {
      handle = mountSidebar({
        enabled: true,
        onNewSession: (project) => newSession?.(project),
      })
      return
    }
    handle.run()
  }

  return {
    sync,
    onNewSession: (handler) => {
      newSession = handler
    },
    probe: () => handle?.probe() ?? { surface: null, rows: 0, withProject: 0 },
    active: () => handle !== undefined,
    destroy: () => {
      destroyed = true
      stop()
    },
  }
}

export { styles }
