# Future read-only AI integration

Status: internal foundation implemented; external access disabled

BigBricey’s database and ledger remain the sole source of truth. A future ChatGPT/OpenAI app or MCP connection should retrieve bounded, account-scoped records from BigBricey; it must not turn an outside model’s conversational memory into the health record.

## Internal read surface

The signed-in application now has an internal GET-only service:

`/api/records?resource=<resource>&period=<10w|6m|1y|all>`

It also accepts a validated `from=YYYY-MM-DD&to=YYYY-MM-DD` range up to 100 years. Large ranges are aggregated in PostgreSQL before they reach the model or browser.

Resources:

| Internal resource | Future read-only tool | Result |
| --- | --- | --- |
| `summary` | `get_health_summary` | Health Snapshot document for a bounded period |
| `nutrition` | `get_nutrition_summary` | Logged-day macro/micronutrient patterns and completeness |
| `food_history` | `get_food_history_summary` | Aggregated food groups, never years of raw meals |
| `workouts` | `get_workout_summary` | Activity sessions, days, and aggregate measures |
| `measurements` | `get_measurement_trends` | Bounded measurement points and observed changes |
| `goals` | `get_current_goals` | Current user-controlled targets and eating style |
| `trends` | `get_health_trends` | Observational changes and statistical outliers |
| `snapshots` | `list_health_snapshots` | Private draft metadata |
| `snapshot` | `get_health_snapshot` | One account-owned saved snapshot |

All calls require the current signed-in BigBricey session, resolve its random account ID on the server, enforce rate limits, and record a content-free access audit. The service accepts no owner/account identifier from the browser and exposes no mutation method.

## Future authorization design

Do not reuse the BigBricey browser cookie for an outside AI product. A future connection needs:

1. BigBricey-hosted OAuth authorization with explicit user consent.
2. Short-lived access tokens and rotating/revocable refresh tokens.
3. Narrow scopes such as `records:summary`, `records:nutrition`, or `snapshots:read`.
4. A consent screen showing the requesting client, exact scopes, and expiration.
5. Per-client and per-account rate limits, access auditing, revocation, and token hashing.
6. Backend aggregation and response-size ceilings.
7. No write scopes in the first external release.
8. Legal/provider/privacy review before any public endpoint or directory listing.

## Privacy rules for an outside model

- Return only the resource and period the user requested.
- Never return login email, billing identity, internal account ID, raw conversation history, or feedback.
- Prefer Health Snapshot or aggregate records over raw rows.
- Distinguish recorded, verified, estimated, missing, and unknown data.
- Never imply the outside AI has remembered data it did not retrieve.
- Do not send a Snapshot anywhere automatically.
- The user must be able to revoke access and see recent access events.

## Deliberately not implemented

- No public MCP server.
- No OpenAI app publication.
- No external OAuth client registration.
- No external writes, logging, deletion, goal changes, or background access.
- No paid connector/provider.

Those remain gated on explicit Brice approval, legal/privacy review, and a separate security test plan.
