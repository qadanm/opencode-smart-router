import { parseResetIn } from "./config-writer.js"

/**
 * Read any pasted OpenDesign console page and decide what it is.
 *
 * One normalisation pass, then a set of matchers run in confidence order. A
 * user copies whatever page they happen to be on — Plan & balance, Usage,
 * Billing — and the router works out which it got. Asking someone to choose the
 * right page first is a step that exists only because the software was not
 * paying attention.
 *
 * The two readings are different in kind and are kept apart deliberately:
 *
 *   - **allowance** (Plan & balance): a percentage of a window. Cheap to
 *     produce, and the starting point for every estimate.
 *   - **usage** (Usage page): per-model tokens and, when the page shows it,
 *     credits or dollars actually charged.
 *
 * Neither is trusted over the other. A usage reading that agrees with the
 * current estimate confirms it; one that disagrees is evidence the cost model is
 * wrong, and that is worth knowing rather than averaging away.
 */

export interface AllowanceReading {
  readonly kind: "allowance"
  readonly plan?: string
  readonly designPlanUsedPct?: number
  readonly pctOf?: "weekly" | "monthly"
  readonly resetsAt?: number
  readonly periodEndsAt?: number
  readonly walletUsd?: number
  readonly found: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
}

export interface UsageModelRow {
  readonly modelName?: string
  /** Present when the page shows token counts. */
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  /** Present when the page shows credits or dollars. */
  readonly chargedUsd?: number
}

export interface UsageReading {
  readonly kind: "usage"
  readonly rows: ReadonlyArray<UsageModelRow>
  readonly totalUsd?: number
  readonly periodStart?: number
  readonly periodEnd?: number
  readonly found: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
}

export type ConsoleReading = AllowanceReading | UsageReading

const normalize = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    // Keep line structure; both pages are block-oriented and collapsing newlines
    // would let a value from one card satisfy a label from another.
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")

const numberFrom = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  // "1,234.5" and "1 234,5" both appear in localised consoles.
  const cleaned = raw.replace(/,/g, "".replace(/x/, ""))
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}

const CARD_LABELS = [
  /Design Plan credits/i,
  /Pay-as-you-go credits/i,
  /Credit breakdown/i,
  /Auto top-up/i,
  /Top up/i,
  /Reset cards/i,
  /Manage subscription/i,
  /Total/i,
]

/** The text belonging to one card: its label up to the next card or blank line. */
const cardAfter = (text: string, label: RegExp, limit = 200): string | undefined => {
  const start = label.exec(text)
  if (!start) return undefined
  const rest = text.slice(start.index + start[0].length)
  let end = Math.min(rest.length, limit)
  for (const heading of CARD_LABELS) {
    if (heading.source === label.source) continue
    const found = heading.exec(rest)
    if (found && found.index > 0) end = Math.min(end, found.index)
  }
  const blank = rest.indexOf("\n\n")
  if (blank > 0) end = Math.min(end, blank)
  return rest.slice(0, end)
}

const inCard = (text: string, label: RegExp, pattern: RegExp, limit = 200): string | undefined => {
  const block = cardAfter(text, label, limit)
  return block === undefined ? undefined : pattern.exec(block)?.[1]?.trim() || undefined
}

// ---------------------------------------------------------------------------
// Allowance: the Plan & balance page
// ---------------------------------------------------------------------------

