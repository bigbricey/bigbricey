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
**Not ready:** kids/COPPA Family Mode, paid multi-tenant security bar (see open risks).

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

- `api/chat.js` — chat + actions executor  
- `api/_llm.js` — OpenRouter + **DOMAIN_CONTRACT**  
- `api/_supabase.js` — data layer  
- `api/_capabilities.js` — capability catalog + SCENE_IDS  
- `public/app.js` — main UI  
- `public/scenes.js` — particle scenes  
- `public/theme.js`, `layout.js`, `boxes.js`  
- `supabase/migration_*.sql`

---

## Chat architecture (critical — 2026-07-14)

### Correct design (current intent)

1. User message → **LLM** (natural conversation + history).  
2. Model may return **free text** (chat) **or** JSON `{ "reply", "actions": [...] }` when changing app state.  
3. Server **shows the model’s text**. Never replace a good model answer with a canned menu.  
4. Server **executes** validated actions only (`set_scene`, food, theme, etc.).  
5. Optional thin fallback: clear “make it rain” apply if model forgot `set_scene`.

### What went wrong (fixed same day)

Earlier, regex **interceptors** answered before the LLM (scene lists, “are you there”, etc.), so the bot felt lobotomized.  
Also: “ONLY valid JSON” + `extractJson` failure → discarded model text → canned  
`I'm with you. Tell me what you want (log food…)` from `chatFallbackReply`.

**Fix commits (main):** through `05dd5b7` *Unlobotomize chat: free talk like Hermes…*  
Domain contract rewritten: **normal Q&A allowed**; hard limits = no invent macros, no fake SaaS/Windows builds, no medical orders.  
`parseModelChatResponse()`: free text → `{ reply: raw, actions: [] }`.

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

## Open risks (ChatGPT audit 2026-07-14 — still open unless marked)

**Urgent (do before paid users):**

1. **`saved_foods` no RLS** in `migration_005_saved_foods.sql` — anon grants risk. Enable RLS + policies; revoke anon write/read.  
2. **Local food keys date-only** (`public/app.js` `localKey`) — shared-browser account bleed if cloud empty uploads prior local. Namespace by user email/id.  
3. **Invite code in public docs** (`docs/INVITE-CODE.md`) — treat as public; rotate + rate-limit redeem.  
4. Empty `rows: []` POST can clear a day (`api/log.js` + `syncFoodDay`) — require explicit clear.  
5. Weak action schema / confirmations for destructive AI actions.  
6. OAuth `state` / fallback `AUTH_SECRET` string in code.  
7. No CI/test culture; README outdated.  
8. Child path: age clamped to 16 for BMR; not child-product ready.  
9. “Low carb today” rewrites baseline goals (not day override).  
10. Food scorer penalizes vegan/vegetarian text in `_lib.js`.

**Product direction:** Buddy Home (room, avatar, outfits) as curated layers — not MLP trademark preset; original pastel aesthetic if needed.

**Brice said:** privacy hotfix when he orders it — don’t only lecture.

---

## Deploy

```bash
cd /Users/bigbricey/Projects/nutri-table
# ensure .vercel points at project bigbricey
git push origin main
npx vercel --prod --yes
```

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
