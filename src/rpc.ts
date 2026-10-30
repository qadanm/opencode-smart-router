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
    refreshQuota: method(emptyInput),
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
