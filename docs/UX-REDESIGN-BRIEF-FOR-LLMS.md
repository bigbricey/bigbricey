# NutriTable UX redesign brief (paste into other LLMs)

**Product:** NutriTable at https://www.fitnessfixzone.com  
**Owner metaphor:** Current feel = crappy McDonald’s (busy, plain, stressful). Target = Ruth’s Chris (calm, premium, intentional, you *want* to be there).  
**Not:** a landscaping/sod website. This is a private lifelong health/food/training ledger.

## What it does today (keep the brain, rethink the face)
- Google sign-in, invite-only (active codes are stored outside the repository)
- Conversational coach chat: log food, workouts, steps, watches
- Day calendar strip + date picker
- Macro totals (kcal, protein, fat, carbs, fiber, K, Mg, Na)
- Sortable food table
- Watches (rolling averages vs floors)
- Alerts inbox
- Trends chart (7/30/90d)
- Cloud forever log (Supabase), private per user
- Admin-only friend suggestions panel

## Current UI problems (owner feedback)
- Doesn’t look cool or inviting
- Too much stuff on one long page
- Hard to see / visual hierarchy is weak
- Feels like a stack of admin panels, not a premium product
- Dense gray boxes, similar sections, no breathing room
- Looks “built by engineers,” not designed

## Current layout order (app after login)
1. Header (title, status chips, log out)
2. Calendar strip
3. Chat coach
4. Totals row (8 metric tiles)
5. Alerts
6. Friend suggestions (admin)
7. Watches + form
8. Trends chart
9. Food table
10. Footer (clear day)

## Constraints
- Must stay mobile-friendly (phone + PWA)
- Chat-first logging is a core strength — don’t kill it
- Don’t require a full rewrite of backend/auth/DB
- Prefer progressive disclosure over showing every feature at once
- Performance matters (not a 3D minigame that kills phones)
- Health philosophy: useful, not hypochondria; metabolic-friendly framing when relevant

## What we want from you
1. Ruth’s Chris vs McDonald’s diagnosis of the current IA/UI
2. A proposed information architecture (what’s primary / secondary / hidden)
3. A concrete screen map (Home / Log day / Trends / Settings)
4. Visual direction (type, color, spacing, motion — tasteful, not gimmicky)
5. Mobile-first interaction flow for “I just ate X”
6. What to remove, merge, or demote
7. 3 ranked redesign concepts (A safe / B premium / C bold)
8. A phased plan: quick wins vs deeper work
9. Do NOT invent fake features we don’t have; redesign what exists first

## Output format
- Bullet diagnosis
- Wireframe-in-words (section by section)
- Priority list (P0 / P1 / P2)
- Short “north star” one-liner for the product feel
