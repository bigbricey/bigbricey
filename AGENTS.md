# AGENTS.md — BigBricey

**Read first:** [`docs/AI-HANDOFF.md`](docs/AI-HANDOFF.md)  
**Latest session:** [`docs/SESSION-LOG-2026-07-14.md`](docs/SESSION-LOG-2026-07-14.md)

## Identity
- Product: **BigBricey** (private fitness/food ledger + chat).  
- Repo on GitHub: `bigbricey/bigbricey`.  
- Local path may still be `Projects/nutri-table`.  
- Live: https://bigbricey.com  

## Rules for agents
1. Prefer shipping finished work. Brice approves public / identity / money / signups.  
2. Short answers unless he asks for detail.  
3. If he asks “is this saved / can another AI see it?” → **update handoff docs + commit + push**. Do not only explain.  
4. Chat must stay **LLM-first** (free conversation). Do not reintroduce regex that answers before the model. Code executes validated actions after the model.  
5. Never invent food macros.  
6. Do not load `AI-ARCHIVE-DO-NOT-AUTOLOAD` unless Brice explicitly asks.  
7. Vercel deploy only to project **bigbricey**, not leftover nutri-table projects.  

## Stack pointer
- Chat: `api/chat.js`, LLM: `api/_llm.js`  
- Scenes: `public/scenes.js`  
- Migrations: `supabase/`  
