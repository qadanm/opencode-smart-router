/**
 * Prompt repair for providers whose wire protocol is stricter than the
 * canonical context OpenCode builds.
 *
 * The Anthropic Messages protocol accepts only `user` and `assistant` as
 * message roles. OpenCode turns mid-session notices ("Today's date...",
 * "New instructions...") into `role: "system"` entries inside the message
 * array; OpenAI-compatible gateways tolerate that, the Anthropic path
 * rejects the whole turn with a 400 ("Invalid discriminator value. Expected
 * 'user' | 'assistant'"). The router folds those entries into user messages
 * before the request leaves, so the turn the model actually serves carries
 * the same text with a role the strict path accepts.
 *
 * A leading `system` entry is deliberately never folded: the adapter hoists
 * it into the system parameter, where Anthropic prompt caching is anchored.
 */

export interface RepairMessagesInput {
  readonly protocol: "anthropic" | "openai-compat"
}

export interface RepairMessagesResult {
  readonly messages: ReadonlyArray<any>
  readonly folded: number
}

export const repairMessages = (
  messages: ReadonlyArray<any> | undefined,
  input: RepairMessagesInput,
): RepairMessagesResult => {
  if (input.protocol !== "anthropic") return { messages: messages ?? [], folded: 0 }
  if (!Array.isArray(messages)) return { messages: messages ?? [], folded: 0 }

  let folded = 0
  let anyFolded = false
  const next = messages.map((message, index) => {
    if (index === 0 || message === null || typeof message !== "object") {
      return { message, changed: false }
    }
    if (message.role !== "system") return { message, changed: false }
    folded += 1
    anyFolded = true
    return { message: { ...message, role: "user" }, changed: true }
  })

  if (!anyFolded) return { messages, folded: 0 }
  return { messages: next.map((entry) => entry.message), folded }
}
