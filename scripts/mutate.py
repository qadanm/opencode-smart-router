#!/usr/bin/env python3
"""
Mutation harness for the router's safety properties.

Each entry breaks one property in the source and names the test file that is
supposed to catch it. A mutation that does NOT make the suite fail means the
test asserting that property is vacuous, which is worse than no test at all
because it reports safety that was never checked.

Run from the repository root:  python3 scripts/mutate.py
Exits non-zero if any property is unguarded.
"""

import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Mutation:
    name: str
    path: str
    old: str
    new: str
    test: str


MUTATIONS = [
    # ---------------------------------------------------------------- discovery
    Mutation(
        "credential discovery becomes implicit",
        "src/core/quota/credentials.ts",
        'if (configured) return configured',
        'if (configured) return configured\n  return "auto"',
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "environment flag no longer enables discovery",
        "src/core/quota/credentials.ts",
        'if (flag === "1" || flag === "true" || flag === "yes") return "auto"',
        'if (flag === "1" || flag === "true" || flag === "yes") return "explicit"',
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "policy 'off' still reads disk",
        "src/core/quota/credentials.ts",
        'if (policy === "off") {',
        'if (false) {',
        "test/credentials-security.test.ts",
    ),
    # ------------------------------------------------------------ file hardening
    Mutation(
        "symlink protection removed",
        "src/core/quota/credentials.ts",
        "constants.O_RDONLY | constants.O_NOFOLLOW",
        "constants.O_RDONLY",
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "group/world permission check removed",
        "src/core/quota/credentials.ts",
        "if ((stat.mode & 0o077) !== 0) {",
        "if (false) {",
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "uid ownership check removed for discovered files",
        "src/core/quota/credentials.ts",
        "if (!explicit && typeof process.getuid === \"function\" && stat.uid !== process.getuid()) {",
        "if (false) {",
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "uid check incorrectly applied to named files",
        "src/core/quota/credentials.ts",
        "if (!explicit && typeof process.getuid === \"function\" && stat.uid !== process.getuid()) {",
        "if (typeof process.getuid === \"function\" && stat.uid !== process.getuid()) {",
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "size cap removed",
        "src/core/quota/credentials.ts",
        "if (stat.size > MAX_CREDENTIAL_FILE_BYTES) {",
        "if (false) {",
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "descriptor closed path removed (fd leak)",
        "src/core/quota/credentials.ts",
        "if (fd !== undefined) {",
        "if (false) {",
        "test/credentials-security.test.ts",
    ),
    # ------------------------------------------------------------- path leakage
    Mutation(
        "credential source leaks the full path",
        "src/core/quota/credentials.ts",
        '    const base = segments[segments.length - 1] ?? "file"\n    return `file (${base})`',
        '    return `file (${candidate.path})`',
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "unrecognised credential source echoed verbatim",
        "src/core/quota/credentials.ts",
        '      // Never echo an unrecognized source string.\n      return "configured"',
        '      return candidate.source',
        "test/credentials-security.test.ts",
    ),
    Mutation(
        "Command Code note prints the raw source path",
        "src/core/quota/commandcode.ts",
        "notes.push(`Credential source: ${describeCredentialSource(authorized)}`)",
        "notes.push(`Credential source: ${authorized.source}`)",
        "test/credentials-security.test.ts",
    ),
    # --------------------------------------------------------------- plan safety
    Mutation(
        "unknown plan silently falls back to the default tier",
        "src/core/plans/catalog.ts",
        '    // Configured but unrecognized: refuse to guess a tier.\n    return { plan: undefined, resolution: "unknown", planID: undefined }',
        '    const fallback = DEFAULT_PLAN_ID[providerID]\n    return { plan: fallback ? PLAN_BY_KEY.get(`${providerID}/${fallback}`) : undefined, resolution: "unknown", planID: fallback }',
        "test/plans.test.ts",
    ),
    Mutation(
        "describePlan echoes the configured id",
        "src/core/util.ts",
        '  return configured ? `unresolved (${configured})` : "unresolved"',
        '  return configured || "unresolved"',
        "test/plan-display.test.ts",
    ),
    Mutation(
        "unresolved plan reports a fabricated zero balance",
        "src/core/quota/opendesign.ts",
        "...(caps.unresolved ? {} : { monthlyRemainingUsd: Math.max(0, caps.monthly - totals.monthlyUsd) }),",
        "monthlyRemainingUsd: Math.max(0, caps.monthly - totals.monthlyUsd),",
        "test/pro-routing.test.ts",
    ),
    Mutation(
        "unresolved plan reports a pristine 0%-used allowance",
        "src/core/quota/opendesign.ts",
        "  const monthly = caps.unresolved\n    ? { ...unknownWindow, usedUsd: totals.monthlyUsd }\n    : windowFrom(totals.monthlyUsd, caps.monthly, undefined, \"estimate\")",
        "  const monthly = windowFrom(totals.monthlyUsd, caps.monthly, undefined, \"estimate\")",
        "test/pro-routing.test.ts",
    ),
    Mutation(
        "unresolved plan reported as exhausted",
        "src/core/quota/opendesign.ts",
        '  if (caps.unresolved) return { snapshot, state: "unknown" }',
        '  if (caps.unresolved) return { snapshot, state: "exhausted" }',
        "test/pro-routing.test.ts",
    ),
    Mutation(
        "valid plan reported as unresolved",
        "src/core/quota/opencode-go.ts",
        'plan: describePlan(resolvePlan("opencode-go", input.settings.plan)?.planID, input.settings.plan),',
        'plan: describePlan(undefined, input.settings.plan),',
        "test/plan-display.test.ts",
    ),
    # ----------------------------------------------------------- context warning
    Mutation(
        "context-driven switch is silent",
        "src/core/routing/engine.ts",
        "  if (displaced) {\n    const sameName",
        "  if (false) {\n    const sameName",
        "test/pro-routing.test.ts",
    ),
    Mutation(
        "warning fires for a model that was never cheaper",
        "src/core/routing/engine.ts",
        "      entry.usd < chosen.candidate.estimatedUsd,",
        "      true,",
        "test/pro-routing.test.ts",
    ),
    Mutation(
        "warning compares against task tier instead of chosen model",
        "src/core/routing/engine.ts",
        "      entry.tier >= chosen.model.tier &&",
        "      entry.tier >= input.task.tier &&",
        "test/pro-routing.test.ts",
    ),
    Mutation(
        "warning omits the provider when names collide",
        "src/core/routing/engine.ts",
        '    const label = sameName ? `${displaced.model.name} on ${displaced.model.providerID}` : displaced.model.name',
        "    const label = displaced.model.name",
        "test/pro-routing.test.ts",
    ),
    # ------------------------------------------------------------ portability
    Mutation(
        "allowance core reaches into the host",
        "src/allowance.ts",
        '} from "./core/plans/catalog.js"',
        '} from "./core/plans/catalog.js"\nexport { readCredentialFile } from "./core/quota/credentials.js"',
        "test/allowance-api.test.ts",
    ),
    Mutation(
        "allowance core imports a node builtin",
        "src/core/quota/report.ts",
        'import type { UsageEvent } from "../types.js"',
        'import type { UsageEvent } from "../types.js"\nimport { homedir } from "node:os"\nexport const home = homedir()',
        "test/allowance-api.test.ts",
    ),
    # ------------------------------------------------------- OpenDesign honesty
    Mutation(
        "estimated quota claims provider authority",
        "src/core/quota/opendesign.ts",
        '  const weekly = caps.weekly !== undefined\n    ? windowFrom(totals.weeklyUsd, caps.weekly, undefined, "estimate")',
        '  const weekly = caps.weekly !== undefined\n    ? windowFrom(totals.weeklyUsd, caps.weekly, undefined, "provider")',
        "test/opendesign-quota-honesty.test.ts",
    ),
    Mutation(
        "estimated state reported as verified",
        "src/core/quota/opendesign.ts",
        '  return { snapshot, state: exhausted ? "exhausted" : "estimated" }',
        '  return { snapshot, state: "verified" }',
        "test/opendesign-quota-honesty.test.ts",
    ),
    Mutation(
        "a plan window that does not exist reported as a measured zero",
        "src/core/quota/opendesign.ts",
        '    : { ...unknownWindow, usedUsd: totals.rollingUsd }',
        '    : windowFrom(totals.rollingUsd, 0, undefined, "estimate")',
        "test/opendesign-quota-honesty.test.ts",
    ),
    Mutation(
        "measured model falls back to the advisory budget",
        "src/core/providers/opendesign.ts",
        "    const reported = measured ? vendorLimit : (model.contextBudget ?? vendorLimit)",
        "    const reported = model.contextBudget ?? vendorLimit",
        "test/opendesign-context-limit.test.ts",
    ),
    Mutation(
        "an unmeasured model is given the full vendor window",
        "src/core/providers/opendesign.ts",
        "    const reported = measured ? vendorLimit : (model.contextBudget ?? vendorLimit)",
        "    const reported = vendorLimit",
        "test/opendesign-context-limit.test.ts",
    ),
    Mutation(
        "budget allowed to exceed the vendor limit",
        "src/core/providers/opendesign.ts",
        "      reported > 0 && (vendorLimit === 0 || reported <= vendorLimit)",
        "      reported > 0",
        "test/opendesign-context-limit.test.ts",
    ),
    # ------------------------------------------------------ Go to Pro migration
    Mutation(
        "Go-era default mode returns",
        "src/core/config.ts",
        '    mode: "native",\n    enabled: true,\n    compactAtTokens: 0,',
        '    mode: "budget-optimized",\n    enabled: true,\n    compactAtTokens: 50_000,',
        "test/go-to-pro-migration.test.ts",
    ),
    Mutation(
        "native mode honours the old early-compaction knob",
        "src/core/context/strategy.ts",
        '    if (!overflow) return no("Native mode: the transcript fits the verified window.")',
        '    if (!overflow && contextTokens < (settings.compactAtTokens || Infinity)) return no("Native mode: the transcript fits the verified window.")',
        "test/go-to-pro-migration.test.ts",
    ),
    Mutation(
        "unknown plan falls back to a default tier",
        "src/core/plans/catalog.ts",
        '    // Configured but unrecognized: refuse to guess a tier.\n    return { plan: undefined, resolution: "unknown", planID: undefined }',
        '    const fb = DEFAULT_PLAN_ID[providerID]\n    return { plan: fb ? PLAN_BY_KEY.get(`${providerID}/${fb}`) : undefined, resolution: "unknown", planID: fb }',
        "test/go-to-pro-migration.test.ts",
    ),
    # --------------------------------------------------- shared context ceiling
    Mutation(
        "routing gate reverts to hardcoded 20k margin and 0.95 fraction",
        "src/core/policy/eligibility.ts",
        "Math.max(input.contextTokens, task.scope.promptTokens) + replyMarginFor(model.context)",
        "Math.max(input.contextTokens, task.scope.promptTokens) + 20_000",
        "test/context-ceiling-contract.test.ts",
    ),
    Mutation(
        "reply margin silently shrinks toward the provider limit",
        "src/core/context/strategy.ts",
        "export const CONTEXT_ELIGIBILITY_MARGIN_TOKENS = 20_000",
        "export const CONTEXT_ELIGIBILITY_MARGIN_TOKENS = 5_000",
        "test/context-ceiling-contract.test.ts",
    ),
    Mutation(
        "safety fraction silently rises toward the provider limit",
        "src/core/context/strategy.ts",
        "export const CONTEXT_SAFE_WINDOW_FRACTION = 0.95",
        "export const CONTEXT_SAFE_WINDOW_FRACTION = 0.999",
        "test/context-ceiling-contract.test.ts",
    ),
    # ------------------------------------------------------------------ calibration
    Mutation(
        "calibration invents a floor from thin evidence",
        "src/core/policy/calibration.ts",
        "if (totalRequests < MIN_REQUESTS_FOR_COST_EVIDENCE) {",
        "if (totalRequests < 0) {",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "calibration may raise the floor above the configured value",
        "src/core/policy/calibration.ts",
        "const bounded = Math.min(configured, Math.max(best.model.intelligence, configured - MAX_CALIBRATION_DROP))",
        "const bounded = Math.max(configured, best.model.intelligence)",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "calibration is unbounded downwards",
        "src/core/policy/calibration.ts",
        "Math.max(best.model.intelligence, configured - MAX_CALIBRATION_DROP)",
        "best.model.intelligence",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "calibration admits escalation-pool models",
        "src/core/policy/calibration.ts",
        ".filter((model) => !model.escalationOnly && !model.premium)",
        ".filter(() => true)",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "calibration calibrates on unmeasured models",
        "src/core/policy/calibration.ts",
        "return measured === undefined ? undefined : { model, cost: measured }",
        "return { model, cost: measured ?? 0 }",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "zero-cost traffic is treated as free inference",
        "src/core/policy/calibration.ts",
        "if (!Number.isFinite(baseline) || baseline <= 0) {",
        "if (!Number.isFinite(baseline)) {",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "calibration cannot be switched off",
        "src/core/policy/calibration.ts",
        "if (settings.routing.calibrateFloor !== true) return base",
        "if (false) return base",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "calibration leaks into offline mode",
        "src/core/policy/calibration.ts",
        "return off ? base : result",
        "return result",
        "test/calibration-policy.test.ts",
    ),
    Mutation(
        "the success estimate ignores the floor in force",
        "src/core/routing/engine.ts",
        "const floor = input.intelligenceFloor ?? 39.5",
        "const floor = 39.5",
        "test/calibration-routing.test.ts",
    ),
    Mutation(
        "the eligibility gate ignores the resolved floor",
        "src/core/policy/eligibility.ts",
        "const floor = input.intelligenceFloor ?? settings.routing.intelligenceFloor",
        "const floor = settings.routing.intelligenceFloor",
        "test/calibration-routing.test.ts",
    ),
    # ------------------------------------------------------- provider scope
    Mutation(
        "a saturated gateway forgets to hold the refusing endpoint back",
        "src/core/quota/ledger.ts",
        "if (options.saturation && model) {\n      this.armModelCooldown(model, options.cooldownMs ?? 0, 1)",
        "if (options.saturation && model) {\n      void 0",
        "test/provider-scope.test.ts",
    ),
    Mutation(
        "a saturated gateway never steps the whole provider back",
        "src/core/quota/ledger.ts",
        "if ((options.providerScoped || options.saturation) && model) {",
        "if (options.providerScoped && !options.saturation && model) {",
        "test/provider-scope.test.ts",
    ),
    Mutation(
        "saturated gateways pollute the model's reliability record",
        "src/core/quota/ledger.ts",
        "if (options.saturation && model) {\n      this.armModelCooldown(model, options.cooldownMs ?? 0, 1)",
        "if (false && options.saturation && model) {\n      this.armModelCooldown(model, options.cooldownMs ?? 0, 1)",
        "test/provider-scope.test.ts",
    ),
    Mutation(
        "saturation is never detected at all",
        "src/core/failures.ts",
        "const upstreamSaturation =\n    includes(message, [",
        "const upstreamSaturation = false &&\n    includes(message, [",
        "test/provider-scope.test.ts",
    ),
    Mutation(
        "the provider scope over-reaches into single-model stream failures",
        "src/core/failures.ts",
        "]) || (type.includes(\"upstream\") && includes(message, [\"busy\", \"capacity\"]))",
        "]) || streamFailure",
        "test/provider-scope.test.ts",
    ),
    Mutation(
        "one busy blip takes out the whole provider",
        "src/core/quota/ledger.ts",
        "if (streak >= PROVIDER_DOWN_STREAK) {",
        "if (streak >= 1) {",
        "test/provider-scope.test.ts",
    ),
    # --------------------------------------------------------- quota expiry
    # --------------------------------------------- folded usage history
    Mutation(
        "the quota probe reads raw events only, ignoring folded history",
        "src/core/quota/ledger.ts",
        "    return [...folded, ...raw].sort((a, b) => a.at - b.at)",
        "    return raw",
        "test/usage-history.test.ts",
    ),
    Mutation(
        "folded buckets are dropped when a window is requested",
        "src/core/quota/ledger.ts",
        "    const buckets = this.ledger.usageRollup?.buckets",
        "    const buckets = undefined as typeof this.ledger.usageRollup.buckets",
        "test/usage-history.test.ts",
    ),
    Mutation(
        "the quota probe asks for no window, so folded history is invisible",
        "src/core/quota/service.ts",
        "        usage: this.options.getUsageEvents?.({ since: now - OPENDESIGN_MONTH_MS, until: now }) ?? [],",
        "        usage: this.options.getUsageEvents?.() ?? [],",
        "test/quota-service.test.ts",
    ),
    # -------------------------------------------- switch penalty accounting
    Mutation(
        "the reported switch penalty charges the whole context, not the cached share",
        "src/core/routing/engine.ts",
        "    : Math.max(0, (context * CACHE_REUSE_SHARE * (inputPrice - cacheReadPrice)) / 1_000_000)",
        "    : Math.max(0, (context * (inputPrice - cacheReadPrice)) / 1_000_000)",
        "test/switch-penalty.test.ts",
    ),
    Mutation(
        "switching is modelled as free, so the estimate ignores cache loss",
        "src/core/routing/engine.ts",
        "  const cachedShare = sameModel ? CACHE_REUSE_SHARE : 0",
        "  const cachedShare = CACHE_REUSE_SHARE",
        "test/switch-penalty.test.ts",
    ),
    # ------------------------------------------- expiring allowance pricing
    Mutation(
        "expiring allowance is priced as fresh money, ignoring the burn rate",
        "src/core/policy/eligibility.ts",
        "  if (waste <= 0) return 1\n  // Bounded well below one so expiring quota is cheap, never free.\n  return 1 - MARGINAL_PRICE_DISCOUNT_MAX * waste",
        "  if (waste <= 0) return 1\n  return 1",
        "test/quota-waste.test.ts",
    ),
    Mutation(
        "the marginal price is applied to pressure instead of to price",
        "src/core/routing/engine.ts",
        "    (estimate.usd * marginalPriceFactor * (1 + (1 - probability) * 2)) * pressure * speedFactor",
        "    (estimate.usd * (1 + (1 - probability) * 2)) * pressure * speedFactor",
        "test/quota-waste-safety.test.ts",
    ),
    Mutation(
        "waste ignores the burn rate and reads the window as already abandoned",
        "src/core/policy/eligibility.ts",
        "    const projectedSpend = burnPerMs * remainingMs",
        "    const projectedSpend = 0",
        "test/quota-waste.test.ts",
    ),
    Mutation(
        "an untouched pool counts as expiring waste",
        "src/core/policy/eligibility.ts",
        "    if (window.usedPct <= 0) continue",
        "    if (window.usedPct < 0) continue",
        "test/quota-waste.test.ts",
    ),
    # ------------------------------------------- quota fail-closed
    Mutation(
        "a probe-enabled provider with no reading yet is assumed to have room",
        "src/core/policy/eligibility.ts",
        "    if (expectedProbe && quotaIsKnown) {",
        "    if (false) {",
        "test/quota-fail-closed.test.ts",
    ),
    # ------------------------------------------- host survival contract
    Mutation(
        "an internal defect blocks the prompt again (the 0.6.0 default)",
        "src/core/config.ts",
        "    failClosed: false,",
        "    failClosed: true,",
        "test/fail-open-contract.test.ts",
    ),
    Mutation(
        "an inherited shared core is adopted regardless of its version",
        "src/server/shared-core.ts",
        "  existing && existing.apiVersion === SHARED_CORE_API",
        "  existing",
        "test/shared-core-adoption.test.ts",
    ),
    Mutation(
        "a hook may throw into the host",
        "src/server/containment.ts",
        "      if (options.allowBlocked && isBlocked(error)) throw error\n      report(`${options.label}: ${describe(error)}`)",
        "      throw error",
        "test/containment.test.ts",
    ),
    Mutation(
        "a hook may hang on the host indefinitely",
        "src/server/containment.ts",
        "  try {\n    return (await Promise.race([work, deadline])) as T | undefined",
        "  try {\n    return (await work) as T | undefined",
        "test/containment.test.ts",
    ),
    Mutation(
        "candidates include models the host cannot serve",
        "src/server/controller.ts",
        "    return approved.filter((model) => servable.has(model.key))",
        "    return approved",
        "test/routing-servable-models.test.ts",
    ),
    Mutation(
        "an empty candidate list falls back to the unfiltered catalog",
        "src/server/controller.ts",
        "    return approved.filter((model) => servable.has(model.key))",
        "    const filtered = approved.filter((model) => servable.has(model.key))\n    return filtered.length > 0 ? filtered : approved",
        "test/routing-servable-models.test.ts",
    ),
    Mutation(
        "a failed setup installs a blocking prompt hook",
        "src/index.ts",
        "      sharedCore.recordError(`setup ${ctx.location?.directory ?? \"\"}: ${describe(error)}`)\n      await controller.dispose().catch(() => undefined)\n      return () => undefined",
        "      sharedCore.recordError(`setup: ${describe(error)}`)\n      await controller.dispose().catch(() => undefined)\n      await ctx.session.hook(\"prompt\", async () => { throw new Error(\"setup failed\") })\n      return () => undefined",
        "test/setup-failure-never-blocks.test.ts",
    ),
]

