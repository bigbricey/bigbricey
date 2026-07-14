# BigBricey — AI handoff (read this first)

**Last updated:** 2026-07-14  
**Owner:** Brice (`bigbricey`)  
**Live site:** https://bigbricey.com  
**GitHub:** https://github.com/bigbricey/bigbricey  
**Local folder:** `/Users/bigbricey/Projects/nutri-table` (folder name is legacy; product is BigBricey)

Any AI picking up this project: start here. Do **not** trust the root README alone (it still mentions NutriTable/FitnessFixZone — outdated).

---

## What this product is

Private multi-user **fitness / food / life data ledger** with a chat coach that can:

- Log food (real lookup — never invent macros)
- Goals, layout, themes, custom boxes/charts
- Ambient **scenes** (rain, snow, desert, ocean, matrix, stars, confetti, fireflies, aurora, mist, neon_city)
- Chat history (multi-conversation), permanent memory notes, token metering
- Google OAuth + invite gate

**Vision:** highly customizable private “room” / buddy home — **not** freeform HTML/JS injection. Named themes/scenes/actions only.  
**Not ready:** kids/COPPA Family Mode or self-serve paid launch (see remaining product work).

**Brice rules (global):** he approves public/identity/money/signups; prefer shipping money-capable finished work; short answers unless he asks for detail; don’t load `AI-ARCHIVE-DO-NOT-AUTOLOAD` unless he asks.

---

## Stack

| Piece | Detail |
|--------|--------|
| Frontend | Static `public/*` (HTML/JS/CSS), no heavy framework |
| API | Vercel serverless `api/*` |
| Auth | Google OAuth (`api/auth/*`), session cookie |
| DB | Supabase (service role server-side) |
| LLM | OpenRouter, model env `OPENROUTER_MODEL` default `z-ai/glm-5.2` |
| Deploy | Vercel project **bigbricey** only (`prj_M5m6W3qfa0j240nRfX2So51W17vi`) |

Key files:

- `api/chat.js` — authenticated orchestration + action executor
- `api/_buddy_prompt.js` — natural buddy system prompt
- `api/_tool_contracts.js` — closed native-tool schemas
- `api/_native_tool_loop.js` — verified tool-result truth layer
- `api/_llm.js` — OpenRouter transport + **DOMAIN_CONTRACT**
- `api/_supabase.js` — data layer  
- `api/_capabilities.js` — capability catalog + SCENE_IDS  
- `public/app.js` — main UI  
- `public/boxes.js` — real metric-backed counters/charts
- `public/scenes.js` — particle scenes  
- `public/theme.js`, `layout.js`, `boxes.js`  
- `supabase/migration_*.sql`

---

## Chat architecture (critical — 2026-07-14)

### Correct design (current intent)

1. Authenticated user message → **LLM first** with bounded history and app state.
2. Ordinary conversation returns normal text. App reads/changes use OpenRouter's native tool calls.
3. Every call is checked against a small closed schema; unknown tools/fields reject the entire batch.
4. Destructive calls pause on a signed, call-bound confirmation.
5. The server executes approved calls against account-scoped data. Food and other events use transactional PostgreSQL functions.
6. A second model pass sees only verified tool-result envelopes. A success claim is never shown unless the executor produced a real receipt.

Native tools now include `set_tracker` / confirmation-gated `remove_tracker`.
They connect the LLM to the existing custom counter/chart renderer, so requests
such as “make a 30-day weight chart” create a real persisted dashboard panel.
Missing measurement days remain missing (never fake zeroes), and charts show a
text summary of recorded points as well as the canvas visualization.

Do not restore pseudo-JSON action prompting or regex/menu interceptors. Regex scene handling is outage-only fallback, never the normal conversation path.

### What went wrong (fixed)

Earlier, regex **interceptors** answered before the LLM (scene lists, “are you there”, etc.), so the bot felt lobotomized.  
Also: “ONLY valid JSON” + `extractJson` failure → discarded model text → canned  
`I'm with you. Tell me what you want (log food…)` from `chatFallbackReply`.

