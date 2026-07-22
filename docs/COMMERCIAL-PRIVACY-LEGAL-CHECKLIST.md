# BigBricey commercial privacy and legal launch checklist

Last reviewed: 2026-07-22

This is a product launch checklist, not legal advice and not a claim of compliance. A qualified U.S. privacy/health-technology lawyer must review the actual product, data flows, contracts, policies, and marketing before enrollment expands beyond a small private beta.

## Current product posture

- BigBricey is a direct-to-consumer, invitation-only wellness, nutrition, fitness, and user-controlled health-record beta for adults 18 and older.
- It does not diagnose, treat, prescribe, provide emergency services, or automatically send records to a clinician.
- A legal name is not required in the health profile. Google login identity, random internal account identity, health records, and future billing identity are designed as separate purposes.
- There are no third-party advertising trackers. First-party product events are allowlisted and omit messages, foods, and health values.
- Health Snapshots are private drafts until the user downloads, prints, or shares one.
- Account export and deletion requests can be recorded, but fulfillment remains a controlled operator process. This is readiness—not a completed self-service deletion system.

## What current federal guidance means for this product

### FTC Act and reasonable privacy/security practices

The FTC says its Act applies to most health-app developers, even when HIPAA does not. Product claims and privacy promises must match actual behavior. The launch review must therefore verify every statement on the landing page, onboarding, privacy policy, terms, and You tab against production behavior.

Official sources:

