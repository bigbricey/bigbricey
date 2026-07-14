# BigBricey

Private fitness / food / life data ledger with a chat coach (themes, layout, scenes, custom boxes).

| | |
|--|--|
| **Live** | https://bigbricey.com |
| **GitHub** | https://github.com/bigbricey/bigbricey |
| **Local** | `Projects/nutri-table` (legacy folder name) |

## For AIs / new humans

**Start here:** [`docs/AI-HANDOFF.md`](docs/AI-HANDOFF.md)  
Session continuity: [`docs/SESSION-LOG-2026-07-14.md`](docs/SESSION-LOG-2026-07-14.md)  
Agent rules: [`AGENTS.md`](AGENTS.md)

## Stack (short)

- Static frontend: `public/`
- Vercel serverless API: `api/`
- Supabase: `supabase/`
- LLM: OpenRouter (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL` — default `z-ai/glm-5.2`)

## Local

```bash
cp .env.example .env   # fill keys
npm install
# use Vercel CLI / serverless locally as you prefer
```

## Deploy

Vercel project **bigbricey** only:

```bash
git push origin main
npx vercel --prod --yes
```

## Note

Older docs may say NutriTable / FitnessFixZone — that branding is legacy. Product name is **BigBricey**.
