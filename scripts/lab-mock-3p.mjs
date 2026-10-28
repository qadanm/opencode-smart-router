#!/usr/bin/env node
/**
 * Isolated canary mock for the three-provider router lab.
 *
 * It serves three OpenAI-compatible gateways on one port:
 *
 *   /cc/v1  Command Code GOAT shape
 *   /go/v1  OpenCode Go Plus shape
 *   /od/v1  OpenDesign shape, byte-identical field layout to the live
 *           gateway's GET /v1/models response captured on 2026-10-28
 *
 * It also serves an OpenDesign account-control surface so the verified quota
 * path can be exercised without any real credential.
 *
 * Nothing here performs real inference and nothing contacts a paid provider.
 */
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"

const PORT = Number(process.env.MOCK_PORT ?? 4200)
const LOG = process.env.MOCK_LOG ?? "/tmp/mock.log"

const log = (entry) => {
  appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)
}

const opendesignModels = {
  object: "list",
  data: [
    { id: "claude-haiku-5.5", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, metadata: { cost: "low", capability: "standard", context_limit: 1000000, context_budget: 228000, output_budget: 128000 }, default: false, enabled: true },
    { id: "deepseek-v4-flash", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, metadata: { cost: "medium", capability: "standard", context_limit: 1048000, context_budget: 232000, output_budget: 32000 }, default: false, enabled: true },
    { id: "deepseek-v4-flash-vision-exp", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, metadata: { cost: "medium", capability: "standard", context_limit: 1048000, context_budget: 232000, output_budget: 32000 }, default: false, enabled: true },
    { id: "deepseek-v4-pro", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, metadata: { cost: "high", capability: "advanced", context_limit: 1048000, context_budget: 328000, output_budget: 128000 }, default: false, enabled: true },
    { id: "deepseek-v4.1-flash", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, metadata: { cost: "low", capability: "advanced", context_limit: 1048000, context_budget: 328000, output_budget: 128000 }, default: true, enabled: true },
    { id: "glm-5.3-flash", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] }, metadata: { cost: "low", capability: "advanced", context_limit: 1048000, context_budget: 232000, output_budget: 32000 }, default: false, enabled: true },
    { id: "glm-5.3-flashx", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image", "file", "video"], output_modalities: ["text"] }, metadata: { cost: "medium", capability: "advanced", context_limit: 1000000, context_budget: 232000, output_budget: 32000 }, default: false, enabled: true },
    { id: "gpt-6-luna", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, metadata: { cost: "low", capability: "standard", context_limit: 1050000, context_budget: 400000, output_budget: 128000 }, default: false, enabled: true },
    { id: "hy4-preview", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, metadata: { cost: "medium", capability: "advanced", context_limit: 1048000, context_budget: 232000, output_budget: 32000 }, default: false, enabled: true },
    { id: "kimi-k2.7-code", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, metadata: { cost: "medium", capability: "advanced", context_limit: 262000, context_budget: 262000, output_budget: 32000 }, default: false, enabled: true },
    { id: "mimo-v2.6-flash", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image", "audio", "video"], output_modalities: ["text"] }, metadata: { cost: "low", capability: "standard", context_limit: 1048000, context_budget: 232000, output_budget: 32000 }, default: false, enabled: true },
    { id: "mimo-v2.6-pro", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image", "audio", "video"], output_modalities: ["text"] }, metadata: { cost: "medium", capability: "standard", context_limit: 1048000, context_budget: 232000, output_budget: 32000 }, default: false, enabled: true },
    { id: "minimax-m3.1-flash", object: "model", created: 1791441624, owned_by: "vela", architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] }, metadata: { cost: "low", capability: "advanced", context_limit: 1000000, context_budget: null, output_budget: null }, default: false, enabled: true },
  ],
}

const ccModels = {
  object: "list",
  data: [
    { id: "deepseek-v4.1-flash", object: "model", owned_by: "lab", capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: { context: 1000000, output: 384000 }, cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }] },
    { id: "claude-haiku-5-5", object: "model", owned_by: "lab", capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1000000, output: 128000 }, cost: [{ input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.125 } }] },
    { id: "claude-sonnet-5-5", object: "model", owned_by: "lab", capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1000000, output: 128000 }, cost: [{ input: 2, output: 10, cache: { read: 0.1, write: 2.5 } }] },
  ],
}