- [FTC Mobile Health App Interactive Tool](https://www.ftc.gov/business-guidance/resources/mobile-health-apps-interactive-tool)
- [FTC Mobile Health App Developers: Best Practices](https://www.ftc.gov/business-guidance/resources/mobile-health-app-developers-ftc-best-practices)
- [FTC Start with Security](https://www.ftc.gov/business-guidance/resources/start-security-guide-business)

### FTC Health Breach Notification Rule

The FTC's July 2024 amendments expressly address most non-HIPAA health apps and treat unauthorized disclosures—not only outside hacking—as potential breaches. BigBricey may fall within the Rule if it is a vendor of personal health records or related entity, including where it has the technical capacity to draw identifiable health information from multiple sources. Counsel must make the scope determination before commercial launch.

Required pre-launch work:

- Write and rehearse an incident-response plan that distinguishes security incidents, unauthorized disclosures, and reportable breaches.
- Name the incident owner, outside counsel/contact path, evidence-preservation steps, and provider escalation contacts.
- Inventory every recipient and subprocesser of identifiable health data.
- Prepare clear notice templates and an internal deadline tracker. Do not wait to invent the process after an incident.
- Confirm the current Rule's timing, recipient, content, and media-notice requirements with counsel at the time of any incident.

Official sources:

- [FTC Health Breach Notification Rule](https://www.ftc.gov/legal-library/browse/rules/health-breach-notification-rule)
- [FTC Health Breach Notification Rule: The Basics for Business](https://www.ftc.gov/business-guidance/resources/health-breach-notification-rule-basics-business)
- [Complying with the FTC Health Breach Notification Rule](https://www.ftc.gov/business-guidance/resources/complying-ftcs-health-breach-notification-rule-0)

### HIPAA is relationship-dependent

HHS explains that a consumer-directed app is generally not subject to HIPAA merely because a consumer enters or imports health information. That can change if BigBricey creates, receives, maintains, or transmits protected health information on behalf of a covered entity or business associate. A future doctor, clinic, employer-plan, or EHR partnership must trigger a new HIPAA/business-associate analysis before any connection is enabled.

Required pre-launch work:

- Document the present direct-to-consumer relationship and prohibited provider workflows.
- Do not advertise BigBricey as “HIPAA compliant.”
- If a covered entity asks BigBricey to operate on its behalf, stop and obtain counsel, a business-associate analysis, suitable contracts, and a provider/security review before accepting data.
- Re-run the HHS/FTC health-app tools whenever integrations or business relationships change.

Official sources:

- [HHS Resources for Mobile Health Apps Developers](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-apps/index.html)
- [HHS: The access right, health apps, and APIs](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/access-right-health-apps-apis/index.html)
- [HHS Health App Use Scenarios and HIPAA](https://www.hhs.gov/sites/default/files/ocr-health-app-developer-scenarios-2-2016.pdf)

## Must-pass launch gates

### Data inventory and minimization

- [ ] Maintain a current diagram of account identity, health ledger, conversations, memories, feedback, product events, snapshots, audit data, and provider transfers.
- [ ] Record why every collected field is needed and remove fields without an active purpose.
- [ ] Verify new sign-ins request only Google `openid email`; no legal name or Google profile photo is needed.
- [ ] Confirm photos are transient analysis inputs and are not stored in the account or ledger.
- [ ] Confirm first-party metrics never include message text, food names, medical values, email, or nickname.
- [ ] Define a written retention schedule for active records, deleted accounts, feedback, audit events, security logs, provider logs, and backups.

### Access and security

- [x] Server-only service credentials; no service-role key in browser assets.
- [x] Random internal account IDs and account-bound new read/write services.
- [x] Browser roles denied access to new privacy tables; row-level security enabled.
- [x] Content-free access/mutation auditing for health and preference mutations.
- [x] Rate limits for new feedback, snapshot, records, data-rights, and metric routes.
- [x] HTTPS-only application transport and restrictive browser security headers.
- [ ] Verify Supabase project SSL/security settings and backup/restore behavior in the live dashboard.
- [ ] Enable and test MFA for every operator/provider account that can access production.
- [ ] Rotate and inventory production secrets; document who can access them.
- [ ] Run dependency, secret, API authorization, cross-account, and web security scans before each beta wave.
- [ ] Test backup restoration and account deletion against backup-retention behavior.
- [ ] Create a monitored security/privacy contact channel.

Provider references used for architecture review:

- [Supabase Security](https://supabase.com/docs/guides/security)
- [Supabase Postgres SSL Enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Vercel Security and Compliance Measures](https://vercel.com/docs/security/compliance)

### Providers and contracts

- [ ] List the exact production providers and model routing: Google, Vercel, Supabase, OpenRouter, selected model provider(s), USDA, and Open Food Facts.
- [ ] Review current privacy terms, retention controls, training/data-use settings, subprocessors, regions, and breach-notice commitments for each provider.
- [ ] Execute suitable data-processing terms where appropriate.
- [ ] Confirm model routing cannot silently send health content to an unreviewed provider.
- [ ] Keep billing identity separate from health records if payments are added later; use a random linkage identifier only.

### User notice, consent, and rights

- [x] Clear adult-only positioning.
- [x] Explicit consent before feedback submission; conversation context is separately optional.
- [x] Health Snapshot preview/edit before local export; no automatic sharing.
- [x] In-app export and deletion request controls with high-friction deletion confirmation.
- [ ] Add a real, monitored privacy contact before inviting outside testers.
- [ ] Have counsel approve Privacy Policy, Terms, consent language, and any founding-tester agreement.
- [ ] Implement and rehearse export identity verification, fulfillment, correction, deletion, cancellation, and appeal/support procedures.
- [ ] Decide and publish realistic fulfillment timeframes only after the operator workflow exists.

### Claims and clinical boundary

- [ ] Review every public claim for evidence and remove diagnosis, treatment, guaranteed accuracy, guaranteed longevity, lifesaving, or outcome promises.
- [ ] Keep “observed,” “recorded,” “estimate,” “missing,” and “unknown” distinct in reports and marketing.
- [ ] Do not market Health Snapshot as a medical record, diagnosis, or substitute for a clinician.
- [ ] Trigger FDA/medical-device counsel review before adding diagnostic or treatment recommendations.
- [ ] Preserve a clear emergency disclaimer and never route emergencies through ordinary AI chat.

### Other jurisdictions and laws

- [ ] Counsel must assess applicable state consumer-health-data, comprehensive privacy, breach-notice, biometric, unfair-practices, and auto-renewal laws before accepting users by state.
- [ ] Do not accept users outside the approved geography until international privacy and transfer requirements are reviewed.
- [ ] Keep the beta 18+; any future family/child mode requires a separate COPPA, parental-consent, safety, and product-design review.

## Go/no-go rule

Do not open a larger commercial beta until the unresolved legal, provider, incident-response, retention, rights-fulfillment, security-account, and public-contact boxes above have named owners and verified evidence. Shipping code alone is not legal clearance.
