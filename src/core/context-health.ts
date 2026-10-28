import type { ContextHealth, ContextHealthSettings, SessionState } from "./types.js"
import { pct } from "./util.js"

export const computeContextHealth = (
  session: SessionState | undefined,
  settings: ContextHealthSettings,
): ContextHealth => {
  const tokens = session?.contextTokens ?? 0
  const cacheRead = session?.cacheReadTokens ?? 0
  const cacheSharePct = tokens > 0 ? pct(cacheRead, tokens) : 0
  if (!settings.enabled) {
    return { tokens, cacheRead, cacheSharePct, state: "healthy", message: "Context-health monitoring is disabled." }
  }
  if (tokens >= settings.recommendAtTokens) {
    return {
      tokens,
      cacheRead,
      cacheSharePct,
      state: "recommend_new_session",
      message: `This session has about ${tokens.toLocaleString()} context tokens. A fresh session with a short handoff will usually cost less per turn. The router will not compact or replace this conversation.`,
    }
  }
  if (tokens >= settings.warnAtTokens) {
    return {
      tokens,
      cacheRead,
      cacheSharePct,
      state: "watch",
      message: `Context is about ${tokens.toLocaleString()} tokens. Cache reads are cheaper than fresh input but are not free. Consider a new session for unrelated work.`,
    }
  }
  return {
    tokens,
    cacheRead,
    cacheSharePct,
    state: "healthy",
    message: `${tokens.toLocaleString()} context tokens; ${cacheSharePct.toFixed(0)}% arrived as cache reads. Cache reads are cheaper than fresh input but are not free.`,
  }
}
