# BigBricey AI handoff

Last updated: 2026-07-22
Owner: Brice (`bigbricey`)
Live: https://bigbricey.com
GitHub: https://github.com/bigbricey/bigbricey
Local checkout: `/Users/bigbricey/Projects/nutri-table`
Current application release: `5a088d1`
Current session log: `docs/SESSION-LOG-2026-07-22.md`

Read this file before changing the product. The local folder name is legacy; the product and the only production Vercel project are both **BigBricey**.

## Product promise

BigBricey is a private, adult fitness, nutrition, and long-term health-record companion for people who want useful records without tedious form filling:

> Talk normally. BigBricey handles the bookkeeping, remembers your patterns, and turns years of health data into useful information.

The product is not a general software-building agent, a diagnostic service, or a decorative virtual-world toy. Themes and atmospheric scenes may make the experience feel personal, but food logging, workouts, measurements, trends, corrections, memory, and Health Snapshot are the product.

The founding beta is prepared but not publicly open. Billing, pricing, public enrollment, child/family mode, public MCP access, and external writes remain disabled and require Brice's separate approval.

## Current stack

| Layer | Current implementation |
| --- | --- |
| Frontend | Static `public/*` HTML, JavaScript, and CSS |
| API | Vercel serverless `api/*` |
| Authentication | Google OAuth plus signed private session cookie and invite gate |
| Source of truth | Supabase/PostgreSQL |
| Assistant | OpenRouter with replaceable chat and vision model settings |
| Food data | USDA, Open Food Facts, verified saved foods, and explicit user corrections |
| Hosting | Vercel project `bigbricey` (`prj_M5m6W3qfa0j240nRfX2So51W17vi`) |

Important files:

- `api/chat.js`: authenticated turn orchestration and validated action execution
- `api/_buddy_prompt.js`: short stable identity and behavioral contract
- `api/_buddy_tool_routing.js`: LLM-first turn classification plus narrow post-model reliability guards
- `api/_tool_contracts.js`: closed native tool schemas and confirmation policy
- `api/_native_tool_loop.js`: verified tool-result truth and recovery language
- `api/_chat_wrapper.js`: bounded conversation and ledger context
- `api/_supabase.js`: authoritative data services and atomic writes
- `api/_health_snapshot.js`: snapshot calculation, completeness, provenance, and exports
- `api/_records_endpoint.js`: internal authenticated read-only record service
- `api/_vision.js` and `public/vision.js`: image, label, and barcode review flow
- `public/app.js`: primary signed-in experience
- `public/boxes.js`: real persisted counters and charts
- `public/companion.js`: user-controlled personality and proactive-help settings
- `supabase/migration_013_account_foundation.sql`
- `supabase/migration_014_health_snapshot_metric_semantics.sql`
- `supabase/migration_015_account_deletion_audit.sql`

## Assistant architecture: invariants

1. The LLM receives the user's current message before any deterministic repair or fallback can act.
2. Each turn is classified as ordinary conversation, read-only work, an explicit write, or a genuinely ambiguous possible write.
3. Read-only turns cannot expose mutation tools. Destructive tools require a signed, account-bound confirmation.
4. Native tool calls are validated against closed schemas. Unknown tools, unknown fields, oversized values, and malformed arguments fail closed.
5. The server performs food lookup, unit conversion, calculations, account reads, and mutations. The model never supplies authoritative macros.
6. A success statement can appear only after an authoritative committed receipt. Failed or stale writes say that nothing changed.
7. Provider tool syntax, pseudo-JSON, `<tool_call>` markup, stack traces, and control text are sanitized and never shown as product output.
8. Conversation remains natural. Do not restore pre-LLM menus, canned regex answers, or a JSON-only assistant persona.

Two narrow post-model reliability guards are intentional:

- Explicit chart requests may restore the real `set_tracker` tool when the semantic router misses it.
- Obvious first-person food logs with a real portion, such as “I had one pound of brisket,” may restore one validated `add_food` call if the provider misroutes or malforms it. Questions, hypotheticals, negations, and vague portions do not qualify.

## Food and nutrition behavior

- “I'm having brisket” asks only for the missing quantity.
- “I had one pound of brisket” resolves a defensible verified record, stores the full supported nutrient set, and returns a short receipt.
- Read-only sweet-potato questions stay read-only and prefer the requested whole food over contaminated product matches such as tots.
- Exact barcode and printed Nutrition Facts data are preferred for packaged foods.
- Image analysis identifies foods or copies visible label information; it does not invent nutrient values from pixels.
- Meal photos, labels, and barcodes create editable drafts. The user approves before the ledger changes.
- Unknown nutrients remain unknown. They never silently become zero.
- Confirmed identity, quantity, preparation, nutrient, and usual-portion corrections are account-scoped and bounded.
- Food-day writes are atomic, revision-checked, idempotent, and bound to the initiating account and date.

## Memory and personalization

BigBricey keeps three different kinds of state:

1. Bounded recent conversation plus a compact server-generated summary
2. Durable structured memory, corrections, saved foods, goals, communication preferences, and companion settings
3. The authoritative food, workout, measurement, and health ledger

