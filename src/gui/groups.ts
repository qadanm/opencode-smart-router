/**
 * Planning for sidebar grouping, kept free of the DOM so it can be tested.
 *
 * The desktop app's sidebar is a flat list of session rows. Each row carries the
 * project it belongs to. Grouping means ordering rows by project (most recently
 * used project first), and deciding which rows get a heading.
 *
 * Rules, chosen to match what people expect from a sidebar:
 * - A project with two or more visible sessions gets a heading.
 * - A project with one session keeps the app's own row, which already names the
 *   project. A heading over a single row is noise.
 * - Sessions that are working sort first, and their projects come first.
 * - Ties inside a project keep the app's order, which is recency.
 */

export interface SidebarRow {
  /** Stable identity, so callers can diff plans. */
  readonly key: string
  /** The project name shown on the row, when the row belongs to one. */
  readonly project?: string | undefined
  /** The session is currently running. */
  readonly working: boolean
}

export interface SidebarPlacement {
  readonly key: string
  /** Position in the grouped list, starting at 0. */
  readonly order: number
  /** Set on the first row of a multi-session project: the heading text. */
  readonly heading?: string | undefined
  /** The row belongs to a project group (single-session projects included). */
  readonly grouped: boolean
  /** Extra space above, because a new project starts here. */
  readonly gap: boolean
}

const projectOf = (row: SidebarRow) => row.project?.trim() || undefined

/**
 * Order rows for display.
 *
 * `grouped: false` returns the app's order unchanged, which is what the setting
 * being off must do. Rows without a project are their own single-row unit.
 */
export const planGroups = (rows: ReadonlyArray<SidebarRow>, grouped: boolean): SidebarPlacement[] => {
  if (!grouped) {
    return rows.map((row, index) => ({ key: row.key, order: index, grouped: false, gap: false }))
  }

  // Working rows lead; within that, the app's order is preserved.
  const ordered = [...rows].sort((left, right) => Number(right.working) - Number(left.working))

  const units: Array<{ project: string | undefined; rows: SidebarRow[] }> = []
  const byProject = new Map<string, { project: string; rows: SidebarRow[] }>()
  for (const row of ordered) {
    const project = projectOf(row)
    if (!project) {
      units.push({ project: undefined, rows: [row] })
      continue
    }
    const unit = byProject.get(project)
    if (unit) {
      unit.rows.push(row)
      continue
    }
    const created = { project, rows: [row] }
    byProject.set(project, created)
    units.push(created)
  }

  const placements: SidebarPlacement[] = []
  let order = 0
  units.forEach((unit, unitIndex) => {
    const named = unit.project !== undefined && unit.rows.length > 1
    unit.rows.forEach((row, index) => {
      placements.push({
        key: row.key,
        order,
        heading: named && index === 0 ? unit.project : undefined,
        grouped: unit.project !== undefined,
        gap: unitIndex > 0 && index === 0,
      })
      order += 1
    })
  })
  return placements
}
