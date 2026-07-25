# External clocks

Every dependency with a counterparty outside this company. Reviewed at the start of any week in which a clock is unfiled.
A clock is **running** only when a reference number exists. "Researched," "understood," and "planned" are not running.

Last reviewed: 2026-07-24

---

## C-1 — Business entity registration ⛔ NOT STARTED

**Root of the critical path.** Both C-2 and C-3 require entity documents. Nothing downstream can start until this clears.

Plivo accepts either route:
- **Fast route:** Udyam certificate (MSME) + Business PAN
- **Slow route:** Certificate of Incorporation (MCA) + GST certificate

Udyam is issued by MSME and is explicitly accepted — it does not require incorporating a company. For a solo founder this is likely days rather than weeks, but the proprietorship-vs-Pvt-Ltd choice has tax, liability, and fundraising consequences that are not reversible cheaply. **Confirm the route with a CA before filing.** This is the one decision here worth 48 hours of thought.

**Name discipline — decide once, then never vary:** the legal entity name propagates to Plivo KYC, Meta Business Manager, the website footer, and every address proof. Name mismatch across documents is the single most common rejection cause on the Meta side. Pick the exact string now and use it verbatim everywhere.

- Owner: founder
- Filed: —
- Reference: —
- Expected decision: —
- Blocks: C-2, C-3, G-CLOCK, G-PROOF, launch

## C-2 — Plivo India voice KYC + DID ⛔ NOT STARTED

Blocked on C-1 documents. Faster than previously assumed.

- **Approval time: ~15 minutes to 1 business day** for landline-series numbers. Not weeks.
- Requires an **India data region** Plivo account. This cannot be changed after account creation — a US-region account must be abandoned and recreated. **Check the existing account before filing anything.**
- Two documents, both mandatory: business registration certificate (COI or Udyam) **and** Business PAN or GST certificate. Submitting one is an automatic rejection.
- Business type must be selected correctly on first submission; a wrong selection rejects the application.
- Landline series is the correct number type for inbound clinic reception (non-BFSI, service/transactional).
- **DLT registration is an SMS requirement, not a voice one.** If the product ships voice + WhatsApp only, this clock likely does not exist. Confirm before treating it as work.

- Owner: founder
- Filed: —
- Reference: —
- Expected decision: —
- Blocks: Issues 11–14, first live call, G-PROOF

## C-3 — Meta WhatsApp Business API ⛔ NOT STARTED

Blocked on C-1 documents. Runs in parallel with C-2 once entity docs exist.

- Business verification: typically 2–4 business days with clean, consistent documents. Reported SMB timelines stretch to 2–4 weeks, and the stretch is almost always document mismatch rather than queue time.
- Full path: Business Manager verification → WABA creation → phone number onboarding → display name review → first template approval. Commonly 3–10 business days end to end.
- The registered number must not be active on personal WhatsApp.
- New accounts start at 250 unique conversations per 24 hours. Irrelevant at pilot scale; relevant before clinic #10.

- Owner: founder
- Filed: —
- Reference: —
- Expected decision: —
- Blocks: WhatsApp channel go-live

---

## Honest arithmetic

With clean documents the whole chain is roughly **one to two weeks of mostly waiting**, dominated by C-1 and Meta review — not the multi-week mountain it has been treated as. That makes the delay worse, not better: a two-week task has been deferred for over five weeks and bought nothing. The chain is **serial at C-1** and parallel after it, so every day C-1 is unfiled is a day added to launch with no offsetting work.
