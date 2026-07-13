# NutriTable — Plan (Brice)

Smart living nutrition table: type/say food → row appears → totals + sortable columns.  
Phone + computer. Not a general chatbot. Not MyFitnessPal clone — a clean Bikman-friendly amounts table.

---

## Goal (v1 you can use daily)

1. Open on **computer or phone** (browser + “Add to Home Screen” = fake app icon).
2. **Type a food** (“1 lb bacon”, “6 eggs”, “3 scoops HLTH Code”).
3. App uses **OpenRouter → DeepSeek** only to **parse** what you meant (food + amount + unit).
4. Looks up real numbers from **USDA FoodData Central** (free) — LLM does **not** invent macros.
5. Adds a row; **totals** update (kcal, protein, fat, carbs, fiber, K, Mg, sodium…).
6. **Click column headers** to sort (same as your HTML chart).
7. **Add / remove** rows; save your day.
8. Later: login so phone + laptop share the same log.

---

## What we will NOT build in v1

- Barcode scanner (v2)
- Social / friends
- Recipe social network
- Open chat about Rome / anything non-food
- Fat-scare / Keys-era lectures in the UI

---

## Architecture

```
[Phone / Desktop browser or PWA]
        │
        ▼
[NutriTable web app]
  - Living table UI (sort, totals, add/remove)
  - Voice optional later (Web Speech API)
        │
        ▼
[Our small backend API]
  - POST /api/parse-food   → OpenRouter (DeepSeek) → structured JSON
  - GET  /api/usda-search  → FoodData Central
  - POST /api/resolve      → parse + best USDA match + nutrients
  - Auth later             → login / save days
        │
        ├── OpenRouter API key (server-side only, never in phone browser)
        └── USDA FDC API (free, optional API key for higher limits)
```

**Rule:** LLM = language → structured request. **Database = truth for numbers.**

---

## Tech stack (practical)

| Layer | Choice | Why |
|--------|--------|-----|
| Frontend | Vite + React (or plain HTML if we stay tiny) | Fast, PWA-friendly |
| PWA | `manifest.json` + service worker | “Add to Home Screen” on iPhone/Android |
| Backend | Small Node server (or Next.js API routes) | Hides OpenRouter key |
| LLM | OpenRouter → DeepSeek model you pick | Cheap parse step |
| Nutrients | USDA FoodData Central | Free, official-ish |
| Storage v1 | Browser localStorage / IndexedDB | Works offline-ish immediately |
| Storage v2 | Account + cloud DB (e.g. Supabase) | Same log on phone + laptop |
| Hosting | Vercel / Railway / Cloudflare later | Public URL for phone |

---

## Build phases

### Phase 0 — Foundations (now)
- [x] Project folder + this plan
- [ ] App skeleton (UI shell: table, totals, add box)
- [ ] Sortable headers (port from your produce chart)
- [ ] Manual “add row” with typed numbers (works before AI)

### Phase 1 — Smart add (your daily driver)
- [ ] Hook **OpenRouter** key from `.env` (you provide key when ready)
- [ ] DeepSeek model id you choose
- [ ] System prompt: **only** food parse JSON — refuse off-topic
- [ ] USDA search + pick best match
- [ ] Show match + nutrients → confirm or edit → add row
- [ ] Day totals bar
- [ ] Save day locally

### Phase 2 — Phone “app”
- [ ] PWA manifest + icons
- [ ] Install instructions (iOS Share → Add to Home Screen; Android Install app)
- [ ] Mobile layout (big add box, fat-finger remove)

### Phase 3 — Login + sync
- [ ] Simple auth (email magic link or password)
- [ ] Cloud save of daily logs
- [ ] Same account on phone + computer

### Phase 4 — Money later (optional product)
- [ ] Subscription gate (Stripe)
- [ ] Free tier: X adds/day
- [ ] Paid: unlimited + history
- Only after **you** use it for real and like it

---

## OpenRouter / DeepSeek (when you say go)

You’ll provide:
1. OpenRouter API key  
2. Exact model slug (e.g. whatever current DeepSeek Flash/Chat is on OpenRouter)

We store in `.env`:
```
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...
```
Never ship the key inside the phone webpage.

Parse output shape (example):
```json
{
  "food_query": "beef bacon",
  "amount": 1,
  "unit": "lb",
  "grams": 453.6,
  "notes": "package as purchased"
}
```

---

## Health filter (your rules baked into product)

- Amounts-first UI — no sat-fat scare copy  
- Optional later: D’Agostino / Bikman-aligned tips only if you ask  
- Occasional pizza is fine contextually — app doesn’t lecture  

---

## Success criteria (v1 done)

You can, on your phone after one save-to-home-screen:

1. Type “6 eggs” → row appears with real-ish macros  
2. Type “1 lb bacon” → row appears  
3. See **day total** kcal / protein / fat  
4. Sort by potassium  
5. Delete a row  
6. Close app, reopen same day still there (local save)

---

## Next action after you approve this plan

1. Scaffold runnable app on your Mac  
2. Port sortable table + totals  
3. Add food input box (manual first)  
4. Wire OpenRouter when you drop the key + model name  

---

## Risks (honest)

| Risk | Mitigation |
|------|------------|
| LLM invents calories | Never trust LLM for numbers — USDA only |
| “HLTH Code” not in USDA | Custom foods library you teach once |
| Cost | Parse-only LLM + cache results |
| iPhone PWA limits | Still works great as home-screen web app |

---

**Bottom line:** Yes — full plan exists. Build path is clear. Phone “sneaky app” = **PWA / Add to Home Screen**. AI = OpenRouter DeepSeek for parsing only. Your chart becomes a living daily log.
