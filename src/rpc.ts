import { Rpc } from "@opencode/plugin/rpc"

const objectOutput = { type: "object", additionalProperties: true } as const
const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const
const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const method = (input: any) => ({ input, output: objectOutput })

export const SmartRouterRpc = Rpc.define({
  id: "smart-router",
  methods: {
    status: method({
      type: "object",
      properties: { sessionID: { type: "string" } },
      additionalProperties: false,
    }),
    preview: method({
      type: "object",
      properties: {
        sessionID: { type: "string" },
        text: { type: "string" },
        files: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["sessionID", "text"],
      additionalProperties: false,
    }),
    setMode: method({
      type: "object",
      properties: { mode: { type: "string", enum: ["efficiency", "balanced", "premium"] } },
      required: ["mode"],
      additionalProperties: false,
    }),
    setPaused: method({
      type: "object",
      properties: { paused: { type: "boolean" } },
      required: ["paused"],
      additionalProperties: false,
    }),
    /**
     * Turn automatic routing on or off for one session.
     *
     * Not the same as disabling the plugin or pausing every session: the router
     * stays loaded, keeps reporting quota and decisions, and simply stops
     * changing the model. The user keeps whatever model they have.
     */
    setSessionAuto: method({
      type: "object",
      properties: { sessionID: { type: "string" }, auto: { type: "boolean" } },
      required: ["sessionID", "auto"],
      additionalProperties: false,
    }),
    setDryRun: method({
      type: "object",
      properties: { dryRun: { type: "boolean" } },
      required: ["dryRun"],
      additionalProperties: false,
    }),
    resumeAuto: method(sessionInput),
    pin: method({
      type: "object",
      properties: {
        sessionID: { type: "string" },
        providerID: { type: "string" },
        modelID: { type: "string" },
        variant: { type: "string" },
      },
      required: ["sessionID", "providerID", "modelID"],
      additionalProperties: false,
    }),
    approvePremium: method(sessionInput),
    denyPremium: method(sessionInput),
    excludeModel: method({
      type: "object",
      properties: {
        providerID: { type: "string" },
        modelID: { type: "string" },
        excluded: { type: "boolean" },
      },
      required: ["providerID", "modelID", "excluded"],
      additionalProperties: false,
    }),
    setPremiumBudget: method({
      type: "object",
      properties: { usd: { type: "number", minimum: 0, maximum: 100000 } },
      required: ["usd"],
      additionalProperties: false,
    }),
    setReserve: method({
      type: "object",
      properties: {
        providerID: { type: "string" },
        monthlyPct: { type: "number", minimum: 0, maximum: 90 },
        weeklyPct: { type: "number", minimum: 0, maximum: 90 },
        fiveHourPct: { type: "number", minimum: 0, maximum: 90 },
      },
      required: ["providerID"],
      additionalProperties: false,
    }),
    /**
     * The intelligence floor in force, and why.
     *
     * Calibration can only be trusted if its result is visible: a number with
     * no explanation is indistinguishable from the hand-picked one it replaced.
     * This previews without enabling anything.
     */
    floor: method(emptyInput),
    setCalibrateFloor: method({
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    }),
    refreshQuota: method(emptyInput),
    /**
     * What this machine has, for the first-run screen.
     *
     * Onboarding must show evidence, not a questionnaire. The router already
     * detects credentials and imports history at startup; this reports what it
     * found so the first thing a new user sees is the truth about their own
     * machine rather than a form asking them to type it in.
     */
    onboarding: method(emptyInput),
    /** Mark the first run as seen, so it does not reappear. */
    completeOnboarding: method(emptyInput),
    /**
     * Record what the user's account page showed, so the estimate reflects the
     * whole account rather than only the traffic this router routed.
     *
     * Takes the percentage the page displays, not a dollar figure: asking a user
     * to divide by a cap they may not know is where the arithmetic mistakes come
     * from. The server converts it against the window the page was describing.
     */
    /**
     * Record the account's balance page, pasted whole.
     *
     * One field, because that is the actual task: select the page, copy, paste.
     * The server reads the plan, the percentage, which window it belongs to, the
     * reset time, the billing period and the wallet out of the text. A form with
     * four boxes asks the user to do that parsing by hand and get it right.
     */
    recordPlanPage: method({
      type: "object",
      properties: {
        /** The pasted page text. */
        page: { type: "string" },
        /** Apply it without previewing. Defaults to false: the user confirms first. */
        confirm: { type: "boolean" },
      },
      required: ["page"],
      additionalProperties: false,
    }),
    report: method(emptyInput),
    usage: method(emptyInput),
    getConfig: method(emptyInput),
    resetOverrides: method(emptyInput),
    resetMetrics: method(emptyInput),
    refreshIndicator: method(sessionInput),
    diagnostics: method(emptyInput),
    setTitleIndicator: method({
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    }),
  },
  events: {
    decision: {
      schema: {
        type: "object",
        properties: {
          decision: { type: "object", additionalProperties: true },
        },
        required: ["decision"],
        additionalProperties: false,
      },
    },
    status: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          summary: { type: "object", additionalProperties: true },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
    quota: {
      schema: {
        type: "object",
        properties: {
          providers: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["providers"],
        additionalProperties: false,
      },
    },
  },
})