const readAllowance = (text: string, now: number): AllowanceReading | undefined => {
  const designPct = numberFrom(inCard(text, /Design Plan credits/i, /(\d{1,3})\s*%/, 120))
  // An allowance page without a percentage is not an allowance page.
  if (designPct === undefined) return undefined

  const found = ["Design Plan usage"]
  const missing: string[] = []

  const planLine = /^\s*(Go|Plus|Pro|Max)\s*$/m.exec(text)?.[1]
  if (planLine) found.push("plan")
  else missing.push("plan")

  let pctOf: "weekly" | "monthly" | undefined
  if (/\d+\s*days?\s*of\s*quota/i.test(text) || /seven[-\s]?day/i.test(text)) pctOf = "weekly"
  else if (/monthly\s*(allowance|quota|credits)/i.test(text)) pctOf = "monthly"
  if (pctOf) found.push("allowance window")

  const resetText = /\bReset in\s+([0-9]+\s*(?:days?|hours?|minutes?)[^\n]*)/i.exec(text)?.[1]
  const resetsAt = resetText ? parseResetIn(resetText, now) : undefined
  if (resetsAt !== undefined) found.push("reset time")
  else missing.push("reset time")

  const periodText = /This period ends on\s+([A-Z][a-z]+ \d{1,2},\s*\d{4})/i.exec(text)?.[1]
  const periodEndsAt = periodText ? Date.parse(periodText) : undefined
  if (periodEndsAt !== undefined && Number.isFinite(periodEndsAt)) found.push("billing period")
  else missing.push("billing period")

  const wallet = numberFrom(inCard(text, /Pay-as-you-go credits/i, /\$\s*([\d,]+(?:\.\d{1,2})?)/, 120))
  if (wallet !== undefined) found.push("wallet balance")
  else missing.push("wallet balance")

  return {
    kind: "allowance",
    ...(planLine ? { plan: planLine } : {}),
    designPlanUsedPct: Math.min(100, Math.max(0, designPct)),
    ...(pctOf ? { pctOf } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(periodEndsAt !== undefined && Number.isFinite(periodEndsAt) ? { periodEndsAt } : {}),
    ...(wallet !== undefined ? { walletUsd: wallet } : {}),
    found,
    missing,
  }
}

// ---------------------------------------------------------------------------
// Usage: the console's usage table
// ---------------------------------------------------------------------------

const datePatterns = [
  /\b([A-Z][a-z]{2} \d{1,2},? \d{4})\b/,
  /\b(\d{4}-\d{2}-\d{2})\b/,
  /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/,
]

/**
 * A usage row looks like: model name, then some numbers, one of which may be a
 * dollar amount. Columns are separated by whitespace or tabs once the page is
 * normalised, and the order varies, so a row is recognised by its shape rather
 * than by fixed positions.
 */
const parseUsageRow = (line: string): UsageModelRow | undefined => {
  const usd = /\$\s*([\d,]+(?:\.\d{1,4})?)/.exec(line)?.[1]
  const numerics = [...line.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\b/g)]
    .map((m) => Number(m[1]!.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n))

  // A row needs at least one number to be a usage row.
  if (numerics.length === 0 && usd === undefined) return undefined

  // The name is the leading text before the first number.
  const firstNumberIndex = line.search(/\d/)
  const name = firstNumberIndex > 2 ? line.slice(0, firstNumberIndex).trim().replace(/[-–—|:]+$/, "").trim() : undefined
  if (!name || name.length < 2) return undefined
  // Headers and navigation are not rows.
  if (/^(model|member|caller|total|time|date|usage|credits|tokens|input|output|cached)$/i.test(name)) return undefined

  const chargedUsd = usd !== undefined ? numberFrom(usd) : undefined
  // Without a dollar column the numbers are tokens. Big numbers are tokens;
  // small ones are more likely percentages or counts, which are not useful here.
  const tokenCandidate = numerics.filter((n) => n >= 1_000)

  return {
    modelName: name,
    ...(chargedUsd !== undefined ? { chargedUsd } : {}),
    ...(tokenCandidate[0] !== undefined ? { inputTokens: tokenCandidate[0] } : {}),
    ...(tokenCandidate[1] !== undefined ? { outputTokens: tokenCandidate[1] } : {}),
    ...(tokenCandidate[2] !== undefined ? { cacheReadTokens: tokenCandidate[2] } : {}),
  }
}

/**
 * Usage rows, in the shape a person's clipboard actually produces.
 *
 * Copying a table gives the cells on separate lines — model name, then each
 * number, then the next model. Copying a row gives them on one line. Both are
 * accepted: the parser tracks a current row and attaches numbers to it until the
 * next name appears.
 */
