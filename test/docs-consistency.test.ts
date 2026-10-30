import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Documentation that states a test count drifts silently, and a wrong count
 * undermines every other number in the same document. This has already happened
 * twice in this repository: the README claimed 106 tests when the suite had 330,
 * and 330 when it had 344.
 *
 * The fix is not discipline, it is derivation. This checks the prose against
 * what is actually on disk.
 */

const root = new URL("../", import.meta.url)
const read = (relative: string) => readFileSync(new URL(relative, root), "utf8")

const testFileCount = readdirSync(new URL("test/", root)).filter((name: string) =>
  name.endsWith(".test.ts"),
).length

describe("documentation matches the repository", () => {
  it("the README test-file count is real", () => {
    // The count is inherently self-referential: adding this assertion changes
    // the total. Asserting exact equality would make the check fight itself, so
    // it asserts the README is within one of reality, which still catches the
    // drift that actually happens (a stale number from months ago).
    const readme = read("README.md")
    const match = /(\d+)\s+tests?\s+across\s+(\d+)\s+files?/i.exec(readme)
    expect(match, "README should state its test count").not.toBeNull()
    const claimedFiles = Number(match![2])
    expect(Math.abs(claimedFiles - testFileCount)).toBeLessThanOrEqual(1)
  })

  it("every documentation file avoids British spellings", () => {
    // The project standard is American English. This catches a stray spelling
    // added later far more reliably than reading the diff.
    const british = /\b(behaviour|colour|favour|honour|labour|neighbour|rumour|endeavour|flavour|travelling|travelled|cancelling|modelling|labelled|signalled|judgement|acknowledgement|programme|licence|defence|offence|practise|analyse|analysed|analysing|organis(e|ed|ing|ation)|recognis(e|ed|ing)|optimis(e|ed|ing|ation)|normalis(e|ed|ation)|normalisation|initialisation|serialisation|prioritisation|standardisation|customisation|characterisation|utilisation|centralisation|finalisation|authorisation|specialisation|visualisation|prioritis(e|ed)|serialis(e|ed)|summaris(e|ed)|initialis(e|ed)|minimis(e|ed)|maximis(e|ed)|emphasis(e|ed|ing)|standardis(e|ed)|customis(e|ed)|characteris(e|ed)|categoris(e|ed)|utilis(e|ed)|centralis(e|ed)|finalis(e|ed)|synchronis(e|ed)|authoris(e|ed)|unauthoris(e|ed)|criticis(e|ed)|specialis(e|ed)|visualis(e|ed)|memoris(e|ed)|apologis(e|ed)|catalogue|dialogue|grey|metre|litre|centre|fibre|theatre|sceptical|whilst|amongst|towards|learnt|spelt|enrolment|fulfil|instalment|practising|tyre|kerb|draught)\b/i

    // Derived from disk: a hand-maintained list silently skips a new document,
    // which is exactly how "normalisation" survived an earlier sweep.
    const files = [
      "README.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      ...readdirSync(new URL("docs/", root))
        .filter((name: string) => name.endsWith(".md"))
        .map((name: string) => `docs/${name}`),
    ]

    const offenders: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = read(file)
      } catch {
        continue
      }
      // Skip fenced code so a provider name or command is never rewritten.
      const prose = text.replace(/```[\s\S]*?```/g, "")
      const hit = british.exec(prose)
      if (hit) offenders.push(`${file}: "${hit[0]}"`)
    }
    expect(offenders).toEqual([])
  })

  it("public prose uses no em or en dashes", () => {
    // The house style is a comma, colon, or rewritten sentence. Dashes inside
    // code fences and inline code are exempt because they are often literal.
    const files = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "docs/LIMITATIONS.md", "docs/PROCESS-STATE.md"]
    const offenders: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = read(file)
      } catch {
        continue
      }
      const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "")
      const lines = prose.split("\n")
      lines.forEach((line, index) => {
        if (/[\u2014\u2013]/.test(line)) offenders.push(`${file}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
