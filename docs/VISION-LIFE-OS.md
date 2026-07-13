# Life OS / NutriTable — forever personal health graph

Saved 2026-07-12 from Brice’s direction + architecture session.

## Mind map vs our spider web
- **Mind map** (classic): a visual map of *ideas* around a center — branches of related concepts (NotebookLM style). Good for brainstorming knowledge.
- **Our life graph**: same *shape* (nodes + links), but nodes are **real personal data over time** (foods, workouts, symptoms, labs, supplements), and links can be:
  - obvious similarity (bacon ↔ pork), **or**
  - **discovered couplings** (low K + high steps ↔ cramps) that don’t “look” related until time + dose connect them.

So: mind map = idea web. Life graph = **time-stamped evidence web**.

## Product north star
Personal longevity telemetry — not hypochondria.
- User-set watches first (e.g. K ≥ 3500mg/day rolling 7d)
- Severity codes later (yellow → orange → red) with evidence
- Philosophy filter: Bikman, D’Agostino, Volek, Phinney; low-carb-friendly; no fat-scare sermons
- Optional future: science digest, wearables (Watch / Oura / phone steps / glasses)
- Multiplayer benchmarks: **deferred** — lying / selection bias can poison averages

## Non-negotiables
1. Append-only forever ledger
2. Auto-grow categories & measures from chat (bike, climb, TRT, sushi subtypes…)
3. Clarify incomplete foods (what kind of sushi?) before inventing macros
4. AI proposes; server looks up nutrition; DB stores truth
5. Notification severity is a user setting (later)

## Phases
0 Spine — done (events, measures, day_totals, food sync)
1 Watch targets + rolling status + stronger auto-category chat — **now**
2 Charts / calendar / alert inbox
3 Coupling mind-map UI + detectors
4 Labs, wearables, science digest job
5 Population insights only with quality filters (maybe never)

## Far back burner (do not build early)
- **Referral / real-product share** (invite earn %, optional affiliate products like shakers — *not* fake MLM).  
  Full notes: `docs/BACKBURNER-REFERRAL-AFFILIATE.md`  
  Revisit only after product is sticky and revenue exists.

## Impossible / hard honesty
- True “this will extend your life” claims — no software can promise that
- Perfect causal discovery with sparse early data — needs years of density
- Continuous medical-grade monitoring without wearables/labs — limited to what you log
- Trustworthy “average guy your age” from open user base — easy to corrupt; design carefully or skip