const HEADER = /^(model|member|caller|time|date|usage|credits?|tokens?|input|output|cached|cost|total|range|period)$/i
const NOISE = /^(usage|billing|plan & balance|api keys|members|settings|open design|invite colleagues|pricing|arena|models & pricing|help & docs|top up|credit breakdown|auto top-up|reset cards|manage subscription|upgrade)$/i

const looksLikeNumber = (line: string): boolean => /^\$?\s*[\d,]+(\.\d+)?%?$/.test(line)
const looksLikeName = (line: string): boolean =>
  !looksLikeNumber(line) && !HEADER.test(line) && !NOISE.test(line) && /[A-Za-z]/.test(line) && line.length >= 2 && line.length <= 60

const readUsage = (text: string, now: number): UsageReading | undefined => {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  const rows: UsageModelRow[] = []

  let name: string | undefined
  let nums: number[] = []
  let usd: number | undefined

  const flush = () => {
    if (!name || (nums.length === 0 && usd === undefined)) {
      name = undefined
      nums = []
      usd = undefined
      return
    }
    // Token counts are large; percentages and small counts are not usage.
    const tokens = nums.filter((n) => n >= 1_000)
    rows.push({
      modelName: name,
      ...(usd !== undefined ? { chargedUsd: usd } : {}),
      ...(tokens[0] !== undefined ? { inputTokens: tokens[0] } : {}),
      ...(tokens[1] !== undefined ? { outputTokens: tokens[1] } : {}),
      ...(tokens[2] !== undefined ? { cacheReadTokens: tokens[2] } : {}),
    })
    name = undefined
    nums = []
    usd = undefined
  }

  const DATE_LINE = /\b\d{4}\b.*\b\d{4}\b|\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/
  // A name followed by whitespace-separated numeric tokens, e.g.
  // "GLM-5.3 Flash 2,000,000 $0.15". The trailing group must be numbers only:
  // "DeepSeek V4.1 Flash" ends in letters and is therefore a name, not a row.
  const INLINE = /^(.+?)\s+((?:\$?[\d,]+(?:\.\d+)?%?\s*)+)$/

  for (const line of lines) {
    // A date range is period information, not a usage row.
    if (DATE_LINE.test(line)) continue

    const dollarOnly = /^\$\s*([\d,]+(?:\.\d{1,4})?)$/.exec(line)
    if (dollarOnly) {
      // A second dollar figure while a row is still open belongs to a new row
      // (the Total line), not to the one in progress. Without this the total
      // overwrites the last model's charge and every reconciliation after it is
      // wrong in a way that looks like a catalog error.
      if (usd !== undefined) {
        flush()
      }
      usd = numberFrom(dollarOnly[1])
      continue
    }
    if (looksLikeNumber(line)) {
      const value = Number(line.replace(/[$,%]/g, ""))
      if (Number.isFinite(value)) nums.push(value)
      continue
    }

    const inline = INLINE.exec(line)
    // A trailing "5.5" is part of a model name ("Claude Haiku 5.5"), not a
    // measurement. An inline row must carry a dollar amount or a real token
    // count; anything smaller is version numbering.
    const trailing = inline?.[2] ?? ""
    const carriesData = /\$\s*\d/.test(trailing) || /\d{4,}/.test(trailing) || /\d{1,3}(?:,\d{3})+/.test(trailing)
    if (inline && carriesData) {
      const candidate = inline[1]!.trim()
      if (looksLikeName(candidate)) {
        flush()
        const dollar = /\$\s*([\d,]+(?:\.\d{1,4})?)/.exec(inline[2]!)
        usd = dollar ? numberFrom(dollar[1]) : undefined
        nums = [...inline[2]!.replace(/\$[\d,]+(?:\.\d+)?/g, " ").matchAll(/\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\b/g)]
          .map((m) => Number(m[1]!.replace(/,/g, "")))
          .filter((n) => Number.isFinite(n))
        name = candidate
        flush()
      }
      continue
    }

    if (looksLikeName(line)) {
      flush()
      name = line
    }
  }

  flush()

  const withCharge = rows.filter((row) => row.chargedUsd !== undefined)
  if (rows.length < 3 && withCharge.length === 0) return undefined

  const found = [`${rows.length} usage rows`]
  const totalRaw = /\bTotal[^\n$]*\$\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text)?.[1]
  const totalUsd = totalRaw !== undefined ? numberFrom(totalRaw) : undefined
  if (totalUsd !== undefined) found.push("total")

  const dates: number[] = []
  for (const pattern of datePatterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
      const parsed = Date.parse(match[1]!)
      if (Number.isFinite(parsed)) dates.push(parsed)
    }
  }
  dates.sort((a, b) => a - b)
  const periodStart = dates[0]
  const periodEnd = dates.length > 1 ? dates[dates.length - 1] : undefined
  if (periodStart !== undefined) found.push("date range")

  return {
    kind: "usage",
    rows,
    ...(totalUsd !== undefined ? { totalUsd } : {}),
    ...(periodStart !== undefined ? { periodStart } : {}),
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    found,
    missing: withCharge.length === 0 ? ["charged amounts (tokens only, credits cannot be confirmed)"] : [],
  }
}