The You tab exposes every permanent memory and lets the user add, edit, or forget it. A nickname/pseudonym is optional. Personality and answer length may match the user automatically or be selected manually. Proactive help has Quiet, Helpful, and Coach modes, category permissions, and optional quiet hours. Suggestions must be grounded in current account data.

## Health Snapshot

Health Snapshot supports 10 weeks, 6 months, 1 year, or all available history. It produces an editable private preview, a print-friendly report, and structured machine data. It is never sent automatically.

Required semantics:

- Missing calendar days remain missing, not zero.
- Additive measures use daily totals.
- Body-state measures such as weight use the latest active reading on each day.
- Observed changes, coverage, source quality, estimates, outliers, and limits are labeled.
- The report does not diagnose, prescribe, or claim causation.

The live 2026-07-22 verification showed 2 of 70 logged days, 68 missing days, and Weight at 215 lb on one logged day.

## Privacy and account foundation

- New privacy-sensitive services use a random `account_id`; email is retained only where legacy compatibility or login identity still requires it.
- A legal name is not required in the health profile. The current Google login identity still includes the account email, so do not claim anonymous use.
- Browser roles cannot read or execute private service functions; service credentials stay server-side.
- Reads, writes, snapshots, feedback, corrections, product events, exports, and deletion requests are account-scoped and rate-limited.
- First-party metrics are allowlisted and exclude message text, food names, health values, email, and nickname.
- There are no third-party advertising trackers and the product does not sell health data.
- Feedback requires explicit submission consent; including conversation context is a separate opt-in.
- Export and deletion requests exist. Fulfillment is still an operator-controlled process, not automatic self-service deletion.
- Migration 015 permits a reviewed parent-account cascade without an impossible child-audit foreign-key insert; direct child mutations remain audited.

Read `docs/COMMERCIAL-PRIVACY-LEGAL-CHECKLIST.md` before expanding the beta. It is a checklist, not a compliance claim.

## Internal read-only AI foundation

The signed-in app has an account-scoped GET-only service:

`/api/records?resource=<resource>&period=<10w|6m|1y|all>`

Resources include summary, nutrition, food history, workouts, measurements, goals, trends, and snapshots. Large ranges are aggregated by PostgreSQL before reaching a browser or model. See `docs/READ-ONLY-AI-INTEGRATION.md`.

There is no public MCP server, OpenAI app, external OAuth client, or external write scope. A future external connection must use explicit OAuth consent, narrow revocable scopes, short-lived tokens, access auditing, and a read-only first release.

## Production state verified 2026-07-22

- Application commit: `5a088d1`
- Production deployment: `https://bigbricey-fb0ul1e7j-bigbriceys-projects.vercel.app`
- Production alias: `https://bigbricey.com`
- Applied database foundation: migrations 013, 014, and 015
- Preserved real data after synthetic testing: 1 profile, 1 auth identity, 50 events, 416 event measures
- Synthetic release-test account after cleanup: 0 profiles, 0 allowlist rows, 0 events, 0 messages
- Automated suite: 297 passed, 0 failed
- Dependency audit: 0 known vulnerabilities
- Signed-in browser console: 0 warnings or errors

Production tests used a separate temporary member, never Brice's ledger. From a profile-free first-use state:

- “Log four large hard-boiled eggs” committed once on the first message: 200 g, 310 kcal, 25.2 g protein, 21.2 g fat, 2.2 g carbs, 20 supported nutrition fields.
- “I had one pound of brisket” committed once: 453.6 g, 1,320 kcal, 121.6 g protein, 88.5 g fat, 0 g carbs, 20 supported nutrition fields.
- The temporary account and all of its records were deleted afterward.

Signed-in Brice checks confirmed:

- Today remained empty after read-only and synthetic testing.
- The real Magnesium 30-Day chart persisted with 2 points and latest 5 mg.
- Weight 30-Day persisted with 1 point and latest 215 lb.
- Health Snapshot displayed the correct coverage and 215 lb state reading.
- The photo menu clearly separates meal, Nutrition Facts label, and barcode drafts and requires approval.

## Deliberately deferred

- Public enrollment, announcements, billing, pricing, or a lifetime-access promise
- Marketing or onboarding for children
- Diagnostic, treatment, guaranteed-longevity, or lifesaving claims
- Public MCP/OpenAI app access or any external write capability
- Arbitrary user HTML, JavaScript, or unbounded CSS generation
- Fully generated photographic backgrounds or avatar/outfit systems
- Automatic account deletion or automatic Snapshot sharing

## Next pickup checklist

1. Read this handoff, `AGENTS.md`, and `docs/SESSION-LOG-2026-07-22.md`.
2. Inspect `git status`, the latest GitHub commit, the current Vercel production deployment, and the signed-in live behavior before assuming this snapshot is current.
3. Run `npm test` before and after changes.
4. Preserve LLM-first conversation, typed tools, authoritative receipts, account/date binding, and review-first image flows.
5. Deploy only to the existing Vercel project named `bigbricey`.
6. Never test writes in Brice's real ledger.
