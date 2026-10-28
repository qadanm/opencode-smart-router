import type { TaskClass, TaskKind, TaskTier } from "../types.js"
import { isImageName, isImageUri, unique } from "../util.js"

export interface ClassifierFile {
  readonly uri: string
  readonly name?: string
  readonly description?: string
}

export interface ClassifierInput {
  readonly text: string
  readonly files?: ReadonlyArray<ClassifierFile>
  readonly agent?: string
  readonly parentID?: string
  readonly contextTokens?: number
  readonly promptTokens?: number
  readonly recentFailures?: number
  readonly now?: number
}

const narrowCss =
  /^\s*(?:please\s+)?(?:change|set|update|make)\b[^\n]{0,200}\b(?:color|colour|background|background-color|padding|margin|font-size|font-weight|border-radius|border-color|width|height|gap|display)\b[^\n]{0,120}\b(?:to|:)\s*(?:#[0-9a-f]{3,8}|\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|ch|fr)?|[a-z][a-z-]*)\b/i

const broadDesignTerms =
  /\b(redesign|design system|visual design|design critique|design review|user experience|\bux\b|\bu[iI]\b audit|figma|mockup|wireframe|typography|color palette|colour palette|landing page design|component library|accessibility audit|a11y audit|design token|responsive layout)\b/i

const designTerms =
  /\b(design|redesign|visual|layout|responsive|style|styling|css|tailwind|theme|animation|typography|colour|color|component|hover|focus|dark mode|light mode|accessibility|a11y|figma|mockup|screenshot|wireframe)\b/i

const architectureTerms =
  /\b(architecture|architectural|multi-tenant|multi tenant|distributed system|microservice|event-driven|schema design|database design|data model|migration|monorepo|scalab|concurrency|race condition|deadlock|memory leak|performance profiling|throughput|latency budget|production incident|cross-service|cross service|refactor across)\b/i

const securityTerms =
  /\b(security review|threat model|authorization model|authentication model|oauth|encryption|secrets management|vulnerability|exploit|injection|xss|csrf|privilege escalation)\b/i

const hardDebugTerms =
  /\b(intermittent|flaky|only sometimes|production|regression|memory leak|deadlock|race condition|multiple services|cross-service)\b/i

const mechanicalPatterns: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "rename", pattern: /\brename\s+(?:the\s+)?[A-Za-z_$][\w$.-]*\s+to\s+[A-Za-z_$][\w$.-]*\b/i },
  { name: "typo", pattern: /\b(fix|correct)\s+(?:a\s+)?(?:typo|spelling|misspell(?:ing)?)\b/i },
  { name: "format", pattern: /\b(format|prettier|lint|eslint|clang-format|gofmt|rustfmt)\b/i },
  { name: "imports", pattern: /\b(sort|organize|remove unused)\s+imports?\b/i },
  { name: "replace", pattern: /\breplace\s+["'`].+["'`]\s+with\s+["'`].+["'`]/i },
  { name: "version", pattern: /\b(bump|update|change)\s+(?:the\s+)?(?:package\s+)?version\b/i },
  { name: "comment", pattern: /\b(add|update|fix)\s+(?:a\s+)?(?:code\s+)?(?:comment|docstring|jsdoc)\b/i },
  { name: "readme", pattern: /\b(update|format|fix)\s+(?:the\s+)?(?:readme|documentation|docs)\b/i },
  { name: "import-fix", pattern: /\b(fix|correct)\s+(?:an?\s+)?(?:import|indentation|whitespace)\b/i },
]

const broadScopeTerms =
  /\b(all|every|everywhere|across|multiple|components|codebase|project|architecture|refactor|feature|implement|migrate|migration|responsive|theme|states?|tests?|debug|investigate|why|security|performance)\b/i

const deterministicPattern =
  /^\s*(?:please\s+)?(?:run|execute)\s+(?:the\s+)?(?:formatter|linter|lint|tests?|test suite|typecheck|type check|build|validation)\b/i

