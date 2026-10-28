# Approved model registry

The router starts from a curated seed and merges live metadata from OpenCode. A model is eligible only when it is approved here, present in the connected provider catalog, and meets every task requirement.

## Scoring

- **Intelligence** is a curated coding-intelligence score. Where available it comes from Command Code's published model cards. The standard floor is **39.5**, the DeepSeek V4.1 Flash score. It is not a general "best model" score.
- **Design** is a separate curated score for front-end and UX quality. It is not benchmarked by the same method as intelligence.
- **Vision** means the model accepts native image input in the live catalog.
- **Premium** is a policy label for high-cost models. A premium model is never selected for economy or ordinary standard work.
- **Monthly allowance** is public-rate usage included by the subscription. OpenCode Go values are from the Go Plus table. Command Code values are the GOAT per-model allowances. Provider-reported totals override these numbers for the plan-level balance.

These scores are planning inputs, not marketing claims. Models marked **unverified** or **unscored** are not approved for automatic substantive work.

## Economy (Tier 1)

Used only for narrow, mechanically verifiable work with an explicit scope and deterministic validation.

| Provider / model | Intelligence | Design | Vision | Monthly allowance |
|---|---:|---:|---|---:|
| `opencode-go/gpt-6-luna` | 38.1 | 55 | text, image, PDF | $60 |
| `opencode-go/mimo-v2.6-flash` | 37.9 | 50 | text, image, audio, video | $120 |
| `opencode-go/hy3` | 25.3 | 45 | text | $240 |
| `opencode-go/longcat-2.0` | 19.1 | 40 | text | $240 |
| `commandcode/gpt-6-luna` | 38.1 | 55 | text, image, PDF | $20 |

These models are below the standard intelligence floor. They cannot be selected for feature work, debugging, refactoring, architecture, security, or tests.

## Standard (Tier 2)

The default for substantive software engineering. Every model here meets or exceeds the DeepSeek V4.1 Flash floor.

| Provider / model | Intelligence | Design | Vision | Monthly allowance |
|---|---:|---:|---|---:|
| `opencode-go/deepseek-v4.1-flash` | 39.5 | 65 | text, image | $160 |
| `opencode-go/glm-5.3-flash` | 41.8 | 65 | text, image, video | $180 |
| `opencode-go/minimax-m3.1-flash` | 42.7 | 60 | text, image, video | $80 |
| `opencode-go/claude-haiku-5-5` | 43.4 | 70 | text, image, PDF | $60 |
| `opencode-go/mimo-v2.6-pro` | 46.3 | 62 | text, image, audio, video | $60 |
| `commandcode/deepseek-v4.1-flash` | 39.5 | 65 | text, image | $80 |
| `commandcode/z-ai/glm-5.3-flash` | 41.8 | 65 | text, image, video, PDF | $80 |
| `commandcode/claude-haiku-5-5` | 43.4 | 70 | text, image, PDF | $20 |

Design-intensive work requires at least a 60 design score. Sophisticated design work requires at least 75. A standard model below 75 still requires premium approval for sophisticated design.

## Premium (Tier 3)

Premium models are available only when:

- the task is premium-tier or the user explicitly asks for a premium model,
- `premium.mode` is not `off`,
- and either a one-shot approval is active for the session or Premium Allowed mode has a remaining configured budget.

They are never used for trivial or ordinary standard work. They are never selected silently.

| Provider / model | Intelligence | Design | Vision | Monthly allowance |
|---|---:|---:|---|---:|
| `opencode-go/glm-5.3` | 44.8 | 80 | text | $120 |
| `opencode-go/kimi-k3` | 43.6 | 72 | text, image, video | $60 |
| `opencode-go/grok-4.7` | 46.4 | 75 | text, image, PDF | $60 |
| `opencode-go/qwen3.8-max` | 40.2 | 70 | text, image, video | $60 |
| `opencode-go/step-5-preview` | 43.7 | 70 | text, image, video | $60 |
| `commandcode/claude-sonnet-5-5` | 56.0 | 90 | text, image, PDF | $10 |
| `commandcode/meta/muse-spark-1.3` | 48.1 | 82 | text, image, video, PDF, audio | $20 |
| `commandcode/xai/grok-4.7` | 46.4 | 75 | text, image, PDF | $20 |
| `commandcode/Qwen/Qwen3.8-Max` | 40.2 | 70 | text, image, video, PDF | $20 |
| `commandcode/stepfun/Step-5-Preview` | 43.7 | 70 | text, image, video | $20 |

`opencode-go/glm-5.3` is text-only and can never receive a screenshot, even if its intelligence would otherwise qualify. This is enforced as a hard vision rule.

## Known but unapproved

These models are discovered but deliberately excluded from automatic routing:

- `commandcode/google/gemini-4-argon`, `opencode-go/gemini-4-argon`: unscored in the current model cards.
- `commandcode/claude-opus-5-5`, `commandcode/gpt-6.1-sol`, `commandcode/gpt-6-astra`, `commandcode/claude-fable-5-1`: frontier-priced and unscored here. They require explicit user qualification.
- `opencode-go/kimi-k3.1-pro`: unscored.
- `opencode-go/deepseek-v4-pro`: below the current floor and text only.
- `commandcode/deepseek/deepseek-v4.1-flash`: duplicate route for the same upstream model; the GOAT ID is approved instead.
- `meta/muse-spark-1.3-contributor`, `opencode-go/muse-spark-1.3-contributor`, `opencode-go/iceman-contributor-free`: training-enabled. Blocked unless `privacy.allowTrainingModels` is explicitly enabled.
- `opencode-go/beam-free`: free promotional model, not qualified for automatic work.

## Changing the registry

Use `/router-exclude provider/model` to remove a model from automatic routing. To approve a discovered model, add its exact key to `models.approved` in `~/.config/opencode/smart-router.json` and assign it a tier in `models.tierOverrides`. A discovered model without a tier remains unapproved.

Do not approve a model solely because it is cheaper or newer. Qualify it on real tasks first.

## User-defined model definitions

If a provider exposes a model that is not in the seed, qualify it explicitly in `models.definitions`. A definition is metadata, not a new provider or a proxy. The model still comes from the connected provider catalog.

```jsonc
{
  "models": {
    "definitions": [
      {
        "key": "acme/coder-v2",
        "providerID": "acme",
        "modelID": "coder-v2",
        "name": "Acme Coder V2",
        "context": 200000,
        "maxOutput": 32768,
        "input": ["text", "image"],
        "cost": [{ "input": 0.2, "output": 0.8, "cache": { "read": 0.02, "write": 0 } }],
        "intelligence": 41.0,
        "design": 60,
        "tier": 2,
        "approved": true,
        "monthlyAllowanceUsd": 100
      }
    ]
  }
}
```

Definitions are merged with the seed and live catalog. `tier` is required; `approved` defaults to true only because the definition itself is an explicit qualification. Do not add a definition for a model you have not tested.
