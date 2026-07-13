# NutriTable Forever Log

## Goal
Decade-scale personal ledger: every food, workout, step count, body metric, and freeform thing you tell the app — graphable forever (potassium by month, magnesium trends, training volume, etc.).

## Supabase
- **Project:** NutriTable (`tutzgyolscfgqqatopzq`)
- **Org:** bigbricey's Org (Free) — Jax Sod project left alone
- **Deleted:** TaffyMem (freed the free-tier slot)

## Schema (core)
| Table | Purpose |
|-------|---------|
| `profiles` | Google user |
| `categories` | Auto-grows (food, exercise, steps, body, custom…) |
| `measures` | Auto-grows (kcal, potassium, steps, load_lb…) |
| `events` | Every log entry forever (`payload` JSONB + day_key) |
| `event_measures` | One row per nutrient/metric value (chart engine) |
| `day_totals` | Daily rollups for fast decade graphs |
| `chat_messages` | Optional transcript history |

## API
- `GET/POST /api/log` — load/sync today's food; log events; history via `?from=&to=&measure=`
- Chat understands food + `log_exercise` / `log_steps` / `log_metric`

## Security
- Browser never sees service role key
- Google session required; allowlist email
- RLS enabled; only service role via Vercel API

## Next build layers
1. History UI + charts (K / Mg / protein / steps over months/years)
2. Day picker / calendar library
3. Richer micronutrients from USDA when available
4. Export CSV / full dump
5. More auto-categories from natural language
