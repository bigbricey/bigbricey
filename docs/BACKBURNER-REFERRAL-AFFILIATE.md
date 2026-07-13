# Back burner: referral + real-product share (not fake MLM)

**Saved:** 2026-07-13  
**Status:** Idea only — do **not** build until the app is solid and making money.  
**Owner intent:** Help friends/family (incl. people in other countries) earn from *real* value, not hype.

## What Brice wants (in his words)
- Signup / invite chain where the person who brought someone in can earn a **share of payment** or related revenue.
- Not classic scummy multi-level marketing — the product has to be **real and useful** (this health ledger).
- Extra angle: **add-ons / suggestions** (e.g. protein shaker bottle, supplements, gear) where:
  - There is affiliate or product revenue
  - The inviter gets a **good portion** of that cut
  - Brice may take a smaller slice
- Long-term good: people help others join and can make money honestly, including folks abroad.

## Cleaner framing than “MLM”
Call it something like:
- **Referral program** (pay for paid plan conversion)
- **Affiliate product shelf** (curated, optional product links with tracking)
- **1-level or 2-level max** if sharing invites — deeper pyramids get legally and reputationally ugly

Prefer:
1. **Level 1 only first:** A invites B → A earns % of B’s sub / first year  
2. **Optional product affiliate:** A’s link on a shaker / book / device → A earns affiliate commission (plus small platform fee)  
3. **No pay-to-play**, no inventory dumping, no “recruit harder than use the product”

## When to revisit
- [ ] App sticky for Brice + invited users  
- [ ] Clear paid tier or add-on that people *want*  
- [ ] Legal pass (affiliate disclosure, tax, country rules)  
- [ ] Payment rails (Stripe Connect / PayPal / etc. for paying referrers)  
- [ ] Trust: food logs stay private; monetization is separate

## Technical sketch (later)
- `referrer_user_id` on `allowed_users` / signup  
- Stripe customer + subscription webhooks  
- Payout ledger: `referral_earnings`  
- Product catalog + affiliate tags (Amazon, brand programs)  
- Dashboard: “Your invites · earnings · product clicks”  
- Cap depth; fraud checks (self-referral, fake accounts)

## Explicit non-goals for v1–v2 of NutriTable
- Building MLM tree UI now  
- Taking cut of friends’ data  
- Pushing products before the core log is excellent  

## Trigger phrase for future agents
If Brice says “referral money,” “affiliate,” “sign people up and earn,” “MLM but real,” or “help people in other countries earn” — open this file and discuss before implementing.
