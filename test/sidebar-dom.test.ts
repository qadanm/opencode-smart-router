import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The applier needs a DOM, and this test needs to prove the failure mode we care
 * about: an app update that changes the sidebar markup must leave the sidebar
 * alone rather than throwing or mangling rows.
 */
const inboxMarkup = (rows: Array<{ project: string; title: string; working?: boolean }>) => `
  <div data-slot="sidebar-inbox">
    <div data-slot="sidebar-inbox-scroll">
      ${rows
        .map(
          (row) => `<div data-slot="sidebar-inbox-item" data-status="${row.working ? "working" : "ready"}">
            <span><span class="truncate">${row.project}</span><span>now</span></span>
            <span>${row.title}</span>
          </div>`,
        )
        .join("")}
    </div>
  </div>
`

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
  // One module instance; `mountSidebar` holds no state between calls, so a
  // fresh DOM per test is enough isolation.
  const mod = await import("../src/gui/sidebar.js")
  return { doc: dom.window.document, mountSidebar: mod.mountSidebar }
}

describe("sidebar grouping", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("inserts a real heading only for projects with two or more sessions", async () => {
    const { doc, mountSidebar } = await load(
      inboxMarkup([
        { project: "alpha", title: "a1" },
        { project: "beta", title: "b1" },
        { project: "alpha", title: "a2" },
      ]),
    )
    const handle = mountSidebar({ enabled: true })
    const headings = [...doc.querySelectorAll("[data-router-heading]")].map((node) => node.textContent)
    expect(headings).toEqual(["alpha"])
    expect(doc.querySelector("[data-router-heading]")?.getAttribute("role")).toBe("heading")
    handle.destroy()
  })

  it("orders rows by project", async () => {
    const { doc, mountSidebar } = await load(
      inboxMarkup([
        { project: "alpha", title: "a1" },
        { project: "beta", title: "b1" },
        { project: "alpha", title: "a2" },
      ]),
    )
    const handle = mountSidebar({ enabled: true })
    const titles = [...doc.querySelectorAll('[data-slot="sidebar-inbox-item"]')].map(
      (row) => row.querySelector(":scope > span:nth-of-type(2)")?.textContent,
    )
    expect(titles).toEqual(["a1", "a2", "b1"])
    handle.destroy()
  })

  it("restores the app's markup on destroy", async () => {
    const { doc, mountSidebar } = await load(inboxMarkup([{ project: "alpha", title: "a1" }, { project: "alpha", title: "a2" }]))
    const handle = mountSidebar({ enabled: true })
    expect(doc.querySelectorAll("[data-router-heading]").length).toBe(1)
    handle.destroy()
    expect(doc.querySelectorAll("[data-router-heading]").length).toBe(0)
    expect(doc.querySelectorAll("[data-router-group]").length).toBe(0)
  })

  it("does nothing when grouping is disabled", async () => {
    const { doc, mountSidebar } = await load(inboxMarkup([{ project: "alpha", title: "a1" }, { project: "alpha", title: "a2" }]))
    const handle = mountSidebar({ enabled: false })
    expect(doc.querySelectorAll("[data-router-heading]").length).toBe(0)
    handle.destroy()
  })

  it("leaves rows alone when the app's markup no longer carries project names", async () => {
    // An app update removed the project badge: grouping must degrade quietly.
    const { doc, mountSidebar } = await load(`
      <div data-slot="sidebar-inbox">
        <div data-slot="sidebar-inbox-scroll">
          <div data-slot="sidebar-inbox-item"><span><span>now</span></span><span>a1</span></div>
          <div data-slot="sidebar-inbox-item"><span><span>now</span></span><span>a2</span></div>
        </div>
      </div>`)
    const handle = mountSidebar({ enabled: true })
    expect(doc.querySelectorAll("[data-router-heading]").length).toBe(0)
    expect(doc.querySelectorAll("[data-router-group]").length).toBe(0)
    handle.destroy()
  })

  it("adds a new-session control to a group heading", async () => {
    const onNewSession = vi.fn()
    const { doc, mountSidebar } = await load(inboxMarkup([{ project: "alpha", title: "a1" }, { project: "alpha", title: "a2" }]))
    const handle = mountSidebar({ enabled: true, onNewSession })
    const button = doc.querySelector("[data-router-heading] button") as HTMLButtonElement
    expect(button?.getAttribute("aria-label")).toBe("New session in alpha")
    button.click()
    expect(onNewSession).toHaveBeenCalledWith("alpha")
    handle.destroy()
  })
})