def run_tests(test: str) -> bool:
    """Return True when the suite PASSES."""
    result = subprocess.run(
        ["npx", "vitest", "run", test],
        capture_output=True,
        text=True,
        timeout=600,
    )
    return result.returncode == 0


def main() -> int:
    unguarded: list[str] = []
    broken: list[str] = []

    for index, mutation in enumerate(MUTATIONS, start=1):
        with open(mutation.path, encoding="utf-8") as handle:
            original = handle.read()

        if mutation.old not in original:
            broken.append(f"{mutation.name} ({mutation.path}: pattern not found)")
            print(f"[{index:2d}/{len(MUTATIONS)}] SKIP  {mutation.name} - pattern not found")
            continue

        mutated = original.replace(mutation.old, mutation.new, 1)
        if mutated == original:
            broken.append(f"{mutation.name} (replacement had no effect)")
            print(f"[{index:2d}/{len(MUTATIONS)}] SKIP  {mutation.name} - no-op")
            continue

        try:
            with open(mutation.path, "w", encoding="utf-8") as handle:
                handle.write(mutated)
            passed = run_tests(mutation.test)
        finally:
            with open(mutation.path, "w", encoding="utf-8") as handle:
                handle.write(original)

        if passed:
            unguarded.append(f"{mutation.name} -> {mutation.test} still passes")
            print(f"[{index:2d}/{len(MUTATIONS)}] VACUOUS  {mutation.name}")
        else:
            print(f"[{index:2d}/{len(MUTATIONS)}] caught   {mutation.name}")

    print()
    if broken:
        print("Harness problems (mutation could not be applied):")
        for entry in broken:
            print(f"  - {entry}")
        print()

    if unguarded:
        print(f"UNGUARDED PROPERTIES ({len(unguarded)}):")
        for entry in unguarded:
            print(f"  - {entry}")
        return 1

    print(f"All {len(MUTATIONS)} mutated properties are caught by the suite.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
