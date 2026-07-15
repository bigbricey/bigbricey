# Session log — 2026-07-14 (Grok Build + Brice)

Cross-AI continuity. Local Grok session is ephemeral; **this file + git are the durable record.**

## Product state at end of session

- Live: **bigbricey.com** (Vercel project `bigbricey`)  
- Repo: **github.com/bigbricey/bigbricey** `main`  
- Local: `/Users/bigbricey/Projects/nutri-table`  
- Latest chat architecture commit family: `05dd5b7` unlobotomize free talk  

## What we built / fixed today (this session)

### Scenes UX
- Snow/rain/ocean particle scenes; “make it snow” was broken (canvas hidden by `data-scene=none` after stop; model said “let it snow” without action).  
- Fixed apply path; made snow more visible.  
- Then over-engineered **regex scene list robots** that:
  - Re-applied snow when user *mentioned* snow  
  - Ignored “already seen X”  
  - Forced “skipping what you saw” when user asked for full list / top 3  
- Brice correctly identified this as **not letting the LLM think**.  

### Chat lobotomy diagnosis
- Same OpenRouter model as Hermes (`z-ai/glm-5.2` via env).  
- Wrapper required JSON; on parse fail, discarded model text → canned  
  `I'm with you. Tell me what you want (log food, switch scene…)`.  
- User saw robot, not GLM.  

### Chat fix (shipped)
- Free text = valid reply.  
- JSON `{reply, actions}` when mutating app.  
- Domain contract: talk about anything normal; refuse invent macros / fake SaaS builds / medical orders.  
- Temperature 0.6.  
- History still injected from Supabase + permanent memory notes.  

### Grok Build CLI
- Updated machine to **0.2.101** (was 0.2.99). Model in Grok sessions: **grok-4.5**.  

### External audit (ChatGPT — not applied by that model)
- Kept codebase; urgent privacy: RLS on `saved_foods`, user-scoped localStorage, invite rotation, day-clear safety.  
- Buddy Home as next product layer.  
- Brice deferred “do privacy hotfix” until he says so.  

## Open next work (priority)

1. Emergency privacy repair (RLS, local keys, invite, empty-day clear).  
2. Ledger safety (confirm clear/delete, action schemas).  
3. Adult-only stabilize tests/CI/README.  
4. Buddy Home product layer.  
5. Family mode later (COPPA-real).  

## Brice process note

When he asks whether work is saved for other AIs — **write docs + git push**, don’t only describe gaps. Obsidian was **not** auto-synced this session.

## Codex human-style production test and repair

- Reproduced the signed-in failure: a 30-day weight-chart request was honestly
  refused because chart code existed but was absent from the native tool catalog.
- Reproduced a ledger accuracy failure: “Himalayan pink salt” was committed as
  a popcorn product; a half stick of butter also selected a light-butter 100 g
  basis, and one fillet was treated as a guessed serving.
- Permanent memory itself worked across a brand-new conversation. The remaining
  continuity defect was inside long conversations: storage kept 120 messages,
  the model used 24, and summarization did not start until later.
- Added strict native dashboard tracker/chart tools, truthful tool receipts, and
  confirmation-gated removal. Weight charts use recorded `weight_lb` points,
  never zero-fill missing days, use a focused trend scale, and expose a plain-text
  latest/change summary.
- First production retest created the real panel but exposed two follow-up bugs:
  a `setBoxes(list)` name collision raised “list is not a function,” and the
  daily rollup summed 220 + 215 into a fake 435 lb. The client collision was
  removed, and body-state chart/counter/watch reads now select the latest daily
  reading while additive measures keep sum semantics.
- Added semantic food-match rejection and exact quantity-basis rules. Ambiguous
  fillets/teaspoons/servings now ask for label weight instead of silently guessing.
- Aligned long-chat excerpting to the actual 24-message model window and kept
  the most recent excluded context in the bounded prompt.

## Codex session (evening) + Grok resume — 2026-07-14

**Codex session ID:** `019f5e0e-9d09-79a1-abfe-22d58a80c8ff`  
**Resumed into Grok Build** with `/resume-codex` (this continuity note).

### What Codex shipped
- Reverted the **Living World / Rainbow Pony Kingdom** gimmick card (wrong product interpretation).
- Shipped **verified food-logging feedback**: receipt with calories/macros, real dashboard reaction, background = real page atmosphere (not a fake kingdom box).
- Git `main` at handoff time: `7586f4a` *Improve verified food logging feedback* (working tree clean).

### What Codex built after the design
Photo / barcode food logging architecture and release:

1. **Chat brain:** keep `z-ai/glm-5.2` (text).
2. **Vision model (separate env):** `google/gemini-3.1-flash-lite` via OpenRouter, with `google/gemini-2.5-flash` fallback. GLM remains the normal chat model.
3. **Pipeline:** photo or barcode or nutrition label → identify → **nutrition DB** (saved foods → Open Food Facts → USDA) → editable confirm card → log. Models never invent macros from pixels alone.
4. **Meal path:** vision identifies components and honest gram ranges; saved foods/Open Food Facts/USDA supply nutrition. Official web search is a bounded branded-food fallback, never a silent macro invention.
5. **Label path:** copies only clearly printed per-serving values; unread nutrients remain unknown.
6. **Barcode path:** validates the GTIN check digit and requires an exact Open Food Facts v3 or USDA match. Missing serving weight requires the user to enter grams.
7. **Safety/UI:** the camera opens three explicit modes, every result is an editable draft, and nothing reaches the ledger until the user confirms. Async results are bound to the initiating account/day/conversation.
8. **Calibration:** meaningful meal-portion corrections are stored as bounded profile hints for later estimates; photos are not written to the account or ledger.
9. **Verification:** the real vision model accepted image + strict JSON input, a live Nutella barcode resolved through Open Food Facts, the browser preview rescaled 180 g → 200 g correctly, deselection worked, and only the confirmed item entered the mock ledger. Full suite: 150 tests.

### Product goal (Brice — durable)
Sellable private AI buddy home for food + workouts; customizable atmosphere (e.g. kid-friendly themes); **not** a general agent that builds SaaS or answers anything. Curated themes/scenes — not arbitrary user HTML/JS. Family/kids mode later (COPPA-real).

### Next vision work
Use real-world plate and label photos in production, collect correction patterns, and tune prompts/model choice from measured failure cases rather than guessing.
