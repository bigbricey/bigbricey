# NutriTable design direction (living notes)

**Updated:** 2026-07-13  
**Invite code:** `BRICESFAMILY` (see INVITE-CODE.md)

## Product
Private lifelong health ledger at fitnessfixzone.com. Chat-first logging (food, workouts, steps, watches). Cloud per-user privacy. Invite-only.

## What Brice hates
- Cramped UI — too much stuck together
- Looking “crappy,” cheap, not inviting
- Half-measures (e.g. orbit gimmick on same ugly shell = “whipped cream on shit”)
- Leading design toward “steakhouse” aesthetics from a quality metaphor (ignore that framing for style)

## What Brice wants
- **Coach chat is #1** — first thing you see; assistant builds/updates the day
- **Breathing room** — not cramped
- Full visual revamp that actually feels cool / badass / premium-quality (as in people would pay), not a restaurant theme
- Easy to try directions and throw away if wrong
- Remember invite + referral back-burner ideas

## Current IA (post revamp)
- Tabs: Today | Trends | Goals | You
- Today should prioritize: **Coach → then totals → then plate**
- Dense table / admin / clear day off main path

## Backend (do not casually rewrite)
Auth Google, invite redeem, Supabase events/measures/watches, chat API, log sync.

## Next iteration focus
1. Chat first on Today (top of screen) — done
2. More whitespace / less density — ongoing
3. MFP-like dashboard below chat: calorie remaining ring, macro rings, minerals always free — in progress
4. Delete only after confirm dialog; fix double-delete / unique ids
5. Manual add optional; AI is primary logger

## Reference UX (user browsing)
- MyFitnessPal Today: big calorie remaining ring + macros rings + summary cards
- Keep our dark colors; no paywall blur on minerals
- Coach chat stays above dashboard
