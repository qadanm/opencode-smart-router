import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The app renders sessions in three shapes. The first implementation only knew
 * the Inbox one, so in chatting mode (vertical tabs) it silently grouped nothing.
 * These tests pin all three surfaces and the probe that reports whether grouping
 * found anything to do.
 */

const load = async (html: string) => {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true })
  vi.stubGlobal("document", dom.window.document)
  vi.stubGlobal("window", dom.window)
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement)
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver)
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    fn()
    return 1
  })
  vi.stubGlobal("cancelAnimationFrame", () => undefined)
  const mod = await import("../src/gui/sidebar.js")
  return { doc: dom.window.document, mountSidebar: mod.mountSidebar, probeSidebar: mod.probeSidebar }
}

/** Chatting mode: vertical tabs, project name in [data-slot=tab-project]. */
const vertical = (tabs: Array<{ id: string; title: string; project: string }>) => `
  <div data-slot="vertical-tabs-sidebar">
    <div data-titlebar-tab-list data-orientation="vertical" data-slot="tab-list">
      ${tabs
        .map(
          (tab) => `<div data-titlebar-tab data-orientation="vertical" data-session-id="${tab.id}">
            <a data-slot="tab-link">
              <span data-slot="tab-title">${tab.title}</span>
              <span data-slot="tab-project">${tab.project}</span>
            </a>
          </div>`,
        )
        .join("")}
    </div>
  </div>`

describe("chatting-mode sidebar (vertical tabs)", () => {
  beforeEach(() => vi.unstubAllGlobals())

  it("detects the vertical tab surface", async () => {
    const { probeSidebar } = await load(vertical([{ id: "1", title: "a", project: "alpha" }]))
    const probe = probeSidebar()
    expect(probe.surface).toBe("vertical")
    expect(probe.rows).toBe(1)
    expect(probe.withProject).toBe(1)
  })

  it("groups tabs of the same project under a heading", async () => {
    const { doc, mountSidebar } = await load(
      vertical([
        { id: "1", title: "A1", project: "alpha" },
        { id: "2", title: "B1", project: "beta" },
        { id: "3", title: "A2", project: "alpha" },
      ]),
    )
    const handle = mountSidebar({ enabled: true })
    const headings = [...doc.querySelectorAll("[data-router-heading]")].map((node) => node.textContent)
    expect(headings).toEqual(["alpha"])
    handle.destroy()
  })

  it("leaves tabs alone when no tab exposes a project", async () => {
    const { doc, mountSidebar, probeSidebar } = await load(`
      <div data-slot="vertical-tabs-sidebar">
        <div data-titlebar-tab-list data-orientation="vertical">
          <div data-titlebar-tab data-orientation="vertical" data-session-id="1"><span data-slot="tab-title">A</span></div>
          <div data-titlebar-tab data-orientation="vertical" data-session-id="2"><span data-slot="tab-title">B</span></div>
        </div>
      </div>`)
    const handle = mountSidebar({ enabled: true })
    expect(doc.querySelectorAll("[data-router-heading]").length).toBe(0)
    // The probe distinguishes "found the surface but no projects" from "no surface".
    expect(probeSidebar()).toMatchObject({ surface: "vertical", rows: 2, withProject: 0 })
    handle.destroy()
  })
})

describe("inbox sidebar", () => {
  beforeEach(() => vi.unstubAllGlobals())

  it("still groups the inbox markup", async () => {
    const { doc, mountSidebar } = await load(`
      <div data-slot="sidebar-inbox">
        <div data-slot="sidebar-inbox-scroll">
          <div data-slot="sidebar-inbox-item"><span><span class="truncate">alpha</span></span><span>a1</span></div>
          <div data-slot="sidebar-inbox-item"><span><span class="truncate">alpha</span></span><span>a2</span></div>
        </div>
      </div>`)
    const handle = mountSidebar({ enabled: true })
    expect(doc.querySelectorAll("[data-router-heading]").length).toBe(1)
    handle.destroy()
  })
})

describe("home sidebar", () => {
  beforeEach(() => vi.unstubAllGlobals())

  it("groups home rows by their project label", async () => {
    const { doc, mountSidebar, probeSidebar } = await load(`
      <div data-slot="home-sessions-list">
        <div data-component="home-session-row-container" data-session-id="1">
          <span data-slot="home-session-label">alpha</span><span>a1</span>
        </div>
        <div data-component="home-session-row-container" data-session-id="2">
          <span data-slot="home-session-label">alpha</span><span>a2</span>
        </div>
      </div>`)
    const handle = mountSidebar({ enabled: true })
    expect(probeSidebar().surface).toBe("home")
    expect(doc.querySelectorAll("[data-router-heading]").length).toBe(1)
    handle.destroy()
  })
})

describe("honest failure", () => {
  beforeEach(() => vi.unstubAllGlobals())

  it("reports no surface at all when the app has none", async () => {
    const { probeSidebar, mountSidebar } = await load(`<div>nothing here</div>`)
    expect(probeSidebar()).toEqual({ surface: null, rows: 0, withProject: 0 })
    const handle = mountSidebar({ enabled: true })
    expect(handle.probe().surface).toBeNull()
    handle.destroy()
  })
})
