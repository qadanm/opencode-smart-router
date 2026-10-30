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
        "vendor limit used instead of the advertised budget",
        "src/core/providers/opendesign.ts",
        "    const reported = model.contextBudget ?? vendorLimit",
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
