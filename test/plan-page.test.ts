import { describe, expect, it } from "vitest"
import { describePlanPage, parsePlanPage } from "../src/core/plan-page.js"

/**
 * The paste parser exists so nobody has to translate a billing page into fields.
 *
 * These tests use the real page text, copied verbatim from the account on
 * 2026-11-04, navigation and all — because that is what a person actually puts
 * on the clipboard. A parser that only works on the two lines it wants would be
 * a parser that fails the moment somebody selects the whole page.
 */

const REAL_PAGE = `Muhammed Qad…

Muhammed Qadan's workspace

Invite colleagues
Pricing
Arena
Models & pricing
Help & docs

Plan & balance
API keys
Members
Usage
Billing
Settings
Open Design

Pro
This period ends on November 29, 2026
·
Manage subscription
Upgrade
Design Plan credits
ⓘ
41%
7 days of quota remaining
Reset in 0 days 22 hours
Pay-as-you-go credits
ⓘ
$120.00
Top up
Credit breakdown
Auto top-up

Both credit types are shared by the team. The model selected when a task starts determines which credits are used. View models and their credit types`

const NOW = Date.UTC(2026, 10, 4, 21, 0, 0)

describe("reading the real page", () => {
  const reading = parsePlanPage(REAL_PAGE, NOW)

  it("finds the tier", () => {
    expect(reading.plan).toBe("Pro")
  })

  it("finds the Design Plan percentage", () => {
    expect(reading.designPlanUsedPct).toBe(41)
  })

  it("knows the percentage is of the seven-day window, not the month", () => {
    // The page says "7 days of quota remaining". Reading 41% against the month
    // would understate the fraction of the week that is spent by four times.
    expect(reading.pctOf).toBe("weekly")
  })

  it("finds the reset time from the page's own phrase", () => {
    expect(reading.resetsAt).toBe(NOW + 22 * 3_600_000)
  })

  it("finds the billing period end", () => {
    expect(reading.periodEndsAt).toBe(Date.parse("November 29, 2026"))
  })

  it("finds the wallet balance and keeps it separate from the allowance", () => {
    expect(reading.walletUsd).toBe(120)
  })

  it("reports what it understood, so the user can check it", () => {
    expect(reading.found).toEqual(
      expect.arrayContaining(["plan", "Design Plan usage", "allowance window", "reset time", "wallet balance"]),
    )
    expect(reading.missing).not.toContain("Design Plan usage")
  })

  it("summarises in a sentence a person can sanity-check", () => {
    const summary = describePlanPage(reading)
    expect(summary).toContain("Pro plan")
    expect(summary).toContain("41% of the seven-day allowance")
    expect(summary).toContain("wallet 120 USD")
  })
})

describe("edge cases that are readings, not absence", () => {
  it("reads a brand-new account at 0%", () => {
    const reading = parsePlanPage(REAL_PAGE.replace("41%", "0%"), NOW)
    expect(reading.designPlanUsedPct).toBe(0)
  })

  it("reads a spent account at 100%", () => {
    const reading = parsePlanPage(REAL_PAGE.replace("41%", "100%"), NOW)
    expect(reading.designPlanUsedPct).toBe(100)
  })

  it("reads an empty wallet", () => {
    const reading = parsePlanPage(REAL_PAGE.replace("$120.00", "$0.00"), NOW)
    expect(reading.walletUsd).toBe(0)
  })

  it("reads a wallet with thousands separators", () => {
    const reading = parsePlanPage(REAL_PAGE.replace("$120.00", "$1,250.75"), NOW)
    expect(reading.walletUsd).toBe(1250.75)
  })
})

describe("it never invents what the page did not say", () => {
  it("asks for the percentage when there is none", () => {
    const reading = parsePlanPage("Open Design\nPro\nThis period ends on November 29, 2026", NOW)
    expect(reading.designPlanUsedPct).toBeUndefined()
    expect(reading.missing).toContain("Design Plan usage")
    expect(describePlanPage(reading)).toMatch(/could not find/i)
  })

  it("leaves the reset undefined rather than guessing", () => {
    const reading = parsePlanPage(REAL_PAGE.replace("Reset in 0 days 22 hours", ""), NOW)
    expect(reading.resetsAt).toBeUndefined()
    expect(reading.missing).toContain("reset time")
  })

  it("does not pick up a percentage from a neighbouring block", () => {
    // Usage 42% belongs to a different card; Design Plan credits has no figure.
    const page = `Design Plan credits
ⓘ
Pay-as-you-go credits
ⓘ
Usage
42%`
    const reading = parsePlanPage(page, NOW)
    expect(reading.designPlanUsedPct).toBeUndefined()
  })

  it("treats an explicit monthly label as monthly", () => {
    const page = `Pro
Design Plan credits
monthly allowance
55%`
    const reading = parsePlanPage(page, NOW)
    expect(reading.designPlanUsedPct).toBe(55)
    expect(reading.pctOf).toBe("monthly")
  })
})
