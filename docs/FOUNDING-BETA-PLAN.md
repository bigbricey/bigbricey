# BigBricey founding beta plan

Status: prepared, disabled for public enrollment

The founding beta exists to prove that “talk normally and the bookkeeping happens” is trustworthy for ordinary adults. It is not a growth launch, pricing commitment, or promise of permanent free access.

## Who it is for

- Adults 18+ who want useful nutrition/fitness records but find conventional logging too tedious.
- A mix of younger and older adults, different comfort levels with AI, and a small number of serious fitness users.
- Not children, medical patients recruited through providers, emergency users, or people expecting diagnosis/treatment.

## Controlled waves

### Wave 0 — Brice and trusted adults

Size: Brice plus a few people he knows and can contact directly.

Gate to advance:

- Mandatory regression suite stays green in production.
- No internal tool syntax or false-success reports.
- Every food write is committed exactly once or says plainly that nothing changed.
- Photo/label/barcode stays review-first.
- Health Snapshot accurately separates missing days from zero.
- Cross-account tests and operator access review pass.
- Model cost and latency are visible per active account.

### Wave 1 — approximately 25 Founding Testers

Open only after legal/privacy text, provider review, incident-response plan, monitored contact channel, export workflow, and deletion workflow have an owner.

Operate for at least two normal usage cycles before expanding. Review failures weekly; urgent privacy/security or cross-account issues stop enrollment immediately.

### Wave 2 — approximately 100 testers

Open only when Wave 1 evidence shows:

- High log-completion reliability with a low false-success rate.
- Corrections reduce repeat friction instead of creating silent assumptions.
- Support volume is manageable.
- Day-1 and day-7 return behavior demonstrates usefulness without manipulative reminders.
- Model cost per active user has a safe ceiling and abuse controls work.
- No unresolved high-severity privacy, security, nutrition, or account-isolation issue.

### Wave 3 — larger cohorts

Requires an explicit Brice decision based on measured safety, retention, reliability, cost, support capacity, and legal review. It is not automatic.

## Tester experience

- Invite-only code and verified sign-in.
- Plain-language adult beta notice, Privacy Policy, Terms, and health-data consent.
- Optional nickname/pseudonym; no legal name in the health profile.
- Fast text, voice draft, photo/label/barcode review, and one-step correction.
- “That was wrong” on a specific assistant response.
- Optional idea and trust feedback.
- Explicit checkbox before any feedback is submitted.
- Separate opt-in before conversation context accompanies feedback.
- In-app private Health Snapshot, export request, and deletion request controls.

## Privacy-respecting metrics

Metrics are first-party and content-free:

- Successful log completion: committed food ledger mutation with changed state.
- Clarification frequency: assistant explicitly needs missing information.
- Correction rate: interaction correction/“wrong” feedback divided by completed assistant interactions.
- False-success prevention: server blocks a success-sounding model reply after a failed tool result.
- Response latency: request-to-response milliseconds.
- Model cost per active user: provider-reported cost and token usage joined by random account ID.
- Return behavior: distinct accounts with `app_opened` on day 1, day 7, and day 30 after first use.
- Health Snapshot use: preview and save events.
- Trust: optional one-to-five rating.

Never attach message text, food names, health measurements, login email, or nickname to these metric events.

## Weekly review

Review by random tester ID, never by diary browsing:

1. Reliability failures and exact failed interaction receipts.
2. Corrections and opt-in feedback context.
3. False-success prevention and any leaked internal syntax.
4. Latency/model-cost distribution.
5. Account-isolation, abuse, security, export, and deletion issues.
6. Top recurring friction—not the loudest single feature request.
7. Advance, hold, or reduce the wave.

## Stop conditions

Pause invites and writes if any of these occur:

- Cross-account read or mutation.
- Unrecoverable ledger corruption or destructive overwrite.
- Raw credentials, internal prompt/tool syntax, or private context exposed.
- Repeated false “logged/changed” claims.
- Unexpected provider data use or material privacy-policy mismatch.
- Uncontrolled model spend or abuse.
- Serious medical/emergency behavior outside the product boundary.

## Explicitly deferred decisions

- Pricing, billing provider, free-trial length, and any lifetime offer.
- Public enrollment or public announcement.
- Clinical/provider partnerships.
- Family or child mode.
- Public MCP/OpenAI app access.
- External write access.

Each needs a separate Brice approval and, where applicable, legal/provider review.