/**
 * Decide which page was pasted.
 *
 * Allowance is checked first: it requires a percentage inside a specific card,
 * which a usage table does not have. Usage then requires several rows. A page
 * matching neither is reported as unrecognised rather than half-read, because a
 * half-read page produces a confident wrong number.
 */
export const parseConsolePage = (raw: string, now = Date.now()): ConsoleReading | undefined => {
  const text = normalize(raw)
  return readAllowance(text, now) ?? readUsage(text, now)
}

/** Kept for the earlier allowlist-only call sites. */
export const parsePlanPage = (raw: string, now = Date.now()): AllowanceReading => {
  const reading = readAllowance(normalize(raw), now)
  if (reading) return reading
  return {
    kind: "allowance",
    found: [],
    missing: ["Design Plan usage"],
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * One line a person can check at a glance before committing it.
 *
 * Written as a sentence rather than a table because it is read once, in a form,
 * and the point is whether it sounds like the page they just copied.
 */
export const describeConsoleReading = (reading: ConsoleReading): string => {
  if (reading.kind === "allowance") {
    if (reading.designPlanUsedPct === undefined) {
      return "Could not find a Design Plan percentage on that page. Copy the Plan & balance page and try again."
    }
    const parts = [
      `${reading.designPlanUsedPct}% of the ${reading.pctOf === "monthly" ? "monthly" : "seven-day"} allowance`,
    ]
    if (reading.resetsAt !== undefined) {
      const hours = Math.max(0, Math.round((reading.resetsAt - Date.now()) / 3_600_000))
      parts.push(hours >= 36 ? `resets in ${Math.round(hours / 24)} days` : `resets in ${hours} hours`)
    }
    if (reading.plan) parts.unshift(`${reading.plan} plan`)
    if (reading.walletUsd !== undefined) parts.push(`wallet ${reading.walletUsd} USD (never auto-spent)`)
    return parts.join(" · ")
  }

  const charged = reading.rows.filter((row) => row.chargedUsd !== undefined)
  if (charged.length > 0) {
    const sum = charged.reduce((total, row) => total + (row.chargedUsd ?? 0), 0)
    return `Usage page: ${plural(reading.rows.length, "model")}, ${sum.toFixed(2)} USD charged across ${plural(charged.length, "row")}.`
  }
  return `Usage page: ${plural(reading.rows.length, "model")} with token counts. No charged amounts, so this can refine the estimate but cannot confirm it.`
}

/** Kept for call sites that only describe an allowance reading. */
export const describePlanPage = (reading: AllowanceReading): string => describeConsoleReading(reading)