const goModels = {
  object: "list",
  data: [
    { id: "deepseek-v4.1-flash", object: "model", owned_by: "lab", capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: { context: 1000000, output: 384000 }, cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }] },
    { id: "glm-5.3-flash", object: "model", owned_by: "lab", capabilities: { tools: true, input: ["text", "image", "video"], output: ["text"] }, limit: { context: 1000000, output: 131072 }, cost: [{ input: 0.15, output: 0.5, cache: { read: 0.03, write: 0 } }] },
    { id: "minimax-m3.1-flash", object: "model", owned_by: "lab", capabilities: { tools: true, input: ["text", "image", "video"], output: ["text"] }, limit: { context: 1000000, output: 512000 }, cost: [{ input: 0.15, output: 0.6, cache: { read: 0.015, write: 0 } }] },
    { id: "claude-haiku-5-5", object: "model", owned_by: "lab", capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1000000, output: 128000 }, cost: [{ input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.125 } }] },
  ],
}

const send = (res, status, body) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

const readBody = (req) =>
  new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => resolve(data))
  })

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const body = await readBody(req)
  log({ method: req.method, url: path, auth: Boolean(req.headers.authorization), body: body.slice(0, 400) })

  if (req.method === "GET" && path === "/od/v1/models") {
    return send(res, 200, opendesignModels)
  }
  if (req.method === "GET" && path === "/cc/v1/models") {
    return send(res, 200, ccModels)
  }
  if (req.method === "GET" && path === "/go/v1/models") {
    return send(res, 200, goModels)
  }

  // OpenDesign account-control surface (only reachable with the control key).
  if (req.method === "GET" && path === "/od/api/v1/workspaces/current") {
    if (!req.headers.authorization) return send(res, 401, { error: "unauthenticated" })
    return send(res, 200, { workspaceId: "ws_lab", activeWorkspaceId: "ws_lab", workspaceType: "personal" })
  }
  if (req.method === "GET" && /\/od\/api\/v1\/workspaces\/[^/]+\/billing\/coding-plan-usage$/.test(path)) {
    if (!req.headers.authorization) return send(res, 401, { error: "unauthenticated" })
    const exhausted = process.env.MOCK_OD_EXHAUSTED === "1"
    const used = exhausted ? 100000 : 20000
    return send(res, 200, {
      workspaceId: "ws_lab",
      generatedAt: Date.now(),
      eligible: true,
      tier: "go",
      windows: [
        { durationSeconds: 18000, usedCredits: used, limitCredits: 100000, remainingCredits: 100000 - used, resetsAt: Date.now() + 3600000 },
        { durationSeconds: 604800, usedCredits: used * 3, limitCredits: 300000, remainingCredits: 300000 - used * 3, resetsAt: Date.now() + 86400000 },
      ],
    })
  }
  if (req.method === "GET" && path === "/od/api/v1/billing/summary") {
    if (!req.headers.authorization) return send(res, 401, { error: "unauthenticated" })
    return send(res, 200, {
      balanceUsd: 0,
      creditsPerUsd: 10000,
      balances: { subscriptionCredits: 2400000, rechargeCredits: Number(process.env.MOCK_OD_WALLET_CREDITS ?? 0) },
      membershipTier: "go",
    })
  }

  if (req.method === "POST" && /\/(cc|go|od)\/v1\/chat\/completions$/.test(path)) {
    let model = "unknown"
    try {
      model = JSON.parse(body || "{}").model ?? "unknown"
    } catch {
      model = "unparsed"
    }
    // A simulated mid-stream provider fault, used to prove the router
    // detects and cools down a model that drops streams.
    if (process.env.MOCK_STREAM_FAILURE === "1" && model === "minimax-m3.1-flash") {
      return send(res, 200, {
        error: {
          param: null,
          type: "server_error",
          message: "Streaming response failed: [500] EngineCore encountered an issue. See stack trace (above) for the root cause.",
        },
      })
    }
    const content = "ok"
    return send(res, 200, {
      id: "chatcmpl-lab",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    })
  }

  send(res, 404, { error: "not found" })
})

server.listen(PORT, "127.0.0.1", () => {
  log({ event: "listening", port: PORT })
  console.log(`mock listening on ${PORT}`)
})
