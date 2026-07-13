# Onboarding profile (migration 004 — no SQL required)

Onboarding data is stored in existing `profiles.prefs` JSONB:

```json
{
  "onboarding": {
    "complete": true,
    "completed_at": "2026-07-13T…",
    "first_name": "Brice",
    "primary_goal": "lose",
    "lose_rate_lb_week": 1,
    "obstacles": ["lack_of_time", "cravings"],
    "confidence": "somewhat",
    "birthday": "1985-06-01",
    "sex": "male",
    "height_in": 70,
    "current_weight_lb": 210,
    "goal_weight_lb": 185,
    "goals": { "kcal": 2100, "protein": 160, "fat": 90, "carbs": 40, … }
  }
}
```

Screens mirrored from Lose It (more can be appended later):
1. Welcome
2. First name
3. Primary goal (lose / maintain / build muscle — never “gain weight”)
3b. If lose → weekly pace (0.5 / 1 / 1.5 / 2 lb per week)
4. Obstacles (multi)
5. Confidence
6. Birthday
7. Sex
8. Height
9. Current weight
10. Goal weight

Coach (`api/chat.js`) injects this block so the bot knows who it’s talking to.
App gates incomplete members to `/onboarding.html`.
