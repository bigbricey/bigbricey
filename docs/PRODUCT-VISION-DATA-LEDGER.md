# NutriTable product vision (living data ledger)

Planning notes — not legal advice.

## What this product is
- A **forever health/nutrition data OS**: food, training, weight, minerals, stress notes, goals.
- A **specialized agent** that logs, categorizes, totals, exports, and cites factual baselines.
- **Not** a general chatbot, therapist, business advisor, or “build me a SaaS” tool.

## What this product is not
- Not medical diagnosis or treatment.
- Not marriage counseling (may **log** “argument → stress” as context only).
- Not calorie moralizing or Ancel Keys fat-scare doctrine.
- Not forcing vegan / carnivore / any diet religion.

## Onboarding (v2)
Required: consent, name, **sex (male/female only)**, birthday/age, height, weight, goal,
**daily activity level**, **training level**, optional eating style, confirm **calorie target**.
Estimates use Mifflin + activity/training multipliers with **safety floors**.
User-confirmed kcal always wins over raw formula.

## Future
- Export “print my month / year” packs for doctors or external agents (Grok/ChatGPT/Claude).
- MCP / API so other agents can read/write **this** ledger.
- Adaptive TDEE from logged intake + weight over time.
- Provider-agnostic LLM wrapper (GLM today, swap later) + tool allowlist + knowledge snippets (Bikman et al.).