const premiumConstraint =
  /\b(use|pick|choose)\s+(?:the\s+)?(?:best|strongest|most capable|premium)\b|\b(premium model|best model|strongest model|think hard|deep reasoning|use (?:claude )?opus|use (?:claude )?sonnet|use gpt-6|use glm-5\.3)\b/i

const economyConstraint =
  /\b(use|pick|choose)\s+(?:the\s+)?(?:cheapest|cheap|economy|budget)\b|\b(?:don'?t|do not|avoid|no)\s+premium\b|\bminimum cost\b|\bsave (?:quota|credits)\b/i

const simpleWord = /\b(simple|small|quick|trivial|easy|just)\b/i

const countCodeBlocks = (text: string) => {
  const blocks = text.match(/```[\s\S]*?```/g) ?? []
  const longest = blocks.reduce((max, block) => Math.max(max, block.split(/\r?\n/).length), 0)
  return { count: blocks.length, longest }
}

const countPaths = (text: string) => {
  const matches = text.match(/(?:^|[\s("'`])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|sass|html|json|jsonc|md|mdx|py|go|rs|swift|kt|java|rb|php|yaml|yml|toml|sh|sql|vue|svelte))\b/gi)
  return unique((matches ?? []).map((value) => value.trim().replace(/^["'`(]/, ""))).length
}

const looksLikeImage = (file: ClassifierFile) =>
  isImageUri(file.uri) || isImageName(file.name) || isImageName(file.description) || /image|screenshot|photo/i.test(file.description ?? "")

const classifyKind = (input: ClassifierInput, flags: {
  design: boolean
  architecture: boolean
  security: boolean
  debug: boolean
  deterministic: boolean
  mechanical: boolean
}): TaskKind => {
  const text = input.text.toLowerCase()
  if (flags.deterministic) return "deterministic"
  if (flags.design) return "design"
  if (flags.security) return "security"
  if (flags.architecture) return "architecture"
  if (flags.debug) return "debug"
  if (/\brefactor\b/.test(text)) return "refactor"
  if (/\b(test|spec|coverage|vitest|jest|playwright)\b/.test(text) && !/\blatest\b/.test(text)) return "test"
  if (/\b(readme|documentation|docs|jsdoc|docstring|comment)\b/.test(text) && input.text.length < 1200) return "docs"
  if (flags.mechanical) return "mechanical"
  if (/\b(add|implement|build|create|support|introduce|feature)\b/.test(text)) return "feature"
  return "unknown"
}

/**
 * Deterministic, local task classification. It uses structural signals rather
 * than trusting words such as "simple" or "quick". Ambiguity resolves upward to
 * the standard tier.
 */
export const classifyTask = (input: ClassifierInput): TaskClass => {
  const text = input.text ?? ""
  const files = input.files ?? []
  const signals: string[] = []
  const reasons: string[] = []
  const code = countCodeBlocks(text)
  const paths = countPaths(text)
  // Paths such as src/components/Button.tsx must not masquerade as scope words
  // like "components" or "tests". Keywords are scored on prose and code outside
  // fenced blocks, with file paths removed.
  const scoringText = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|sass|html|json|jsonc|md|mdx|py|go|rs|swift|kt|java|rb|php|yaml|yml|toml|sh|sql|vue|svelte)\b/gi, " ")
  // Negative instructions ("do not run tests", "don't change anything else")
  // are constraints, not evidence of broad scope.
  const scopeText = scoringText.replace(/\b(?:do not|don't|never|avoid|without)\b[^.!?\n]*/gi, " ")
  const lower = scoringText.toLowerCase()
  const attachedImages = files.filter(looksLikeImage)
  const hasImage = attachedImages.length > 0
  const hasScreenshot =
    hasImage &&
    (/\b(screenshot|screen shot|figma|mockup|wireframe|visual|image|photo|design|ui)\b/i.test(text) ||
      attachedImages.some((file) => /screenshot|screen|figma|mockup|wireframe|image|photo|design/i.test(`${file.name ?? ""} ${file.description ?? ""}`)))
  const hasStackTrace =
    /\n\s+at\s+\S+/.test(text) ||
    /traceback \(most recent call last\)/i.test(text) ||
    /\buncaught\b|\bpanic:|\bexception\b|\bstderr\b/i.test(text)
  const promptChars = text.length
  const promptTokens = input.promptTokens ?? Math.max(1, Math.ceil(promptChars / 4))
  const contextTokens = input.contextTokens ?? 0
  const recentFailures = input.recentFailures ?? 0

  if (hasImage) signals.push("image_input")
  if (hasScreenshot) signals.push("screenshot_input")
  if (hasStackTrace) signals.push("stack_trace")
  if (code.count > 0) signals.push("code_blocks")
  if (paths > 1) signals.push("multiple_paths")
  if (simpleWord.test(scoringText)) signals.push("self_described_simple_ignored")
  if (recentFailures >= 2) signals.push("recent_failures")

  const uiTermCount = (
    scoringText.match(
      /\b(responsive|theme|layout|typography|animation|keyboard navigation|loading state|error state|settings page|navbar|modal|form|button|component|accessibility|dark mode|light mode)\b/gi,
    ) ?? []
  ).length
  const designFeature =
    uiTermCount >= 2 &&
    /\b(implement|build|create|add|design|redesign|page|component|layout|ui|screen|view)\b/i.test(scoringText)
  const designIntensive =
    broadDesignTerms.test(scoringText) ||
    designFeature ||
    (designTerms.test(scoringText) && (hasScreenshot || promptChars > 260)) ||
    (hasScreenshot && /\b(improve|fix|review|match|implement|build|polish|critique)\b/i.test(text))
  const sophisticatedDesign =
    broadDesignTerms.test(scoringText) &&
    !(narrowCss.test(text) && promptChars < 400) &&
    /\b(redesign|design system|visual design|design critique|design review|ux audit|figma|mockup|wireframe|landing page|component library|accessibility audit|typography|design token)\b/i.test(scoringText)
  if (designIntensive) signals.push("design_intensive")
  if (sophisticatedDesign) signals.push("sophisticated_design")

  const architecture = architectureTerms.test(scoringText)
  const security = securityTerms.test(scoringText)
  const hardDebug = hasStackTrace && hardDebugTerms.test(scoringText)
  if (architecture) signals.push("architecture")
  if (security) signals.push("security")
  if (hardDebug) signals.push("hard_debug")

  const deterministic = deterministicPattern.test(scopeText) && !/\b(add|change|implement|create|fix|refactor|update\s+the\s+code)\b/i.test(text)
  if (deterministic) signals.push("deterministic_tooling")

  const mechanicalMatches = mechanicalPatterns.filter((pattern) => pattern.pattern.test(scopeText))
  const narrowScope =
    promptChars < 550 &&
    code.count <= 1 &&
    code.longest <= 12 &&
    paths <= 2 &&
    !hasStackTrace &&
    !broadScopeTerms.test(scopeText)
  const onlyCss = narrowCss.test(text) && !/\b(theme|responsive|hover|focus|active|dark mode|light mode|all|every|components?|across|states?)\b/i.test(scopeText)
  const mechanical =
    (narrowScope && mechanicalMatches.length > 0) ||
    (narrowScope && onlyCss) ||
    (deterministic && promptChars < 300)
  if (mechanicalMatches.length > 0) signals.push(`mechanical:${mechanicalMatches.map((match) => match.name).join(",")}`)
  if (onlyCss) signals.push("narrow_css")
  if (narrowScope) signals.push("narrow_scope")

  const constraints = {
    avoidPremium: economyConstraint.test(scoringText),
    requestPremium: premiumConstraint.test(scoringText),
    requestEconomy: /\b(cheapest|cheap|economy|budget)\b/i.test(text),
  }
  if (constraints.avoidPremium) signals.push("constraint:avoid_premium")
  if (constraints.requestPremium) signals.push("constraint:request_premium")
  if (constraints.requestEconomy) signals.push("constraint:request_economy")

  let tier: TaskTier = 2
  let confidence: TaskClass["confidence"] = "medium"

  const strongPremiumSignals =
    (architecture && /\b(architecture|multi-tenant|distributed|migration|concurrency|race condition|deadlock|memory leak|production incident)\b/i.test(text)) ||
    security ||
    hardDebug ||
    sophisticatedDesign ||
    (recentFailures >= 2 && (designIntensive || architecture || security || hardDebug || /\b(debug|fix|refactor|implement)\b/i.test(text)))

  if (constraints.avoidPremium) {
    tier = mechanical && narrowScope ? 1 : 2
    reasons.push("User asked to avoid premium or expensive models; premium tiers are excluded.")
    confidence = "high"
  } else if (constraints.requestPremium) {
    tier = 3
    reasons.push("User explicitly asked for the strongest or a premium model; premium approval is still required by policy.")
    confidence = "high"
  } else if (strongPremiumSignals) {
    tier = 3
    reasons.push(
      sophisticatedDesign
        ? "Sophisticated design work requires a high design-capability score in addition to general intelligence."
        : architecture
          ? "Architecture or cross-system changes materially benefit from a premium model."
          : security
            ? "Security-sensitive work benefits from a premium model and stricter review."
            : "Intermittent or multi-component debugging can exceed standard-model reliability.",
    )
    confidence = strongPremiumSignals && (designIntensive || architecture || security || hardDebug) ? "high" : "medium"
  } else if (deterministic) {
    tier = 0
    reasons.push("This is deterministic tooling work; use existing formatters, linters, tests, or type checks.")
    confidence = "high"
  } else if (mechanical) {
    tier = 1
    reasons.push(
      onlyCss
        ? "A single, narrow styling change with unambiguous scope and deterministic validation."
        : "A narrow mechanical edit with a small, explicit scope.",
    )
    confidence = narrowScope && (mechanicalMatches.length > 0 || onlyCss) ? "high" : "medium"
  } else {
    tier = 2
    reasons.push("Substantive engineering work stays at or above the DeepSeek V4.1 Flash intelligence floor.")
    confidence = "medium"
  }

  // A design request that is not sophisticated still needs a design-capable
  // standard model, never a text-only model when a screenshot is attached.
  if (designIntensive && tier < 2) {
    tier = 2
    reasons.push("Design work was raised to the standard tier because economy models are not qualified for design judgment.")
    confidence = "high"
  }

  if (hasScreenshot && !designIntensive) {
    reasons.push("Screenshot input requires native image understanding.")
  }

  const kind = classifyKind(input, {
    design: designIntensive,
    architecture,
    security,
    debug: hasStackTrace || /\b(bug|error|failing|fails|broken|doesn't work|does not work|debug)\b/i.test(text),
    deterministic,
    mechanical,
  })

  const needsLongContext = contextTokens > 250_000 || /\b(600k|large context|long conversation|whole repository|entire repo)\b/i.test(text)
  if (needsLongContext) signals.push("long_context")

  const scope = {
    files: paths + files.length,
    codeBlocks: code.count,
    longestCodeBlockLines: code.longest,
    hasStackTrace,
    hasImage,
    hasScreenshot,
    promptChars,
    promptTokens,
  }

  if (tier === 2 && confidence === "medium" && /\b(simple|small|quick|trivial)\b/i.test(text)) {
    reasons.push("Self-described simplicity was ignored; the scope signals did not meet the economy-tier requirements.")
  }

  return {
    tier,
    kind,
    requiresVision: hasImage,
    designIntensive,
    sophisticatedDesign,
    needsLongContext,
    confidence,
    signals: unique(signals),
    reasons: unique(reasons),
    constraints,
    scope,
  }
}

/** Exposed for focused tests. */
export const __classifierInternals = { narrowCss, countCodeBlocks, countPaths, mechanicalPatterns }