**Fix commits (main):** through `05dd5b7` *Unlobotomize chat: free talk like Hermes…*  
Domain contract rewritten: **normal Q&A allowed**; hard limits = no invent macros, no fake SaaS/Windows builds, no medical orders.  
The current implementation uses native provider tools instead of model-authored pseudo-JSON.

### Memory

- **In-product chat history:** Supabase `chat_conversations` / `chat_messages` (migration 007).  
- **Permanent notes:** `prefs.memory_notes` via remember/forget actions.  
- **Scenes tried:** `prefs.scene`, `prefs.scenes_seen`.  
- **This Grok session** is **not** automatically in Supabase — use this handoff + git for cross-AI continuity.

---

## Scenes

Implemented in `public/scenes.js` + CSS `#sceneFx`. IDs in `SCENE_IDS`.  
Apply via chat `set_scene` or You-tab UI.  
Bug fixed earlier: `stop()` cleared `data-scene` so canvas stayed hidden.

---

## Security/reliability repair (2026-07-14)

Implemented in migrations 009/010 and the matching API/frontend release:

- Saved-food and private helper tables deny browser roles; invite redemption is atomic and rate-limited; every previously published code is disabled.
- Local food, theme, layout, scene, box, and conversation storage is account-scoped. Unattributed legacy browser data is quarantined, never auto-uploaded.
- Empty food-day writes require an explicit clear. Food snapshots use revisions so stale tabs reload instead of overwriting newer data.
- Food and non-food writes are transactional/idempotent, historical totals are repaired, and UI/chat success text follows the database receipt.
- Destructive AI tools use signed confirmations; native tool inputs are strict and bounded.
- OAuth uses cookie-bound random state, requires Google's boolean verified-email claim, and session signing fails closed without a strong secret.
- Prompt/history/read results are bounded; paid model work has atomic per-user minute/day/token reservations.
- Missing nutrients remain unknown instead of becoming zero.
- Food matches with unrelated product forms (for example pure salt matching a
  popcorn product) are rejected before the ledger changes. Generic pieces,
  cups, teaspoons, and servings no longer receive invented 100 g/household
  weights; exact mass or a verified fixed basis is required.
- The live model window and deterministic conversation excerpt now meet at the
  same 24-message boundary, removing the former blind middle of a long chat.
- Automated tests cover chat behavior, tools, auth/privacy, concurrency contracts, frontend account/day binding, and nutrient knownness.

### Remaining product work (not release regressions)

1. This is adult-only today. Do not market or onboard it as a child product until consent, privacy, and age-appropriate goal logic are designed.
2. “Change my goals today” still changes the baseline profile; per-day goal overrides are a future feature.
3. Home customization is curated themes/scenes/layout today, not arbitrary generated backgrounds, avatar outfits, or user HTML/CSS/JS.
4. Billing, self-serve signup, account deletion/export policy, support operations, and production monitoring still need a deliberate commercial launch pass.

**Product direction:** Buddy Home (room, avatar, outfits) as curated layers — not MLP trademark preset; original pastel aesthetic if needed.

**Brice said:** privacy hotfix when he orders it — don’t only lecture.

---

## Deploy

Production database status on 2026-07-14:

- Migrations 009 and 010 are applied.
- All previously published invite codes are disabled. The active private beta code is stored in the Mac Keychain under `BigBricey Private Beta Invite`, never in Git.
- Post-migration verification preserved 47 events and 394 measures, rebuilt 10 total rows, found all 7 required RPCs, and confirmed browser roles cannot execute them or read saved foods.
- The full automated suite passes: 131 tests.

For a fresh database, preserve this order: migration 009, private invite creation outside Git, then migration 010. Deploy only to the Vercel project named `bigbricey` and smoke-test the signed-in app after every server release.

For local development use `npm run dev` (Vercel's local runtime), not the legacy `server.js` parser harness.

Env (Vercel): `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, Supabase, Google OAuth, `AUTH_SECRET`, etc.

---

## Working with Brice

- Short answers unless he asks for detail.  
- If he asks “is this saved / can other AIs see it?” → **save to this repo + push**, don’t only explain.  
- He approves public/identity/money/signups.  
- Prefer finished shippable work.

---

## Session log pointer

See `docs/SESSION-LOG-2026-07-14.md` for the long session narrative (scenes + chat lobotomy fix + audit summary).
