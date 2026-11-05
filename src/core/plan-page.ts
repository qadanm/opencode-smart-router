import { parseResetIn } from "./config-writer.js"

/**
 * Read a pasted "Plan & balance" page.
 *
 * The account shows a percentage, a reset phrase, a plan tier and a wallet
 * balance, and nothing about it is machine-readable. Asking a user to translate
 * that into four form fields is the chore this replaces: they copy the page, and
 * the router works out the rest.
 *
 * The parsing is deliberately tolerant. A person copies the whole page, sidebar
 * navigation and all, and the order of blocks can change between releases. So
 * every field is found independently, with a bounded window, and anything that
 * cannot be found is reported as missing rather than guessed at.
 *
 * The number that matters is the percentage, and it must be attached to the
 * allowance it describes. OpenDesign's Pro page reports "Design Plan credits"
 * against the seven-day window and says so ("7 days of quota remaining"), while
 * the month is the outer ceiling. Reading 41% as a share of the month when the
 * page means the week is a fourfold error, so the window is captured explicitly.
 */

export interface PlanPageReading {
  readonly plan?: string
  readonly designPlanUsedPct?: number
  /** Which allowance the percentage describes. `weekly` unless the page says otherwise. */
  readonly pctOf?: "weekly" | "monthly"
  readonly resetsAt?: number
  readonly periodEndsAt?: number
  readonly walletUsd?: number
  /** Fields that were recognised, for showing the user what was understood. */
  readonly found: ReadonlyArray<string>
  /** Fields a complete page would have had. Reported, never invented. */
  readonly missing: ReadonlyArray<string>
}

const normalize = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    // Keep line structure; the page's blocks are line-oriented and collapsing
    // newlines would let "Design Plan credits" match a percentage from Billing.
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")

const numberFrom = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw.replace(/,/g, ""))
  return Number.isFinite(value) ? value : undefined
}

/**
 * Every card heading on the page.
 *
 * A value must be found inside the card it belongs to. Without this, searching
 * for a percentage near "Design Plan credits" happily walks into the Usage card
 * and reports 42% for an allowance that had no figure at all — which is worse
 * than reporting nothing, because it looks like a reading.
 */
const CARD_LABELS = [
  /Design Plan credits/i,
  /Pay-as-you-go credits/i,
  /Credit breakdown/i,
  /Auto top-up/i,
  /Top up/i,
  /Reset cards/i,
  /Manage subscription/i,
]

/**
 * The text belonging to one card: from its label to the next card, or a blank
 * line, whichever comes first.
 */
const cardAfter = (text: string, label: RegExp, limit = 200): string | undefined => {
  const start = label.exec(text)
  if (!start) return undefined
  const rest = text.slice(start.index + start[0].length)
  let end = Math.min(rest.length, limit)

  // The next card heading.
  for (const heading of CARD_LABELS) {
    if (heading.source === label.source) continue
    const found = heading.exec(rest)
    if (found && found.index > 0) end = Math.min(end, found.index)
  }
  // A blank line is also a block boundary.
  const blank = rest.indexOf("\n\n")
  if (blank > 0) end = Math.min(end, blank)

  return rest.slice(0, end)
}

/** Find a captured value inside one card. */
const inCard = (text: string, label: RegExp, pattern: RegExp, limit = 200): string | undefined => {
  const block = cardAfter(text, label, limit)
  return block === undefined ? undefined : pattern.exec(block)?.[1]?.trim() || undefined
}

export const parsePlanPage = (raw: string, now = Date.now()): PlanPageReading => {
  const text = normalize(raw)
  const found: string[] = []
  const missing: string[] = []

  /**
   * The tier. Matched as a standalone line because "Pro" also appears inside
   * product names in the navigation and inside sentences.
   */
  const planLine = /^\s*(Go|Plus|Pro|Max)\s*$/m.exec(text)?.[1]
  if (planLine) found.push("plan")
  else missing.push("plan")

  const designPct = numberFrom(inCard(text, /Design Plan credits/i, /(\d{1,3})\s*%/, 120))
  if (designPct !== undefined) found.push("Design Plan usage")
  else missing.push("Design Plan usage")

  /**
   * Which window the percentage belongs to.
   *
   * "7 days of quota remaining" is the page telling us the figure is a weekly
   * one. Only an explicit monthly phrase should change that, because defaulting
   * the other way would overstate usage by the ratio of the two caps.
   */
  let pctOf: "weekly" | "monthly" | undefined
  if (/7\s*days?\s*of\s*quota/i.test(text) || /seven[-\s]?day/i.test(text)) pctOf = "weekly"
  else if (/\d+\s*days?\s*of\s*quota/i.test(text)) pctOf = "weekly"
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

  const wallet = numberFrom(
    inCard(text, /Pay-as-you-go credits/i, /\$\s*([\d,]+(?:\.\d{1,2})?)/, 120),
  )
  if (wallet !== undefined) found.push("wallet balance")
  else missing.push("wallet balance")

  return {
    ...(planLine ? { plan: planLine } : {}),
    ...(designPct !== undefined ? { designPlanUsedPct: Math.min(100, Math.max(0, designPct)) } : {}),
    ...(pctOf ? { pctOf } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(periodEndsAt !== undefined && Number.isFinite(periodEndsAt) ? { periodEndsAt } : {}),
    ...(wallet !== undefined ? { walletUsd: wallet } : {}),
    found,
    missing,
  }
}

/**
 * One line a person can check at a glance before committing it.
 *
 * Written as a sentence rather than a table because it is read once, in a form,
 * and the point is whether it sounds like the page they just copied.
 */
export const describePlanPage = (reading: PlanPageReading): string => {
  if (reading.designPlanUsedPct === undefined) {
    return "Could not find a Design Plan percentage on that page. Copy the Plan & balance page and try again."
  }
  const parts = [`${reading.designPlanUsedPct}% of the ${reading.pctOf === "monthly" ? "monthly" : "seven-day"} allowance`]
  if (reading.resetsAt !== undefined) {
    const hours = Math.max(0, Math.round((reading.resetsAt - Date.now()) / 3_600_000))
    parts.push(hours >= 36 ? `resets in ${Math.round(hours / 24)} days` : `resets in ${hours} hours`)
  }
  if (reading.plan) parts.unshift(`${reading.plan} plan`)
  if (reading.walletUsd !== undefined) parts.push(`wallet ${reading.walletUsd} USD (never auto-spent)`)
  return parts.join(" · ")
}
