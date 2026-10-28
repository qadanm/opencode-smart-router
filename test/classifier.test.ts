import { describe, expect, it } from "vitest"
import { classifyTask } from "../src/core/classify/classifier.js"

describe("task classifier", () => {
  it("classifies a narrow CSS property change as economy mechanical work", () => {
    const task = classifyTask({ text: "Change the button background color to #2563eb in src/components/Button.tsx" })
    expect(task.tier).toBe(1)
    expect(task.kind).toBe("mechanical")
    expect(task.designIntensive).toBe(false)
    expect(task.signals).toContain("narrow_css")
  })

  it("ignores negative test instructions when scoping a CSS edit", () => {
    const task = classifyTask({
      text: "Change the body background color to #111111 in /tmp/project/style.css. Do not change anything else. Do not run tests.",
    })
    expect(task.tier).toBe(1)
    expect(task.kind).toBe("mechanical")
  })

  it("does not let the word simple hide a project-wide rename", () => {
    const task = classifyTask({ text: "Simple rename foo to bar everywhere in the project" })
    expect(task.tier).toBe(2)
    expect(task.signals).toContain("self_described_simple_ignored")
  })

  it("keeps an ordinary feature at the standard tier", () => {
    const task = classifyTask({
      text: "Implement a responsive settings page with theme switching, keyboard navigation, and loading and error states.",
    })
    expect(task.tier).toBe(2)
    expect(task.designIntensive).toBe(true)
    expect(task.sophisticatedDesign).toBe(false)
  })

  it("requires a premium design route for a sophisticated redesign with a mockup", () => {
    const task = classifyTask({
      text: "Redesign the landing page to match the attached Figma mockup. Improve typography, spacing, and responsive layout.",
      files: [{ uri: "file:///tmp/figma-mockup.png", name: "figma-mockup.png" }],
    })
    expect(task.tier).toBe(3)
    expect(task.designIntensive).toBe(true)
    expect(task.sophisticatedDesign).toBe(true)
    expect(task.requiresVision).toBe(true)
    expect(task.kind).toBe("design")
  })

  it("requires native vision for screenshot debugging without automatically requiring premium", () => {
    const task = classifyTask({
      text: "Debug this screenshot: the sidebar overlaps the header on small screens.",
      files: [{ uri: "file:///tmp/sidebar-screenshot.png", name: "sidebar-screenshot.png" }],
    })
    expect(task.requiresVision).toBe(true)
    expect(task.tier).toBe(2)
  })

  it("treats a trace without hard-debug signals as standard debugging", () => {
    const task = classifyTask({
      text: "Fix the failing login test in src/auth/login.test.ts\n\nTypeError: cannot read property 'id' of undefined\n    at login (src/auth/login.ts:42:11)",
    })
    expect(task.tier).toBe(2)
    expect(task.kind).toBe("debug")
    expect(task.scope.hasStackTrace).toBe(true)
  })

  it("raises intermittent production failures to premium", () => {
    const task = classifyTask({
      text: "This only fails in production intermittently. We see a deadlock in the queue worker after a few minutes.\n    at worker (src/queue.ts:18:7)",
    })
    expect(task.tier).toBe(3)
    expect(task.signals).toContain("hard_debug")
  })

  it("recognizes deterministic tooling work", () => {
    const task = classifyTask({ text: "Run the formatter and typecheck" })
    expect(task.tier).toBe(0)
    expect(task.kind).toBe("deterministic")
  })

  it("honors an explicit request for the strongest model", () => {
    const task = classifyTask({ text: "Use the strongest model to review this migration plan." })
    expect(task.tier).toBe(3)
    expect(task.constraints.requestPremium).toBe(true)
  })

  it("honors an explicit request to avoid premium", () => {
    const task = classifyTask({ text: "Use the cheapest model to rename foo to bar in src/a.ts" })
    expect(task.constraints.avoidPremium).toBe(true)
    expect(task.tier).toBe(1)
  })

  it("does not downgrade a broad theme change", () => {
    const task = classifyTask({ text: "Change the primary color across all themes and components" })
    expect(task.tier).toBe(2)
  })

  it("classifies architecture and security work as premium", () => {
    const architecture = classifyTask({
      text: "Design the multi-tenant authorization architecture for the API, including migration of existing sessions.",
    })
    expect(architecture.tier).toBe(3)
    expect(architecture.kind).toBe("architecture")

    const security = classifyTask({
      text: "Perform a security review and threat model for the OAuth callback and secrets management.",
    })
    expect(security.tier).toBe(3)
    expect(security.kind).toBe("security")
  })
})
