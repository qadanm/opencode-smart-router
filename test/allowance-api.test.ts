import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  CONTEXT_SAFE_WINDOW_FRACTION,
  PLAN_CATALOG,
  decideCompaction,
  forecast,
  modelWindowCaps,
  resolvePlan,
} from "../src/allowance.js"

/**
 * The portable allowance core must stay portable.
 *
 * The value of extracting this surface is that it can be published and used
 * outside OpenCode, by someone who runs Claude Code or Codex or their own
 * agent. That property is easy to lose accidentally — one convenient
 * `import { something } from "../server/..."` and the package is no longer
 * host-agnostic. These tests fail if that happens.
 */

describe("portability boundary", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8")

  /**
   * Strip comments so documentation prose cannot satisfy or violate a code
   * assertion. The checks below are about what the module *does*, not about
   * what its doc block explains.
   */
  const stripComments = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")

  it("imports nothing from the host, the server, or a network client", () => {
    const entry = stripComments(read("../src/allowance.ts"))
    const imports = [...entry.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!)

    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) {
      // Only the pure core modules may be reached.
      expect(specifier).toMatch(/^\.\/core\/(plans\/catalog|context\/strategy|quota\/report|types)\.js$/)
    }
  })

  it("pulls in no node built-ins through the core modules it re-exports", () => {
    // `catalog.ts` must be dependency-free, and the other two may only
    // type-import. A runtime import of node:fs here would break browser use.
    const catalog = stripComments(read("../src/core/plans/catalog.ts"))
    expect(catalog).not.toMatch(/^import\s/m)

    for (const relative of ["../src/core/context/strategy.ts", "../src/core/quota/report.ts"]) {
      const source = stripComments(read(relative))
      const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gm)]
      expect(runtimeImports).toHaveLength(0)
    }
  })

  it("accepts only plain data, never a client, a key, or a filesystem handle", () => {
    const entry = stripComments(read("../src/allowance.ts"))
    // The public surface must not mention credentials or transport.
    expect(entry).not.toMatch(/\b(apiKey|Authorization|fetch|http|readFile|process\.env)\b/i)
  })
})

describe("the public API is usable on its own", () => {
  it("resolves a plan and derives its nested windows", () => {
    const plan = resolvePlan("opencode-go", "go")
    expect(plan).toBeDefined()

    const caps = modelWindowCaps(plan!, "deepseek-v4.1-flash")
    expect(caps).toEqual({ monthlyUsd: 80, weeklyUsd: 40, fiveHourUsd: 16 })
    // Nested, never additive.
    expect(caps.fiveHourUsd).toBeLessThan(caps.weeklyUsd)
    expect(caps.weeklyUsd).toBeLessThan(caps.monthlyUsd)
  })

  it("describes a two-pool plan without summing it", () => {
    const plan = resolvePlan("opendesign", "pro")!
    expect(plan.pools.map((pool) => pool.id)).toEqual(["design-plan", "plan-models"])
    const designPlan = plan.pools[0]!
    expect(designPlan.weeklyUsd).toBe(90)
    expect(designPlan.fiveHourUsd).toBeUndefined()
  })

  it("decides compaction from a plain context description", () => {
    const decision = decideCompaction({
      mode: "native",
      settings: {
        mode: "native",
        enabled: true,
        compactAtTokens: 0,
        cooldownMinutes: 10,
        allowEmergencyCompaction: true,
      },
      contextTokens: 100_000,
      effectiveWindow: 1_000_000,
    })
    expect(decision.compact).toBe(false)

    const overflow = decideCompaction({
      mode: "native",
      settings: {
        mode: "native",
        enabled: true,
        compactAtTokens: 0,
        cooldownMinutes: 10,
        allowEmergencyCompaction: true,
      },
      contextTokens: 1_000_000 * CONTEXT_SAFE_WINDOW_FRACTION,
      effectiveWindow: 1_000_000,
    })
    expect(overflow.compact).toBe(true)
    expect(overflow.hardLimit).toBe(true)
  })

  it("forecasts exhaustion from plain numbers", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0)
    const result = forecast({
      windowMs: 7 * 24 * 60 * 60 * 1000,
      now,
      spendInWindowUsd: 40,
      activityStart: now - 24 * 60 * 60 * 1000,
      remainingUsd: 10,
      label: "weekly",
    })
    expect(result.willExhaust).toBe(true)
    expect(result.exhaustsAt).toBeGreaterThan(now)
  })

  it("ships a catalog that is internally consistent", () => {
    // A published catalog with an impossible window would mislead every
    // consumer, so the invariant is asserted as part of the API surface.
    for (const plan of PLAN_CATALOG) {
      for (const pool of plan.pools) {
        if (pool.weeklyUsd !== undefined) expect(pool.weeklyUsd).toBeLessThanOrEqual(pool.monthlyUsd)
        if (pool.fiveHourUsd !== undefined) {
          expect(pool.fiveHourUsd).toBeLessThanOrEqual(pool.weeklyUsd ?? pool.monthlyUsd)
        }
      }
    }
  })
})
