# State

The company as of a commit. Amend whenever reality diverges. A stale line here is a defect, not a detail.

Verified-at: 8fc184c91511426630489d0d8acaf02f18728bfd
Verified-on: 2026-08-06
Rule: when Verified-at != HEAD, every line below is unverified. Re-run `npm run os:check`.

⚠️ marks a line this session could **not** evidence from the repository. The reason is
stated inline. Absence of a marker means the line was checked against HEAD, not that it
is self-evident.

**Fully absorbed.** `docs/audit/2026-07-frontend.md` (`90d1da3`) is now reflected here in
full. The D-005 frontend modernisation program is **COMPLETE** — its ledger, including
what shipped, what stays open and why, and what was deliberately not scheduled, is under
*Frontend modernisation program (D-005)* below. Eight of the audit's nine findings closed;
**F-F003 is the only one open**, blocked on external clock C-1. **Issue 34 is now closed**
— F-F001 shipped the owner-facing warning at `6ceb8f0`, and option (a) removed the hazard
at `69ceb7f`. The precedence in `aiService.js` is deliberate and
remains untouched.

---

## Product

- **Prantivo** (formerly Zyon) — vernacular AI receptionist for Indian SMB dental clinics.
- Channels: **voice and WhatsApp**. Languages: Telugu, Hindi, English.
- Wedge: Hyderabad-area dental clinics.
- Product name in every surface and pitch: **AI Receptionist**. Retired framings: "AI Operating System for Businesses", "AI Employees".

Corroborated by `docs/decisions/2026-07-24-product-name-prantivo.md` and the `web/`
repositioning in `c8b1b9e`. Positioning itself is a founder judgement, not a repo fact.

## Customers

- Paying: **0** ⚠️ commercial state, not repo-derivable
- Pilots / live tenants: **0** ⚠️ commercial state, not repo-derivable
- Production deployments: **0** — verified: no prod evidence log exists anywhere in the
  repo; `docs/deploy/` contains only `prod-readiness.md` and `audit/`. First deploy is
  greenfield, DB initialised fresh from `schema.sql`.

## Gate status

| Gate | Status |
|---|---|
| G-CLOCK | ❌ false — no external clock filed (`docs/os/clocks.md`: C-1/C-2/C-3 all `Filed: —`, `Reference: —`) |
| G-PROOF | ❌ false — no production, no live call |
| G-PAY | ❌ false |
| G-TEN | ❌ false |

## Launch gates (from `docs/deploy/audit/2026-07-production-readiness.md` §2)

Verbatim gate text and identifiers from the audit. Two status columns on purpose: the
audit's own verdict, and the verdict at this commit. **The audit says 3/7. At HEAD it is
4/7.** Work ranked against the audit table alone has been ranked one gate out of date.

| # | Gate | Audit (2026-07-16) | **At HEAD** | Evidence for the HEAD verdict |
|---|---|---|---|---|
| 1 | Genesis bootstrap works | PASS | **PASS** | `src/db/migrate.js`; `db:genesis`/`db:migrate`/`db:status` in `package.json`. Unchanged since the audit's live throwaway-DB run. |
| 2 | Live WhatsApp round-trip on prod | PENDING | **PENDING** | No production deploy; no prod evidence log in the repo. Blocked on Issue 20. **Issue 20's scope is incomplete:** as scoped today it deploys the Express app and `public/**` and says nothing about `web/`, leaving the surface a prospect sees *first* un-deployed by any reviewable process. Issue 20 is not closeable until it carries a `web/` deploy line item — see F-F004 and the `web/` bullet under *Stack (frozen)*. |
| 3 | Issue 14 voice gate | PENDING-DID | **PENDING-DID** | Issues 11–13 still absent. External clock C-2 unfiled. |
| 4 | Tenant isolation audit clean | PASS | **PASS** | Unchanged. The two F-016 letter-violations (`appointmentService.js:171`; dead `identityService.getTimeline`) remain open with zero tenant-facing exposure. |
| 5 | Issue 18 closed | PASS | **PASS** | Plus `3584240`, which closed the audit's noted `SESSION_SECRET` → `ADMIN_PASSWORD` fallback residual. |
| 6 | Backups exist with a tested restore | **FAIL** | **PASS** (repo side) | Closed by `e071f69`: `scripts/db/backup.sh`, `scripts/db/restore.sh`, `docs/runbooks/backup-restore.md`, live restore drill. ⚠️ Residue: enabling backups on the *production* provider is unverifiable until Issue 20. |
| 7 | One call traceable end-to-end | PENDING (dev evidence in hand) | **PENDING** | Unchanged; blocked by gates 2–3. |

## Engineering

- Test suite: **960 tests / 158 suites / 0 fail** (`npm test`, raw: `# tests 960 / # pass 960 / # fail 0`)
  Moved by **F1** (+5 tests, +1 suite), **F2** (+4 tests, +1 suite), **F3**
  (+9 tests, +1 suite — `tests/portal/portalWizardExit.unit.test.js`), **B1**
  (+14 tests, +1 suite — `tests/notification/ownerBookingAlert.integration.test.js`,
  plus one test each in `tests/lifecycle/lifecycle.integration.test.js` and
  `tests/prompts/renderer.unit.test.js`), then **B2** (+23 tests, +1 suite —
  `tests/appointment/reschedule.integration.test.js` at 15, plus 6 in
  `ownerBookingAlert.integration.test.js` and 2 in
  `tests/voice/voiceCancellation.integration.test.js`), then **F1-R1** (+4 tests,
  **no new suite** — all four in `tests/portal/portalLifecycle.integration.test.js`,
  beside the two F1 already put there), then **B2-R1** (+32 tests, +2 suites —
  `tests/appointment/cancel.integration.test.js` at 17 and
  `tests/appointment/cancelTool.unit.test.js` at 7, plus 5 in
  `ownerBookingAlert.integration.test.js`, 2 in
  `tests/voice/voiceCancellation.integration.test.js` and 1 in
  `tests/portal/portalTestTurn.integration.test.js`), all below. Every other line
  in this section that quotes 869/151, 874/152, 878/153, 887/154, 901/155,
  924/156 or 928/156 is describing the commit it names and is left as written.
  ⚠️ **B2 added no test to `tests/appointment/slotGrid.unit.test.js` or
  `bookingRules.unit.test.js` and edited neither.** That is the deliberate proof
  that extracting `validateSlot` out of `bookAppointment` was behaviour-preserving:
  had any assertion needed to move, the extraction would have changed behaviour.
  **TEST-FLAKE-03 is CLOSED** (`3765cdb`). It was a calendar-dependent failure in
  `tests/voice/voiceCancellation.integration.test.js:270`, red on every day when today+2
  landed on a Sunday and green the other six: the fixture seeded Dr. Rao for all seven days
  but seeded no `tenant_configs` row, so CLINIC hours — which are what `book_appointment`
  gates on — fell back to `clinicDefaults`, which closes Sunday. The fixture now seeds its
  own seven-day hours. `clinicDefaults` is unchanged; closing Sunday by default is correct
  product behaviour and the test was wrong to depend on it not being. No test was added:
  869/151 is unmoved across D3 and this fix.
  ⚠️ **A NEW intermittent, unexplained, filed not chased:
  `tests/portal/portalLifecycle.integration.test.js:794`** (F1-R1's own test, one
  commit old). 1 red in 2 full runs at a clean tree; 25/25 in isolation; three
  later full runs green. **The obvious hypothesis was measured and REJECTED** —
  millisecond truncation of `NOW()` in node-pg cannot be it: on the local
  Postgres the suite actually uses, `clock_timestamp()` granularity is **1µs**
  (200 000 distinct values from 200 000 calls) and an INSERT→UPDATE pair is never
  closer than **2ms** (0 collisions in 60). Full measurement in
  `docs/audit/2026-08-b2r1-filed.md` so nobody repeats it. Sibling of the
  recorded `tests/traces/traces.integration.test.js:247` intermittent; neither
  has an established frequency.
  ⚠️ **The shared test database was one migration behind for a THIRD time.**
  `saas_crm_test` was missing `026` (`tenant_entities.updated_at` absent,
  `42703`). Nothing failed, because every suite reading that column mints a
  genesis scratch DB — but `025` sprang the same trap at B2 and `026` at F1-R1.
  Cleared before B2-R1's baseline. The durable fix is for the test bootstrap to
  refuse to run when `TEST_DATABASE_URL` has pending migrations; not built.
- **B2-R1 — a patient could book and move, but not cancel. FIXED** (this commit).
  `status = 'cancelled'` had existed since migration `003` and **nothing in the
  system had ever written it** — verified, not assumed: `git grep` over `src/`,
  `tests/`, `scripts/` and `public/` returned ten hits and every one was a CHECK
  declaration, a comment, or the word used about something else. The value was
  dead for five months, so this session defined its semantics rather than
  inheriting them. A patient who could not attend had to ring the clinic — the
  thing this product exists to prevent — or not ring, and the clinic held a slot
  for someone who was not coming.
  **NO MIGRATION. None was needed and none was written.** `'cancelled'` is
  already in `appointments_status_check`, and `uniq_doctor_slot` is partial on
  `status = 'booked'`, so the flip **is** the slot release — the same mechanism
  B2's `'rescheduled'` uses, with no index change.
  ⚠️ **THE GATE, and why it is structural rather than prompt text — this is the
  session's whole substance.** Booking's "confirm first, book second" is really
  an INFORMATION DEPENDENCY WITH A BOUNCE: the model cannot name a slot without
  `check_availability`, and if it invents one `validateSlot` refuses it (off-grid,
  closed day, holiday, past, inside the buffer). **Every one of those walls passes
  a mis-parsed cancel.** The time is real, it is valid *precisely because* it is
  an existing booking, and it is already in the conversation — the patient said
  it, or the model booked it a turn ago. Nothing bounces. Phase 0 inventoried
  what would slow a destructive first-turn call and found the brake is **100%
  prompt-level and every instance names its tool by hand**: the tail's two
  confirm lines (`aiService.js:566-567`) both say `book_appointment`; the rest is
  per-tool declaration text and one renderer line (`clinic.js:313`). So cancel
  would have inherited **no protection at all**. Founder ruling: advisory is
  enough for an action with a wall behind it, not for the only irreversible
  action in the product.
  So `cancel_appointment` takes a **REQUIRED `confirmed` boolean**, compared
  **strictly `=== true`**. `confirmed` false/absent ⇒ **no write**, and a
  confirmation payload (doctor, date, time, patient name) for the model to read
  back. `confirmed === true` ⇒ the cancel. **The first call cannot write, whatever
  the model intends**, so a turn happens in between in which the patient either
  says yes or does not — the availability step booking gets for free, made
  explicit because cancel cannot earn it.
  ⚠️ **ONE TOOL NAME, TWO PHASES, and that is what makes it a gate.** A read-only
  lookup tool plus a destructive tool would let the model call the destructive one
  directly, which is advisory again. One door, whose first turn cannot write.
  ⚠️ **THE COST OF THAT, PAID KNOWINGLY: `mutating: true` covers both phases.**
  `TOOL_META` is keyed by declaration name, so one flag serves both. On the
  read-only phase `committed` therefore flips after a call that wrote nothing,
  disabling Issue 29's abort checks for the rest of the turn. **Accepted, on the
  asymmetry:** `mutating: false` would leave `committed` unset on a call that
  really did destroy a booking, so an abort between the cancel committing and the
  reply being spoken would tear exactly the write Issue 29 exists to prevent — the
  appointment gone, the patient never told. Over-declaring costs an abort
  opportunity on a turn with nothing to lose; under-declaring costs a real
  appointment. Both halves are asserted live in
  `voiceCancellation.integration.test.js` (8) and (9) — (9) exists specifically to
  pin the cost rather than let it be discovered later as a surprise.
  **NO TRANSACTION, deliberately.** B2 bought one because a move is two writes
  that must both land or neither. A cancel is a **single guarded UPDATE** —
  `WHERE id AND tenant_id AND customer_id AND status = 'booked'` — atomic on its
  own, with `rowCount` reporting the outcome, so "threw means committed nothing"
  holds trivially. That `status = 'booked'` predicate is also the analogue of B2's
  `same_slot` refusal (a cancel has no destination, so there is nothing to be
  *same* as): it makes a double-cancel and a cancel of an already-moved row fail
  cleanly, and it **transitions a row, never drops one**.
  **ONE resolution path, shared by BOTH phases and by the move.** `resolveOwn
  Appointment` — the `(tenant_id, customer_id, appointment_time)` lookup lifted
  verbatim out of `rescheduleAppointment` — is what the dry run and the write both
  call. **A confirmation that resolved differently from the write it authorises
  would be worse than no confirmation**, and that is asserted directly. No
  appointment UUID crosses in either direction on either phase, and the patient's
  **phone** is absent from both (the name is not: it is already in the prompt and
  on `bookAppointment`'s return).
  **`appointmentNotFound` took a verb PARAMETER, not a sibling function** — it was
  the one piece of B2 not reusable verbatim, since its text said "to move" and
  "before moving anything". Defaulting to `'move'` keeps the reschedule wording
  **byte-identical**, asserted.
  **Owner alert: a THIRD shape in the same function**, dispatched on a **declared**
  `cancelled` flag (B2's rule — never inferred; a mutation that infers it from
  `status` instead is proven to go red). `Appointment cancelled — {doctor}` with a
  single **`Freed:`** line, because the receptionist's actionable fact is *which
  slot just opened*, not that a cancellation occurred. `type` stays
  `'appointment_booked'` — load-bearing, since `scriptedTurnCheck` finds and
  cleans its own rows by an id diff scoped to exactly that literal. `Status:`
  reads the COLUMN and renders `cancelled` with no new code.
  **`reminder_status` is untouched, on purpose.** `reminderCron`'s claim query
  already filters `a.status = 'booked'`, so a cancelled row can never be claimed
  (asserted, and asserted **non-vacuously** — both rows are proven identical on
  every other dimension the claim query filters on). The column's CHECK carries no
  cancelled value, so the only reachable writes would be `'sent'` or `'failed'`,
  and both are lies.
  ⚠️ **FILED, NOT FIXED — the claimed-and-cancelled race.** A row already flipped
  to `'sending'` is still reminded: `processReminder` works from the row already
  fetched into `due` and never re-reads `status`, so the patient gets a reminder
  for an appointment they cancelled seconds earlier. Unfixable from the cancel
  side — it needs the send path to re-check status under the row lock. It **cannot
  repeat**, because `reapStuck`'s re-claim filters `status = 'booked'` again. The
  test records the real behaviour rather than pretending otherwise. Full analysis:
  `docs/audit/2026-08-b2r1-filed.md`.
  ⚠️ **Owner-initiated cancellation is still absent** (portal/admin — different
  actor, different auth), as is any re-fill or waitlist behaviour. **There is no
  undo, by design**: the slot is gone the moment it commits and another patient
  can take it, so an undo would be a promise the index cannot keep.
  ⚠️ **No owner-facing surface lists cancellations.** `adminRoutes.js:288` passes
  `a.status` through and `public/admin/appointments.html:104` renders only
  `reminder_status`, so a cancelled row looks identical to a booked one there —
  exactly as a `'rescheduled'` row already has since B2. Pre-existing, unchanged.
  ⚠️ **`clinic.js:312` — the VOICE variant of the booking-tools line drops the
  confirm-first clause its WhatsApp twin at `:313` carries.** Found here,
  pre-existing, left alone on instruction. Bounded: the prompt tail carries the
  per-tool confirm lines on every channel. Filed.
- **F1-R1 — F1's staleness fix only half worked. FIXED** (`f7e8a97`). F1 made
  the readiness formula read every storage home a persisted check measures. Two
  of that union's three legs read `max(created_at)` on tables that carry no
  `updated_at` and no trigger, so **a timestamp that can only be set at INSERT
  can only rise at INSERT.**
  **Three real writes were invisible, and all three are in-place UPDATEs.**
  Editing a FAQ (`knowledgeService.updateChunk` — 0.7 checked this specifically,
  it is an `UPDATE`, **not** delete-and-reinsert, so `created_at` genuinely could
  not move), editing a doctor's schedule (`doctorService.updateDoctor`), and
  **ARCHIVING a doctor** (`doctorService.setArchived` flips `type` with an
  UPDATE; reached from the portal's `DELETE /api/doctors/:id` on the
  has-appointments branch).
  ⚠️ **The archive is the sharp one and it was found in Phase 0, not planned.**
  It is how an owner takes a doctor OUT of booking: the register shrank while
  `doctor.schedule` kept reporting the verdict it reached when that doctor was
  still bookable — the ring reading one check **higher** than the truth. This is
  F1 inverted. F1 was "you did the work and the portal says you didn't"; this is
  "you undid the work and the portal says you're fine", on the surface that
  decides go-live.
  **Migration `026_knowledge_entity_updated_at.sql`** adds `updated_at
  TIMESTAMPTZ NOT NULL DEFAULT NOW()` to `knowledge_chunks` and
  `tenant_entities` and attaches the **EXISTING** `set_updated_at` — no new
  function; that one is defined once in `schema.sql`'s SETUP block and seven
  tables already use it. Guarded `DO $$ … IF NOT EXISTS (SELECT 1 FROM
  pg_trigger …)` form and `trg_<table>_updated` naming both follow `012`/`013`,
  the two migrations that attach this same function. `schema.sql` in lockstep,
  inline. `validationInputsChangedAt` reads `max(updated_at)` on both.
  ⚠️ **THE BACKFILL EXPIRES EVERY OUTSTANDING RUN, ONCE, AND THAT IS CORRECT.**
  `NOT NULL DEFAULT NOW()` stamps every pre-existing row with the migration
  instant, so any tenant holding a FAQ or a doctor row has its latest validation
  run go stale on the deploy. After the migration `max(updated_at)` is the honest
  answer to "when did this input last move", and for rows written before the
  column existed that answer is genuinely unknowable. A stale run costs a
  re-check, never a wrong verdict. Zero production tenants at this commit, so the
  real blast radius is the shared dev database.
  ⚠️ **STILL OPEN — the DELETE half, filed and deliberately not built.** Removing
  a FAQ **lowers** `max(updated_at)`, so deleting the 5th FAQ takes a clinic below
  `kbMin` while the run still reads fresh and the ring still reports the old,
  higher verdict. **No timestamp column fixes a max() that falls.** Two candidate
  signals for whoever picks it up: a tenant-level touch on delete, or a row count
  carried in the union beside the timestamp. Bounded meanwhile — `runGoLiveChain`
  re-validates at the press, so a clinic that has actually fallen below the
  minimum is still refused; what is exposed is the ring and the admin panel's
  separate activate path. Documented at the fix site, not only here.
  ⚠️ **The union's three legs are maintained by TWO mechanisms and the query does
  not show which is which** — `tenant_configs.updated_at` has no trigger,
  `configService` writes it explicitly; the two new columns are trigger-
  maintained. Recorded in both the migration and the helper, because the next
  reader will assume all three work the same way.
  **Four `created_at` readers were found and deliberately LEFT ALONE**:
  `knowledgeService.listChunks` (`ORDER BY created_at` — the FAQ list order),
  `doctorService.listDoctors` (`created_at` as the third-level tiebreaker under a
  name sort), and `created_at` on the FAQ API payload. Moving any of them to
  `updated_at` would reshuffle a register every time a row was edited.
  **Lockstep proven by construction, not by reading**: a genesis DB (new
  `schema.sql`) and a migrated DB (HEAD's `schema.sql` + the real `026` executed
  by the runner, every other file stamped) agree byte-for-byte on the columns,
  triggers and indexes of both tables, and both triggers resolve to
  `set_updated_at()`. Genesis records `026` as **stamped**; the migrate path
  records it as **run**. Re-applying `026` to a database that already has the
  column and both triggers is a clean no-op, so the file is re-runnable.
  ⚠️ Editing this migration's comment **after** applying it tripped `db:status`'s
  checksum-mismatch warning, exactly as designed. Cleared by unrecording the row
  and re-running, which is also where the idempotency above was proved.
- **B2 — a patient could book but not move. FIXED** (`c1e671f`). The portal has
  recited a reschedule policy since `PORTAL-P3-S9` that the receptionist could not
  act on — a settings page describing behaviour that did not exist, which is the
  F-006 class.
  **THE UNIQUENESS DECISION (option C, founder-ruled).** `uniq_doctor_slot` is a
  partial unique index `ON appointments(tenant_id, doctor_name, appointment_time)
  WHERE status = 'booked'`, so the old row's post-move status is what decides
  whether its slot frees. A move now writes a **NEW row with `status = 'booked'`**
  and flips the **OLD row to `'rescheduled'`**. The old row leaves the index the
  moment it flips; the slot is bookable again with **no index change at all**.
  ⚠️ **Every existing reader of this column filters POSITIVELY on `= 'booked'`**
  — `checkAvailability` (`appointmentService.js:237`), `reminderCron`'s claim
  query (`:98`), `scriptedTurnCheck.bookedAppointment` (`:159`) — so a superseded
  row is correctly excluded from all three with **zero changes to any of them**.
  `adminRoutes.js:288` selects `a.status` unfiltered and `public/admin/
  appointments.html` never renders it (its badge map is `reminder_status`), so no
  UI shows an unmapped value. `doctorService.hasAppointments` was already
  status-agnostic.
  ⚠️ **`reminderCron.js:98` was the one query that would have misbehaved
  SILENTLY** — had the row the patient actually holds carried anything other
  than `'booked'`, they would never be reminded, with no error, no log line and
  no failed status. It agrees with the index rather than fighting it, and it is
  why the NEW row is the `'booked'` one. The rejected alternative (UPDATE in
  place) was rejected on this axis: it needs **all five** reminder columns reset
  by hand and **four of the five fail silently if forgotten**, whereas a new row
  takes the column DEFAULTS, which *are* the correct reset. Correctness that
  cannot be bought back outranks atomicity that can.
  **Schema: one CHECK widening** (`025_appointment_rescheduled_status.sql`),
  `007`'s DROP/ADD pattern, plus `schema.sql` in lockstep. No column added, no
  index touched. The constraint is declared inline and unnamed in `003` and in
  `schema.sql`, so both the migrate path and a fresh genesis converge on
  `appointments_status_check`.
  **THE PRICE, paid: one explicit transaction.** `db.getClient()` +
  `BEGIN`/`COMMIT`/`ROLLBACK` on ONE connection, **INSERT the new row FIRST**.
  Two pooled `db.query` calls would be two independent transactions on two
  connections, and the failure mode is not theoretical: release the old slot,
  lose the race on the new one, and the patient holds **no appointment at all**.
  Inserting first means a 23505 rolls back with the original intact. This is
  load-bearing for Issue 29: `aiService.js:240-243` flips the point of no return
  only **after `executeTool` returns**, so "threw" must mean "committed nothing"
  — a guarantee that held until now only because booking was a single INSERT.
  Asserted with a **forced interleaving**, not a sleep: a rival booking is
  INSERTed uncommitted, the move blocks on the index, then the rival commits.
  **ONE validation path, and this was the session's most important structural
  change.** Gates 1–10 of `bookAppointment` — parse, past, `resolveBookingRules`,
  `evaluateDay` (past date / same-day / advance window / holiday / closed day),
  clinic hours, `buffer_minutes`, doctor match, doctor day off, doctor hours,
  **slot grid** — are extracted into `validateSlot`, which both write entry
  points call. `bookAppointment` = validate + INSERT; `rescheduleAppointment` =
  validate + (INSERT new, supersede old) in the transaction. Gate 11's
  patient-name backfill stays booking-only (it is not a validation); gate 12's
  23505 recovery is preserved **verbatim on both paths** — it is the only thing
  between two concurrent writers and a double-book. The extraction is
  **behaviour-preserving and the proof is that every pre-existing booking test
  passes untouched**: `slotGrid.unit.test.js` and `bookingRules.unit.test.js`
  were not edited, and no assertion moved.
  **The lookup is the ERROR, by design.** `reschedule_appointment(current_time,
  new_time, doctor_name?)` resolves the appointment server-side from
  `(tenant_id, customer_id, appointment_time)`. There is **no second tool and no
  appointment UUID in Gemini's context** — same discipline that kept the
  patient's phone out of B1's tool response: an identifier the model can read
  back to a caller eventually will be. `appointment_id` is deliberately **absent
  from the reschedule return** (asserted), while `bookAppointment`'s pre-existing
  one is untouched. An ambiguous reference returns `appointment_not_found`
  carrying the caller's **real upcoming appointments**, soonest first, so the
  refusal performs the lookup. **No fallback guesses the nearest appointment** —
  never invent a slot, same discipline as never inventing a price. A
  `same_slot` refusal catches "move it to the time it already has", which
  `uniq_doctor_slot` would otherwise report as `slot_taken` — true, and actively
  misleading, since the someone-else who took it is them.
  ⚠️ **THE OWNER ALERT — B1's recorded expectation was WRONG and is corrected
  below.** Under option C, `'rescheduled'` lands on the **superseded** row, which
  nobody is alerted about; the alert describes the **new** row, whose status is
  `'booked'`. So a move would have rendered **identically to a fresh booking**.
  That is worse than cosmetic: the receptionist would not know a slot had just
  freed, and could reasonably conclude the patient had booked twice.
  `formatOwnerBookingAlert` now carries **two shapes in one function** —
  `Appointment moved — {doctor}` with `Was:`/`Now:` replacing `Date:`/`Time:`.
  `Was:` leads because the freed slot is the actionable fact. Both instants use
  the same IST convention **recombined into one call** (`reminderCron.js:147`'s
  exact string) rather than split, because a move is read by comparing two
  instants and two four-line blocks would mean diffing eight fields. `Status:`
  still reads the COLUMN on both shapes. The move is **DECLARED** by a
  `rescheduled` flag, never inferred from the presence of a previous timestamp —
  a malformed field must not silently downgrade a move back into the shape this
  branch exists to prevent (asserted).
  ⚠️ **`type` stays `'appointment_booked'` on a move, and this is load-bearing,
  not laziness.** `scriptedTurnCheck` identifies the probe's own notifications by
  an **id diff scoped to exactly that type** (`:174-181`) and re-counts residue
  with the same predicate (`:227`). A second type would be invisible to both, so
  the probe would leave a row behind **and report a clean zero** — a leak its own
  leak-detector could not see. One function, one type; `turn.scripted`'s contract
  and cleanup topology are otherwise unchanged (a new tool declaration is not a
  new check, and `RESIDUE_TABLES` counts appointments with no status filter, so a
  superseded row would be caught if it ever leaked).
  ⚠️ **Two PRE-EXISTING voice-path exposures, filed not fixed — they are not
  this session's.** (a) `generateReplyStream` (`aiService.js:363-384`) has **no
  point of no return at all**: abort is checked before every tool
  unconditionally, by explicit decision ("unify when SSE goes live"). It is dark
  (`VOICE_STREAM_TURNS=false`). (b) `aiService.js:376` calls `executeTool` with
  **four arguments**, so `channel` defaults to `'whatsapp'` and the
  `channel === 'test'` gate does not apply on that path. Both have applied to
  `book_appointment` since PR9C; `reschedule_appointment` inherits exactly the
  same shape and adds no new exposure class. It carries the same `test` gate on
  the JSON path.
  **Cancellation as a patient-facing tool is still absent and is filed, not
  built.** `status = 'cancelled'` has existed since `003` and no tool, route or
  portal control writes it. Separate issue.
  ⚠️ **An existing dev or test database needs `npm run db:migrate`.** The shared
  test database was one migration behind and failed with
  `appointments_status_check` until it was applied; scratch-DB suites were green
  throughout because genesis reads the updated `schema.sql`. Normal migration
  contract, recorded because it is the first schema change in some weeks.
- **B1 — the owner booking alert was half a message sent to nobody. FIXED**
  (`29f95d6`). Two defects in one path, and the second one meant the first was
  academic.
  **A — the payload.** `New appointment: {name} with {doctor} at {time}` carried
  three fields. It now carries five, labelled, one per line, with the doctor on
  the title row: patient name, patient **phone**, appointment **date**,
  appointment **time** (IST), booking **status**. The IST rendering is
  `reminderCron.js:147`'s convention split in two (`'en-IN'` + `Asia/Kolkata`,
  `dateStyle:'full'` / `timeStyle:'short'`) — recombining the two fields yields
  that file's exact string, asserted, so there is one convention and not two.
  `status` reads the `appointments.status` COLUMN, never a literal: today it is
  only ever `'booked'`, and B2 adds `'rescheduled'` to the same column.
  ⚠️ **CORRECTED at B2 — the second half of that sentence was wrong in a way that
  mattered.** B2 does add `'rescheduled'` to the column, but it lands on the
  **superseded** row, and no alert is ever sent about that row. Reading the
  column on a move therefore yields `'booked'`, so a move would have rendered
  byte-identically to a fresh booking — leaving the receptionist unaware a slot
  had freed and free to conclude the patient had booked twice. The pass-through
  property this line records is real and still holds; what was wrong was the
  implication that a move would read differently **because of it**. It reads
  differently because B2 gave the function a second shape. See the B2 entry.
  ⚠️ **`bookAppointment` was already fetching what was missing and dropping it.**
  `RETURNING id, doctor_name, appointment_time, status` (`appointmentService.js:335`)
  then returned neither `appointment_time` nor `status` — so date/time splitting
  and the real status cost **zero extra reads**. The patient's phone did need
  threading: it is on the hydrated `customers` row the turn already holds, so
  `executeTool` now takes `customer` rather than `customer.id`.
  ⚠️ **The phone was deliberately NOT added to `bookAppointment`'s return.** That
  object is serialised into the model's tool-response, so a phone there enters
  Gemini's context and can be read back to the caller — a data-exposure change
  wearing a formatting change's clothes. Proven at runtime: across a real booking
  the model received 3 payloads, none containing the number, and the `turn_traces`
  row does not contain it either.
  **B — the recipient, and why nobody was ever alerted.** The send read
  `tenants.owner_notify_phone`, a column **no production path has ever written**:
  the only writers in the repo are `scripts/seed-schedules.js` (dev, and it writes
  a `phone_number_id`, which is not a phone) and a workflow test fixture. Both
  real create paths — the Issue 15 provisioning CLI and the portal's Safety &
  handoff page (`portal/routes.js:1395`) — write `config.notifications.owner_numbers`.
  **So on the first real tenant every booking alert would have taken the
  `no_phone` branch and no owner would ever have been notified.**
  `notifications.owner_numbers[0]` is now the single source of truth. The column
  is a **deprecated fallback**, read only when the array is empty and logged as
  such when it fires — kept because a dev or legacy tenant carrying only the
  column would otherwise go silent on the switch. It is **untouched elsewhere** and
  stays live for owner-command *authentication* (`whatsapp/routes.js:97`), the
  human-handoff forward (`:163,168`) and the `notify_owner` workflow action
  (`core/coreActions.js`) — none of them notification recipients. Retiring it
  entirely means moving an auth predicate, which is its own issue.
  **`notifications.on_booking` is honoured.** Declared since Issue 8, defaulted
  true, and read by nothing anywhere until now. `false` ⇒ no send and a
  `sent_status` of `skipped_disabled`, so the skip is visible in data on the
  `no_phone` pattern. No migration: `notifications.sent_status` is free `TEXT`
  with no CHECK (`schema.sql:349`).
  ⚠️ **THE PROBE GUARD — the load-bearing part of this session.**
  `scriptedTurnCheck` stopped a synthetic booking paging a real owner by nulling
  `owner_notify_phone` on the tenant copy handed to the brain. Moving the
  recipient into the config document **defeats that**: the config is read from the
  database by tenant id and a tenant copy cannot blank it. Since every clinic runs
  validation immediately before go-live, the un-guarded switch would have
  WhatsApp'd real owners an appointment for "Zyon Validation Probe" at the worst
  possible moment. The guard moved with the recipient:
  `notificationService.SUPPRESS_OWNER_ALERTS`, imported by the probe rather than
  spelled out there so a rename cannot silently unhook it, and checked **before
  the config is even read** so no recipient is ever resolved. `testTurnService`
  carries it too (its booking path was already hard-gated; this keeps the mirror
  true). The row is still INSERTed, with `sent_status = 'suppressed'`, so the
  probe's id-diff cleanup is unchanged.
  ⚠️ The validation probe's cleanup was **never** at risk from the content
  change: it matches by **id diff**, not by `content` text, and says so at
  `scriptedTurnCheck.js:160-166`.
  ⚠️ **The `Customer phone:` line in `aiService.buildSystemPrompt` (`:516`) is
  pre-existing and unchanged** — GUARD-01's identity guardrail is written against
  it. B1 adds the patient's phone to no NEW surface; the renderer's own guarantee
  (config in, no phone out) is now pinned by a test that also fails if anyone
  widens `renderSystemPrompt` to take a customer.
  **FILED, NOT BUILT:** `owner_numbers` is an array and only `[0]` is notified.
  Fan-out when a clinic asks for it. Two docs now describe the old behaviour and
  were left as written, being historical records:
  `docs/per-tenant-read-inventory.md:36` (Issue 9) and
  `docs/deploy/audit/2026-07-production-readiness.md:262-265`, which lists
  `notifications.on_booking` under *Inert config knobs*.
- **F3 — the onboarding wizard had no way out, and the login page's reset
  promise named no channel. BOTH FIXED** (`3b4cab8`). Two small issues from
  the portal-v1 §11 acceptance run, which otherwise **PASSED**: under 45 minutes
  on a phone, unaided, faster than pre-redesign.
  **A — "Save and finish later" (spec §3.8).** Progress was ALREADY persisted
  and always had been: `persistStep` writes `meta.onboarding_step` from `goTo`
  on every transition, and `main()` resumes from it on boot. Close the tab at
  step 5, sign back in, land on step 5. What was missing was only the control,
  so this is a button rather than a mechanism. It sits on the step-label row —
  the wizard's own top right, above the card, in the first viewport at 380px
  (measured: bottom at 269px of an 820px viewport, 165×44) — and NOT in the
  `.top` bar, which at 380px already carries burger + lifecycle + avatar and
  hides `.kbd` for want of room. Three cases: not-a-form or clean card leaves
  with no request at all; a dirty card saves through the step's OWN
  `form.requestSubmit()`, the same call Continue makes; a rejected save keeps
  the owner on the step with the page's inline field errors and everything
  typed intact. Dirty is read from `save-note--dirty`, the class the embedded
  page already writes and `shell.js`'s sticky save bar already observes — no new
  contract, and `wizard.js` still calls exactly two routes.
  ⚠️ **A pre-existing defect in `watchIframeSave` had to be fixed for any of
  this to work, and it was shared with Continue.** The watcher polled
  `saveBtn.disabled` every 120ms; a validation 400 is refused before the query
  runs and opens and closes that window in single-digit milliseconds, so
  `sawBusy` stayed false, the watcher sat out its full 20-second timeout and
  reported a REJECTED save as a HUNG one — a "taking a while" toast instead of
  the field error, twenty seconds late. Nondeterministic by construction: the
  same rejection on the same page reported correctly or not depending on where
  the sampling grid fell, and both outcomes were observed in consecutive runs.
  **Present since S16.** Proven not to be this session's by driving Continue
  through the identical rejection (`scripts/portal/f3.js` keeps that control
  run). Now a `MutationObserver`, which cannot miss a transition — a finer poll
  would have narrowed the window and kept the bug. `sawBusy` seeds from live
  state because `requestSubmit()` dispatches synchronously, so the busy flag is
  already set by the time the observer attaches.
  **B — login copy, one line.** `public/portal/login.html` read *"Forgot your
  password? Message Prantivo on WhatsApp to reset it."* — accurate and a dead
  end, naming a channel with no way to reach it. It now carries a `wa.me` link
  with a prefilled message, on the founder's number (`918309177158`, the same
  one `web/lib/siteConfig.ts:72` publishes for every marketing CTA; inlined
  because login.html is served statically and cannot read an env var). The
  surrounding block also moved off `--faint`, whose own token comment says
  "non-text only (2.8:1)" — a reset line an owner cannot read is not a channel.
  ⚠️ **No self-serve reset was built and none should be**: 0.3 confirmed zero
  email transport anywhere in the repo (no `nodemailer`/`sendgrid`/`smtp`/`ses`
  in `src/`, `scripts/` or the nine runtime dependencies), so a token flow would
  mean a transport, issue-and-expiry and a reset route — several sessions,
  before a single paying customer.
  ⚠️ **F3-R1 filed (open): the copy promises a reset no operator surface can
  perform.** `POST /admin/api/tenants/:id/owner` (`adminRoutes.js:791`) CREATES
  an owner account and **rejects with 409 when one already exists** (`:813-815`,
  with the `23505` backstop at `:829`). There is no `UPDATE users SET
  password_hash` anywhere, no delete/deactivate-user route, and no
  password-change route on either surface — the only other writes to `users` are
  `last_login_at` and the session lookup. The route's own header says it: *"a
  reset today is a deliberate operator action against a removed account, not
  this route"*, and removing the account means hand-editing in `psql`. Not fixed
  here (out of scope); the cheapest honest fix is an operator "reset password"
  action reusing `generateTempPassword` + `hashPassword` on the existing row.
  Evidence: `scripts/portal/f3.js` (scratch DB → genesis → real routers → CDP at
  380×820; the walk to step 5 and every exit are real clicks) and
  `scripts/portal/shots/f3-{wizard-step5-mobile,wizard-invalid-exit-mobile,wizard-invalid-exit-field,login-mobile}.png`.
- **F2 — the Test page's composer locked after one message. FIXED** (`9f17517`).
  Reported from the same acceptance attempt as F1: the first test message sends
  and replies, the counter reads 19 left, and the composer and Send are dead
  from then on. It blocked step (f) of portal-v1 §11, which needs a second
  message to confirm an edited price is quoted.
  **The cause was one line, and it was never the quota.** `sendQuestion`
  disables the composer on entry as the page's only double-submit guard
  (`test.js:130`); its `finally` then re-enabled only `if (!input.disabled)` —
  false on every path, because that same function had just set the flag true.
  One flag was carrying two meanings, "busy" and "out of messages", and the
  release point asked it the wrong question. It now clears against `exhausted`,
  set only where the cap is actually detected (`updateRemaining`'s `n <= 0`
  branch). Display and disable were always reading the same field; there was no
  off-by-one.
  ⚠️ **Present since the page's first commit** (`8b7c093`, 2026-07-21) — a
  behavioural bisect at `bde2aee~1` reproduces it identically, so D5a did not
  cause it despite touching this file. **The Test page has never sent a second
  message.** `git log -L` confirms neither block was edited after birth.
  ⚠️ **Why six weeks of harnesses missed it.** `sending` *does* clear in that
  same `finally`, so any driver calling `form.requestSubmit()` submits straight
  through the disabled controls and reports a working page. The bug is only
  visible to a probe that respects `disabled` the way a person does. The repro
  driver was wrong in exactly this way on its first run and reported a pass.
  Verified against a real portal and a real brain over CDP: 20 consecutive sends
  with the composer usable after each; the cap guard still firing at 0 with its
  reason visible and refusing sends 21–22 client-side; a rapid double-click
  issuing one request, not two; a forced 400 leaving the composer usable.
  ⚠️ **`Portal.setBusy` is NOT involved** — Test hand-rolls its busy state and
  uses only `Portal.toast` and `Portal.me`, so the seven pages that do use
  `setBusy` are unaffected and were not touched. The starter buttons are also
  disabled without a re-enable, and that stays: they live inside `#chatEmpty`,
  which is hidden from the first message onward, so they are unreachable rather
  than dead. Adding a second release path would have masked this bug rather than
  fixed it; a test now asserts there is exactly one.
  ⚠️ Tests are **source-shape** assertions, not DOM behaviour: `test.js` is a
  browser IIFE with no exports and the repo has no DOM library in its dependency
  tree. The behavioural proof is the CDP run, which lives in the session record
  and not in the suite. `tests/portal/portalTestComposer.unit.test.js`, 4 tests
  / 1 suite; two of the four fail against the pre-fix file (checked by stashing
  it), the other two are the constraint guards.
- **F1 — readiness did not reflect the FAQ count. FIXED** (`007f697`). Reported
  from the portal-v1 §11 acceptance attempt: six FAQs on file, Home reporting
  9/10 and *"Add at least 5 FAQs or upload one document"*, and **no Go-live
  control rendered at all** — so the acceptance run could not complete.
  **It was never a counting bug.** `checkKbPopulated`
  (`validationService.js:210-216`) counted correctly at every point and its
  boundary is exact (4 fails, 5 passes, re-proved this session). The run simply
  **predated the FAQ writes** — 906 ms, in the reproduction — and the portal
  reported that expired run as CURRENT, because staleness was computed from
  `tenant_configs.updated_at` alone while FAQs live in `knowledge_chunks`. A FAQ
  write moved the thing `kb.populated` counts without moving the measurement.
  With `run.passed` false and `run.stale` false, `deriveGoLive` (`shell.js:304`)
  returns ineligible and `renderLifecycle` emits a status object rather than a
  button: **go-live was unreachable and nothing on screen said why.**
  ⚠️ **The formula was WRONG IN TWO PLACES, not one.** `lifecycleService`'s
  `STALE_VALIDATION` activation guard carried its own copy of it, while
  `routes.js` claimed in terms that the two "can never disagree". Both now read
  one exported helper, `lifecycleService.validationInputsChangedAt`, whose union
  covers every storage home a persisted check measures:
  `tenant_configs.updated_at`, `max(knowledge_chunks.created_at)` (kb.populated /
  kb.retrieval), `max(tenant_entities.created_at)` (doctor.schedule /
  turn.scripted). One query, three tenant-scoped lookups, replacing the single
  query it grew out of — the readiness read is still three queries.
  ⚠️ **SUPERSEDED at F1-R1: the last two legs now read `max(updated_at)`, not
  `max(created_at)`.** The union's *shape* — three lookups, one query — is
  unchanged and the two column names above describe the commit this entry names.
  Neither table had an `updated_at` when F1 shipped, which is why it read
  `created_at`; that was the half of F1 that did not work. See the F1-R1 entry.
  ⚠️ **`tenants.updated_at` is deliberately EXCLUDED** even though
  `whatsapp.config`/`live` and `tenant.legacy_prompt` read that row: `writeStatus`
  UPDATEs `tenants` and the table has a `BEFORE UPDATE` trigger, so including it
  would bump the timestamp past the very run that just succeeded and mark every
  validated tenant permanently stale. Those columns are operator-written anyway.
  New **`POST /portal/api/readiness/check`** — the validate half of the go-live
  chain, on the owner's surface. It calls `validationService.validateTenant`
  directly rather than `transition(id, 'validate')`, because `doValidate` writes
  `status='validated'` on a pass; `validateTenant` persists the run and touches
  nothing else, so this route **cannot move a receptionist between states**
  (asserted). Session-scoped (INV-1), no options argument at all (INV-3), its own
  10/hour budget so re-checking cannot exhaust the go-live budget.
  **`run.stale` had been in the payload since S18 and NOTHING rendered it.** Home
  now states the condition and offers *Check again*; the header control becomes
  *Setup changed* + *Check & go live* rather than a bare *Go live* identical to a
  passing run. No auto-refresh on load, deliberately — it would hide the
  mechanism and spend a Meta ping plus a model turn on every visit to Home.
  **Decision recorded: validation is NOT re-triggered on FAQ/doctor write.** A run
  costs a Meta API ping and a live model turn (`turn.scripted`); firing that on
  every CRUD write is worse than the bug. The portal re-validates at every go-live
  press regardless, so the dangerous direction is already caught server-side.
  Evidence: `scripts/portal/f1.js` (scratch DB → genesis → real routers → CDP;
  the re-check is a real click on the rendered button) and
  `scripts/portal/shots/f1-{before,after,before-mobile}.png`.
- Audit findings closed: **F-001** (`2d5da98`), **F-003** (`d22dfc5`), **F-003b** (`7a505a6`),
  **F-004** (`e071f69`), **F-005** (`e15bbae`), **F-006** (`58aa1d5`), **F-007** (`d914649`),
  **F-010** (`ba45acc`). Open: F-002, F-008, F-009, F-011 – F-017.
- **Portal v1: COMPLETE.** Sessions S1–S18 merged to `main` (`cdc532e` … `9820685`).
  Two apparent holes in the sequence are not holes: **S7 landed under its finding
  identifier as F-006** (`58aa1d5`) — `docs/specs/portal-v1-spec.md` §10 defines S7 *as*
  the F-006 enforcement session — and **S12 (PDF upload) was deferred to v1.1**, which
  §10 explicitly authorises ("or defer to v1.1 and ship FAQ-only").
- Demo: DEMO-00 (real Sarvam Telugu booking fixture), DEMO-01 (two-pane patient thread
  proof surface), DEMO-02 (inbox + clinic snapshot).
- **Portal v2 Batch 1 is COMPLETE.** Six sessions, one issue each, `869 / 151 / fail 0`
  throughout — the count never moved, which was the plan's own signal that no session
  touched behaviour (`docs/specs/portal-v2-batch1.md` §5).

  | Session | Commit | What landed |
  |---|---|---|
  | D1 | `8559f19` | Tokens, self-hosted Noto Sans, token-drift guard |
  | D2 | `ae5e607` | Grouped navigation, top bar, lifecycle control, `⌘K` |
  | D3 | `be4c1e0` | Truth strip, readiness grouping, empty/loading/error sweep |
  | D4 | `08f2fa4` | Verbatim preview panel |
  | D5a | `bde2aee` | Component sweep, transitional teal tokens retired |
  | D5b | `bfdce87` | Table styles, tabular figures, mobile pass |

  **Outstanding — NOT closed by Batch 1.** Both are acceptance obligations, not
  new work, and neither is dischargeable from a keyboard in this repository:

  - **The portal-v1 §11 acceptance run is UNATTEMPTED.** `docs/specs/portal-v2-batch1.md`
    §5 defines batch acceptance as re-running that criterion end to end on a fresh
    tenant — operator creates an owner account, the owner completes the wizard **on a
    phone, unaided, in under 45 minutes**, readiness reaches green, Go live, then a
    treatment price is edited and the Test page quotes the new price on the next
    message — and the redesign is successful only if that run is *faster* than before.
    **Batch 1 is COMPLETE but not ACCEPTED until it passes.** If it comes back slower,
    §5 reopens D5 and names the sticky save bar and the table→card conversions as the
    suspects.
    ⚠️ **The run has now been ATTEMPTED AND PASSED — founder-reported, 2026-08-03.**
    Under 45 minutes on a phone, unaided, and **faster than pre-redesign**, which is
    the comparison §5 makes the redesign's success conditional on. So D5 does not
    reopen and the sticky save bar and table→card conversions are cleared.
    ⚠️ **This is founder-supplied, not repo-derivable** — the criterion is a human,
    on a phone, unaided, timed, and no timing artefact exists in the repository.
    No wall-clock figure was reported beyond "under 45 minutes".
    **Three earlier attempts produced defects that had to be fixed first**, each a
    hard stop in its own way: **F1** (six FAQs on file, no Go-live control, no
    explanation — the criterion could not be run to completion), **F2** (the Test
    page's composer died after one message, blocking step (f), which needs a second
    message to confirm an edited price is quoted) and **F3** (no way out of the
    wizard; a dead-end reset promise). All three are fixed and above.
    **Issues 3, 4 and 5 from the acceptance report are NOT yet filed here** — the
    §11 run raised five and only F1–F3 have been worked. ⚠️ Their content is not in
    the repository; whoever picks them up should get them from the founder before
    scoping.
  - **Telugu on a real Android device.** D4's DoD asks for it in terms ("verified on a
    real Android device, not an emulator"); D4 had no device and verified headless
    Chrome on Windows only, at 19/34 and 34/58. Conjuncts, matras and inline Latin
    digits were correct with no tofu, and the rupee sign was asserted objectively via
    `CSS.getPlatformFontsForNode` — but the device check itself is outstanding.

- **Portal v2 Batch 1: D5b landed** (harness `shootD5b.js`). Table
  rules, tabular figures, table→card below 640px, the sticky mobile save bar and
  the 320px sweep. Suite **869/151/0, unmoved**. Every changed path is under
  `public/portal/` bar the evidence harness. No route, no fetch, no dependency,
  no build step, **no test changed**.
  ⚠️ **The session's real finding was not a table.** `tokens.css:474` —
  `.ts__a { margin-left: 26px; flex-basis: 100% }` inside `.ts { padding: 9px
  16px }` — put a horizontal scrollbar on **eleven of the twelve navigation
  destinations**, at 320px and at 380px. `flex-basis: 100%` resolves against the
  flex container's *content* box and the margin is added on top, so the overflow
  is exactly `margin-left − padding-right` = 10px at every width. Shipped in D3;
  invisible for two sessions because no width measurement existed. Home measured
  clean only because D5a had suppressed the not-live strip there. **Baseline
  1/12 pages clean → 12/12 after.** The 640–767 band is measured too (7 pages ×
  3 widths, zero overflow), not argued from the content column's max-width.
  ⚠️ **`.golive .btn` was pinned to 32px** — the go-live control, the most
  consequential button in the product, was the smallest touch target on a phone.
  One of eight sub-44px targets found by measuring every interactive box on all
  twelve pages rather than the two the session required; the others were
  `.segmented__btn` (28), `.pace__slider` (20), `.switch` (20), `.starter` (41),
  `.ts__a` (21), `.top__burger` (38) and `.know-edit` (31 wide). `.switch`'s own
  comment claimed *"the hit area stays 44px via the label"* while its label
  measured 72×20.
  ⚠️ **Two elements the portal DELETED on mobile rather than laying out, both
  restored:** the `Past` badge on a holiday row (`hours.css:152`), the only thing
  explaining why a row is dimmed; and `.check__link` (`home.css:182`), the route
  to the fix on the surface that decides go-live, hidden on the exact device
  portal-v1 §11's 45-minute criterion is measured on — a mobile owner saw which
  check was failing and had no way to act on it. `.check__link` was also
  `--faint`, **2.8:1 on `--card`**, a step the token's own comment marks
  "non-text only"; it is `--teal-700` now.
  **No `.tb` component was built, deliberately.** There is no `<table>`,
  `<thead>` or `role="table"` anywhere in `public/portal/` — every register is
  div rows and each page owns its row class. A shared table class with no
  consumers would have been exactly the dead code `.tnum` had been since D5a
  (declared, and used only inside the evidence harness). `.tnum` is now the one
  block carrying tabular figures for all 25 numeric sites, with seven scattered
  copies folded in. It needs `!important`: `font:` resets
  `font-variant-numeric`, this portal's whole type scale is font shorthands by
  design, and three of the clobbering rules live in stylesheets that load after
  `tokens.css`.
  ⚠️ **Deviation from spec §3.3, recorded:** Pricing keeps INLINE editing on
  mobile — no bottom sheet. §3.3's rationale is that "inline cell editing on a
  phone is not viable", meaning click-a-cell-in-a-grid; this page never shipped
  that, `PORTAL-P2-S6` chose full-width stacked inputs on purpose, and a sheet
  would hold the same inputs the card already shows. The card form ships
  otherwise as specified. ⚠️ **Breakpoint is 640, not the spec's 768** — 768
  appears nowhere in this portal (860/640/560/520/480), and 640 sits inside
  §2.12's own `480–767` *tables → cards* band.
  ⚠️ **F-V006 filed** — the Verbatim panel's collapsed mobile sheet overlaps the
  last ~57px of page content when the card is clean; nothing pads for it.
  Pre-existing in D4. Its *other* half is fixed: the sheet was also covering the
  new save bar, and now yields to it.
- **Portal v2 Batch 1: D5a landed** (harness `shootD5a.js`). The shared component
  layer plus the six worklist items accumulated across D1–D4. Suite **869/151/0,
  unmoved**. Every changed path is under `public/portal/` bar the evidence harness.
  No route, no fetch, no dependency, no build step; **no test changed** — D5a's
  Phase 0 checked whether any test asserts the not-live condition's page coverage
  and none does, so the one permitted edit was never spent.
  **D5 was SPLIT.** D5b closed the remainder — see the D5b bullet above.
  ⚠️ **`--teal-hover`/`--teal-press` are GONE**, closing the transitional state D1
  opened. This was the session's real visual risk and it did not resolve the way
  the plan predicted: of the 17 consumers only **one** was a button-fill hover,
  two more were text-colour hovers, and the other **fourteen were resting or
  *selected*-state text colours** that the word "press" fitted only by accident.
  Those took `--teal-700` (the accent on the light ground), not `--teal-900`.
  A blanket replace would have darkened six selected-pill treatments that were
  never a press state. Recorded in `docs/design/brand-values.md` under
  *Not compared*, with the lesson stated: a token parked by a mechanical
  migration records where a value **was**, not what it **means**.
  ⚠️ **The portal had no global focus ring before this commit.** The plan called
  `H` a "retune" of two cited lines; both citations were stale and the real
  inventory was five component-local rules, with every button, link, nav item,
  truth-strip action and modal close falling through to the browser default.
  `booking-rules.css` was additionally stripping the outline and replacing it with
  a colour-only tint — forbidden by spec §2.11 — while the second copy of the same
  toggle in `safety.css` did it correctly. One `:focus-visible` rule now covers the
  portal; the ink ground keeps its own in `verbatim.css`.
  **F-V004's contradiction is CLOSED** (its missing-endpoint half stays open). On a
  legacy clinic the Verbatim panel called itself *Live preview* beside a pulsing
  teal dot while the truth strip 40px above said those settings were not reaching
  the receptionist. The header now reads `Saved settings` and drops the dot,
  sourced from the same `run.checks` field `shadow-notice.js` reads through the same
  shared readiness promise — no new fetch. Photographed with the amber strip in one
  frame, against a clean-tenant control.
  Also: the not-live strip is suppressed **on Home only** (the ring and the grouped
  checks say it better and more specifically; the legacy and paused conditions still
  fire everywhere including Home) · the last two card shadows (`.doc`, `.faq`) are
  gone · `.modal` moved to `--shadow-lg` (the drawer already had it; the toast
  correctly stays `--shadow-md`) · `--amber-50`/`--green-50`/`--red-50` are canonical
  with the padded names aliased, matching the teal convention · every disabled
  control now carries a visible adjacent reason · `.btn--danger` is no longer a solid
  red fill · error toasts persist with a Dismiss instead of fading out after 2.6s.
  ⚠️ **Two deliberate spec deviations, both recorded in
  `docs/specs/portal-v2-batch1.md` §3:** a busy button keeps `disabled` (it is the
  only double-submit guard on the save path, and the save discipline had to behave
  identically), and `Saved · v{N}` is not in `--mono` (the version is written with
  `textContent` by ten scripts; wrapping it means touching the save call).
  ⚠️ **F-V005 filed** — the Verbatim panel can contradict itself on first paint
  (a warning computed from an unfilled form, beside a FACTS row falling back to the
  saved value). Pre-existing in D4, **not** a D5a regression. Observed once;
  a scripted probe mirroring the shot's conditions returned 0/12, so the frequency
  is unestablished and the probe is retained as a reported diagnostic.
- **Portal v2 Batch 1: D4** — the **Verbatim preview panel**, the
  product's signature surface and the largest new one in Batch 1. New
  `public/portal/verbatim.{css,js}`, mounted on the eight editing pages plus Test
  (nine mounts), absent from Home, History and `knows.html`. Suite **869/151/0,
  unmoved**. Every changed path is under `public/portal/` bar
  `scripts/demo/fetch_fonts.js` (F-V001's generator, above) and the evidence
  harness `scripts/portal/shootD4.js`.
  **It reads `GET /portal/api/knowledge-summary` — an existing owner-scoped route,
  the one `knows.html` already consumes.** No route, endpoint, dependency or build
  step was added, and the panel has no write path of any kind: zero inputs, zero
  forms, no `configService` call. It is one added client call site, taken
  deliberately — see the next bullet.
  ⚠️ **There is no rendered-composite preview endpoint under `/portal/api/`, and
  the panel therefore shows STORED state, not what the renderer will emit.** All
  36 portal routes were walked; `knowledge-summary` is explicit that "their
  returned prompt TEXT never crosses this route". So the greeting bubble shows the
  clinic's saved greeting rather than a rendered turn. Filed as **F-V004**.
  ⚠️ **`knows.html` is NOT a subset of the panel and is RETAINED.** It carries
  whole-config breadth in one view and the built-in-protections card, which quotes
  verified guardrail instructions the panel never shows. The panel links to it
  ("See all"). This closes the question spec §1.3 left open for D4; `knows.html`
  was not modified and is not retired in D5.
  **The panel ships zero product-authored Telugu or Devanagari.** Every vernacular
  string in it is tenant-authored; empty states are English. The native-review gate
  named in `docs/specs/portal-v2-batch1.md` §6.2 therefore does not apply to D4.
  ⚠️ **Not verified on a real Android device.** Spec §3 D4 asks for it and this
  session had no device. Telugu was verified in headless Chrome on Windows at
  19/34 and 34/58 (conjuncts, matras and inline Latin digits correct, no tofu),
  plus an objective ink-clipping measurement on the collapsed sheet's handle. The
  Android check is outstanding.
- **Portal v2 Batch 1: D3** (`be4c1e0`, harness `503cd51`). The truth strip,
  readiness check grouping, the restyled ring, and the empty/loading/error sweep.
  Presentation only — no route, no fetch, no dependency, no behaviour change; suite
  **869/151 unmoved**, and the one permitted test edit was a string swap inside an
  existing `it()` (`portalShadowNotice.unit.test.js:235`), so the count did not move.
  Every changed path is under `public/portal/` bar that one test file.
  **This closes F-F001's portal half.** The strip was built by EXTENDING
  `shadow-notice.js`, not by adding a second component — a parallel global strip
  alongside the working per-page notice would have put two amber blocks on every
  shadowed page reporting one condition; a `probe()` pass in the harness asserts there
  is exactly one. The per-page notice did not go away: it is what the strip says when
  standing on a shadowed page, and its full text is the lead of the strip's
  *What this affects* modal.
  ⚠️ **The spec's fourth strip condition, *partially connected*, was NOT built.**
  `/portal/api/readiness` carries no channel-connection state, and deriving it from the
  whatsapp/voice checks is unsound twice over: a SKIPPED `voice.config` means voice is
  switched off for that clinic rather than unconfigured, and since `voice.config` is
  material a tenant with it failing can never be `live`, so the higher-priority
  not-live condition would always win. It would have been unreachable code.
  `validationService.js` was not opened; `material: false` is unchanged.
- **Portal v2 Batch 1: D2** (`ae5e607`). Grouped navigation, top bar,
  lifecycle control, command palette. Presentation only — no route, no fetch, no
  dependency, no behaviour change; suite **869/151/0, unmoved**. Every changed path is
  under `public/portal/` (16 files; new `cmdk.js`). The flat 12-item sidebar became four
  labelled groups plus an empty `TODAY` group reserved for Tier 2, and the active nav item
  gained a 2px bar that survives greyscale where the tint alone does not.
  ⚠️ **The spec's nav drawing did not match the shipped product**, and three corrections
  were folded back into `docs/design/portal-v2-spec.md` §3.0/§1.3/§3.7 in `3275eda`:
  the portal has **12 navigation destinations, not 14** (13 sidebar rows, 13 files with the
  shell, 14 `.html` — statements about *stylesheet* coverage saying "14 pages" remain
  correct); **`knows.html` was absent from the spec's nav entirely** and is now filed under
  CHECK, the sidebar being its only inbound link; and **`Documents` returns as an inert
  `Soon` row** (no page — `PORTAL-P6-S18` had removed it; the v2 spec reverses that).
  ⚠️ The sidebar footer ships **clinic name + role, not email** — `/portal/api/me` returns
  `{ id, role }` and no address, and surfacing one needs a route.
  ⚠️ **History's snapshot is a modal, but spec §3.7 specifies a full-page sub-view.**
  Unresolved, deferred to D5 or later; the top bar's breadcrumb slot stays empty for
  exactly as long as it stays a modal.
  ⚠️ `knows.html`'s future is **undecided** — D4 Phase 0 reads it and rules on retire vs
  retain as a linked advanced view (spec §1.3).
- **Portal v2 Batch 1: D1 landed** (`8559f19`). Token layer only — no markup, no
  JS, no behaviour. `--teal-600`/`--teal-700` changed meaning (old darker-steps convention
  → standard 50–900 ramp), so their 21 consumers across 11 stylesheets were migrated onto
  transitional `--teal-hover`/`--teal-press` in the same commit; teal renders unchanged
  (verified by resolving all 610 `var()` uses before and after — zero colour deltas).
  `--sans` no longer names a face the repo does not ship: Noto Sans Latin 400/500/600/700
  is self-hosted via `scripts/demo/fetch_fonts.js`, which now takes an output directory and
  a family list. Card shadow deleted; radius tightened to 4/6/10/14. New:
  `docs/design/brand-values.md` + `tests/design/tokenDrift.test.js`, which bind the four
  `:root` surfaces (portal, demo/shared, demo/styles, web) to one recorded table.
  ⚠️ D3–D5 are unstarted; `--teal-hover`/`--teal-press` are removed in D5.
- Portal v2's governing documents are now **in the repo** (`74e13e1`): the design spec
  (`docs/design/portal-v2-spec.md`), the approved Batch 1 mockups
  (`docs/design/prantivo-mockups-batch1.html`) and the 5-session plan
  (`docs/specs/portal-v2-batch1.md`). The mockups landed on disk as `portal-v2-spec.html`
  and were renamed to the path the plan's Basis line already cites. Docs only — no source
  file changed, so this is a provenance-only `Verified-at` bump.
  ⚠️ **The spec's own Status line still reads "Proposal"** while the plan and the commit
  that landed it both call it frozen. The required override exists — **D-005** overrides
  the H5 ranking §0.2 demands and carries its falsifiable prediction — so the work is
  authorised; only the Status line is stale.
  ⚠️ **D-005's budget is 10 sessions, hard cap, and 5 were spent before D1.** This line
  previously read "Batch 1 is D1–D5, so completing it lands exactly on the cap." **That is
  no longer true, and the reason is the D5 split.** Batch 1 shipped in **six** sessions —
  D1, D2, D3, D4, D5a, D5b — so the program has now consumed **11 of a 10-session hard
  cap. It is one session over.** Nobody authorised the eleventh; the split was a scoping
  decision taken inside D5 and its budget consequence was not carried back here at the
  time. Recorded rather than netted off, because a hard cap that quietly absorbs an
  overrun is not a cap.

  **SETTLED — the founder has written the overrun off.** The previous version of this
  line said the disposition was the founder's to make and that no session could treat it
  as settled until the entry existed. This is that entry, founder-supplied and recorded
  verbatim:

  > Batch 1 closed at 11 sessions against a cap of 10. Written off. The
  > eleventh was the D5 split (components / mobile), taken because a single
  > session touching every component, every register and the 320px sweep
  > produces a diff nobody can review. Root cause of the overrun is not the
  > split: four sessions were consumed by defects the plan could not have
  > listed, because the plan was written from a source-read audit and every
  > one of those defects was only findable by measuring a running portal —
  > the --teal-600/700 collision, the absent global focus ring,
  > tokens.css:474's 10px overflow, and eight sub-44px touch targets.
  > Carry forward: Batch 2's estimate is drawn from measurement, not reading.

  Written off means the eleventh session is not deducted from any future allocation and
  is not carried as a debt. It does **not** mean the cap was raised: D-005's cap stands
  at 10 and the program stands at 11 against it, on the record. The spec estimates 14–18
  sessions for the full document; **any Batch 2 needs a new decisions.md entry, not an
  extension** — D-005 says so in terms, and that requirement is now doubly binding.
  **Registered as `D-007`** (`docs/os/decisions.md`), which is the entry D-005's Budget
  clause requires. `D-006` was not free — it is claimed by the unappended `web/` deploy
  draft. D-007 carries the falsifiable prediction the write-off needs to be a decision
  rather than a preference: *Batch 2, if scoped from measurement rather than from reading
  source, comes in within its stated cap* — and if it overruns by more than one session,
  the estimating method is wrong and the cap mechanism is not the remedy.
  ⚠️ **D-007 is a write-off, not clearance.** **Batch 2 is not scheduled and nothing is
  queued behind Batch 1.** G-PROOF is still false — no production deploy, no live call —
  and D-005's terms require Batch 2 to have its own entry before a session may open it.
- **F-V001** — **CLOSED** at D4 Phase 0 on resolution path 1. `Noto Sans` now
  carries U+20B9 through four weight-distinct `text=`-subsetted faces of ~830
  bytes each (3.2 KB total), generated by a new `rupee` entry in
  `scripts/demo/fetch_fonts.js`; the ten pre-existing faces regenerated
  byte-identical and `public/demo/` was untouched. The sign and the digits beside
  it now render from one typeface at one weight, asserted with
  `CSS.getPlatformFontsForNode` against a control rather than eyeballed. Full
  finding and the `familyName`-vs-`postScriptName` trap in
  `docs/specs/portal-v2-batch1.md` §6.
- **F-V002** (open) — Variable-font duplication in `public/demo/`. Own session after
  Batch 1. See `docs/specs/portal-v2-batch1.md` §6, which now carries the
  **exclusion** that entry was missing: the four `noto-rupee-*.woff2` static faces
  F-V001 added are not duplication and must survive the consolidation unchanged.
  Folding them into a variable face silently reverts F-V001.
- **F-V004** — the **contradiction half is CLOSED** at D5a; the missing
  rendered-composite endpoint stays open. See the D5a bullet above.
- **F-V005** (open, new) — the Verbatim panel can contradict itself on first paint.
  Pre-existing in D4, found by D5a's evidence run, frequency unestablished.
  `docs/specs/portal-v2-batch1.md` §6 item 9.

### Remaining before first live call

By issue number, from `docs/specs/zyon-first-launch-plan.md`.

**Plan-of-record numbers are the only issue sequence this project has.** There is no
GitHub issue tracker in use and nothing in the repo references one, so the launch plan is
the numbering authority — allocate the next free number there. (Whether issues exist on
github.com is not repo-derivable; what is verified is that nothing in this repo cites
them.) The sequence runs to **34**, not 28: the original plan defined 1–28 and later work
kept counting.

- **Done:** 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 21, 22, 29, 30, 31, 32, 33, 34
- **Not done:** 1 (ops), 2 (ops), 11, 12, 13, 14, 20, 23, 24, 27, 28
- **Residue-only** (built and tested; awaiting Issue 20 for a prod render): 25, 26

**Issues 31–33 — verified complete (2026-07-28), was "allocated, unverified."** The
Issue-NN ↔ V-number mapping is still recollection, not a repo-written fact — no
`Issue NN` string exists anywhere in the repo for these three, and that residual is
unchanged. What this session verified is the underlying fix each number was allocated
to, independent of the numbering question:

- **31 / V-004** (terminal-transition guard on `call_sessions`, `5bb60ab`) —
  `callSessions.updateStatus` guards the terminal UPDATE on
  `WHERE status = 'in_progress'` (`src/modules/voice/callSessions.js:51-70`);
  `voiceChannelAdapter.endSession` emits `call.ended` only when a transition actually
  happened, never on the no-op path (`voiceChannelAdapter.js:69-83`). Three dedicated
  tests reproduce a sequential double-end, a failed→completed flip attempt, and a
  concurrent double-end, each asserting exactly one transition and one emission
  (`tests/voice/voiceLifecycle.integration.test.js:285-348`).
- **32 / V-008** (slot-grid validation, `629f7fb`) — `bookAppointment` rejects
  off-grid times before the INSERT (`src/modules/appointment/appointmentService.js:309-322`,
  `isOnGrid` at `:98-100`), sourced from the same `resolveBookingRules` both
  `bookAppointment` and `checkAvailability` share, so a slot never offered can never
  book and vice versa. `tests/appointment/slotGrid.unit.test.js` covers rejection,
  acceptance, grid-size variation, the IST timezone frame, and parity with
  `checkAvailability` (9 tests).
- **33 / V-009** (history excluded by id not `OFFSET 1`, `f097b77`) —
  `customerService.getRecentMessages` requires `excludeMessageId` and excludes
  `WHERE id <> $3` (`src/modules/customer/customerService.js:34-46`), threaded through
  the shared `assembleConversationContext` from both the WhatsApp and voice channels
  (`contextAssembler.js:54-56`, `internalVoice.js:184-186`).
  `tests/customer/historyExclusion.integration.test.js` reproduces the exact
  cross-channel race the old `OFFSET 1` query got wrong (a concurrent WhatsApp message
  landing mid-turn) and proves the fix keeps it while dropping only the current row.
  ⚠️ Residual: the review's recommended `id DESC` tiebreaker on the `ORDER BY` was not
  added — affects ordering among same-millisecond writes only, not the exclusion
  correctness the finding was about.

Verification this session: `node --test` on each file above (13/13, 9/9, 3/3), plus a
full `npm test` re-run clean at `95fbfde` (868/868, 151 suites — unchanged from the
recorded figure) and `npm run os:check` OK. No source file changed, so `Verified-at`
above is untouched — this commit only adds docs/os/ content.

Additions since the original 1–28, all in the plan's Phase 8:

- **29** — turn cancellation + coordinated deadlines (V-001/V-003), `1605954`. DONE.
  Referenced in 12 files incl. `src/routes/internalVoice.js:58,116,220,248`,
  `src/modules/ai/aiService.js:22,82,190,216,310`, `src/db/db.js:4`,
  `src/infra/config/env.js:59`, `tests/db/statementTimeout.test.js:3,17`.
- **30** — per-channel extraction policy (V-002), `2948a10`. DONE.
  `src/modules/config/schema.js:250`, `tests/crm/extraction.bus.test.js:94,312`,
  `tests/voice/voiceLifecycle.integration.test.js:181`.
- **34** — admin-created tenants silently ignore all portal-written prompt copy. **DONE**
  in two halves: the owner-facing warning (F-F001, `6ceb8f0`) and option (a), the removal
  of the hazard (`69ceb7f`). This is A-007/A-008 promoted to the queue. Full finding at
  `docs/specs/issue-34-legacy-prompt-shadows-portal-config.md`.
  The prompt field is gone from `public/admin/tenant-new.html` and
  `POST /admin/api/tenants` now refuses a non-empty `ai_prompt`
  (`src/admin/adminRoutes.js:104-121`) instead of forwarding it, so admin-created
  tenants are born on the renderer like `provisioningService.js:226` already did.
  **The capability was preserved, not removed** — `scripts/update-prompt.js` still sets a
  legacy prompt deliberately, and the F-F001 notice still fires for a tenant it creates
  (both proven by live run this session). `aiService.js`'s legacy precedence is unchanged.

## Frontend modernisation program (D-005) — COMPLETE

Authorised by `D-005` (`56e7f46`), specified by `docs/audit/2026-07-frontend.md`
(`90d1da3`). Closed at `e50d7ba`. The audit is the historical
record of what was found and is not edited; this section is the ledger of what was done
about it.

**Shipped — 8 of 9 findings**

| Finding | S | What closed it | Commit |
|---|---|---|---|
| F-F001 | S-B | Portal warns an owner when a legacy `tenants.ai_prompt` shadows their saved settings; names which fields are inert. **Portal half fully closed at `be4c1e0`** — the warning became the portal-wide truth strip, and Home no longer renders `Using the latest instruction format` on the clinics the check is warning about. The renderer is unchanged. | `6ceb8f0`, `be4c1e0` |
| F-F002 | S-A | `web/lib/siteConfig.ts` resolves from environment; production build refuses placeholders (**unblocked portion only** — see Open) | `9b5486a` |
| F-F004 | S-A | `web/` recorded as a first-class surface under *Stack (frozen)*; gate 2 names the gap in Issue 20's scope (**partial** — see Open) | `9b5486a` |
| F-F005 | S-A | Hero plays a Telugu conversation; `Noto_Sans_Telugu` with `subsets: ["telugu"]`; first two lines verbatim from `public/demo/fixture.json` | `634b7aa` |
| F-F006 | S-A | Mobile nav drawer closes on link tap and on Escape; focus returns to the toggle | `e50d7ba` |
| F-F007 | S-A | Collapsed FAQ answers carry `inert` + `visibility: hidden` — out of the a11y tree, out of Ctrl+F, out of the tab order | `e50d7ba` |
| F-F008 | S-A/S-B | `web/` adopts the portal's teal brand accent. The site moved, not the portal | `e50d7ba` |
| F-F009 | S-A | Four colour-only focus indicators gained the existing 2px/4px ring | `e50d7ba` |

**Open, and why**

- **F-F003** — the legal pages still ship bracketed placeholders. Blocked on **C-1**
  (business entity registration, `docs/os/clocks.md`). Not schedulable: the fix is to
  write facts that do not exist yet.
- **F-F002 residual** — `legalEntityName` remains exempt in `siteConfig.ts`'s guard, and
  the deploy-environment values are unset. Blocked on C-1 and on the domain purchase,
  which is deferred by founder decision. While the exemption line exists, an unfiled
  external clock is holding a production build open on a knowingly false statement.
- **F-F004 residual** — the `web/` deploy host is founder-unconfirmed. `D-006` is drafted
  in `docs/os/decisions.md.draft`, not `decisions.md`, awaiting that confirmation.

**Deliberately not scheduled**

- The **nine S5 appendix items** of the audit. Not cut for cost — they are below the
  threshold at which a prospect notices.
- The **cross-surface token values file and its drift test** (the audit's "token
  question" remedy). Cut by founder decision and still cut. `--accent` was the only one
  of the three divergences that carried brand meaning, and F-F008 resolved it directly.

**Spend against the cap**

Five sessions of D-005's ten-session hard cap: the Stage 1 audit (`90d1da3`), then
Stage 2 items 1 (`9b5486a`), 2 (`634b7aa`), 3 (`6ceb8f0`) and 4 (`e50d7ba`). The
audit's own effort lines budget **17h** for the eight findings that shipped, of a 20h
total; the 3h remainder is F-F003. ⚠️ Actual hours are not recorded anywhere in the
repository — no session log exists — so the 17h is the estimate, not a measurement.
⚠️ **Corrected at D5b.** This paragraph used to end "Five sessions remain unspent and are
**not** carried forward: D-005's terms cancel the unspent backlog if the prediction
fails." Those five were not left unspent — they were spent on Portal v2 Batch 1, which
took **six** sessions rather than five because D5 was split into D5a and D5b. The
program therefore stands at **11 sessions against a 10-session hard cap**.

**The cap question is SETTLED: written off by the founder.** The full text and what
"written off" does and does not mean are under *Portal v2's governing documents* above,
where the budget note lives. Summarised here so this ledger is not read alone: the
eleventh session is neither a debt nor a raised cap, and the founder's stated root cause
is that the plan was written from a source-read audit, so four sessions went to defects
only a running portal could have surfaced. **The entry is `D-007`** — appended to
`docs/os/decisions.md` in the same commit as this line, because D-005's terms say
"Overrun requires a new entry, not an extension of this one" and `decisions.md` is the
register a founder decision carrying a prediction and a review date belongs in. It
reviews at Batch 2 close or 2026-10-31, whichever is first. D-005 itself is untouched:
append-only means the cap of 10, its prediction and its 2026-10-01 review all stand as
written.

**Note for the D-005 review (2026-10-01, or ten logged clinic conversations)**

D-005's prediction is about **objections raised in clinic conversations**. Roughly
two-thirds of this program by effort is `web/` work, and `web/` is **undeployed by
founder decision** — no prospect has seen any of it. A review that scores the prediction
against conversations held before a `web/` deploy is testing the portal and demo
surfaces only. **The review is therefore partial, not failed**, and the Outcome must
record which of the two it is. Not written here: the review date has not arrived and
the judgement is the founder's.

## Stack (frozen)

Node reasoning brain (sole reasoning engine) · Python LiveKit worker (transport only) ·
PostgreSQL raw SQL + pgvector · Gemini 2.5 Flash · Sarvam saaras:v3 STT + bulbul:v3 TTS ·
Plivo · WhatsApp Cloud API · Railway · Neon (dev only)

Verified against `package.json` and `voice-agent/pyproject.toml` + `voice-agent/uv.lock`:

- `gemini-2.5-flash` — `src/modules/ai/aiService.js:13`
- `saaras:v3` / `bulbul:v3` — `voice-agent/agent.py:71-72`
- Worker deps: `livekit-agents==1.6.4`, `livekit-plugins-sarvam==1.6.4`, `httpx`,
  `python-dotenv`. **No LLM SDK** — architecture invariant 1 holds by dependency list.
- **Plivo is a throwing stub**, not a live component (`src/modules/telephony/providers/plivo.js`,
  every method raises `NotImplemented`). Listed here as the intended provider, not a
  shipped one.
- **`web/` is a separate Next.js 15 / React 19 / TypeScript application** — the marketing
  site, and the only prospect-facing surface. It carries its own dependency tree,
  `package-lock.json` and `node_modules/`, and nothing in this repository builds, serves,
  tests or lints it:
  - not served by `server.js` — `express.static` covers `public/` only (`server.js:90`;
    the admin mount at `src/admin/adminRoutes.js:62` is also `public/`-derived);
  - not built by any script in the root `package.json`;
  - **zero of the 869 tests touch it** — `tests/design/tokenDrift.test.js` parses
    `web/app/globals.css` as text but executes nothing in it. The root suite's green is
    silent about `web/` behaviour, so
    a `web/` change is evidenced by the build artifact, not by `npm test`.
  - `web/vercel.json` is **headers-only** — five security headers, no build command, no
    output directory, no root directory.
  Introduced `34db490` (2026-06-26), which **predates** `docs/specs/portal-v1-spec.md`
  (`5c6b4e2`, 2026-07-18) by three weeks. §2's static-stack constraint ("no SPA, no
  framework, no bundler") is scoped to the portal UI served by `express.static('public')`
  and does not govern `web/`; the surface has never been in breach of it.
  ⚠️ **The deploy host is founder-unconfirmed and not repo-derivable.** No `railway.json`,
  `Dockerfile`, `Procfile`, `nixpacks.toml` or CI workflow exists anywhere in the
  repository. `web/README.md` names Vercel and `vercel.json` implies it, but a headers
  file is not a deploy: it configures a host that something else must have chosen. Vercel
  is convention here, not evidence. The founder must confirm the target; a `D-006` draft
  awaiting that confirmation sits in `docs/os/decisions.md.draft`.
  Site configuration is environment-resolved as of Stage 2 Item 1 — see `web/.env.example`
  for the variables a deploy must supply, and note that a production build **fails** if a
  required one is missing. See `docs/audit/2026-07-frontend.md` F-F004 and F-F002.
- **Corrected:** the previous "Neon (dev/test)" was drift. The test path is local
  Postgres via `TEST_DATABASE_URL` (`tests/_support/testEnv.js`, `c673673`). Neon is
  dev-only.

## Architecture invariants

Verified at HEAD:

- **Node is the sole reasoning brain** — the worker's dependency list contains no LLM SDK.
- **`tenant_id` scoping everywhere** — holds, with the two open F-016 letter-violations noted above.
- **`configService` is the single config path** — every reader and writer of the config
  document goes through it. `doctorService` (`tenant_entities`) and `faqService`
  (`knowledge_chunks`) use separate storage **by design**, per `docs/specs/portal-v1-spec.md` §7.
- **Parameterised SQL only** — 233 sites audited clean; unchallenged since.

⚠️ Not repo-derivable — these are process invariants, evidenced only by habit:
all branches fast-forward onto main · one issue per session · runtime evidence closes a session.

## Known open risks

- **Distribution is the existential risk**, not capability. Clinic sales in India are
  trust-based; the durable asset is an exclusive channel plus outcome-labelled vernacular
  transcripts. ⚠️ market claim, not repo-derivable.
- `VOICE_STREAM_TURNS=true` is the only perceptual latency fix required at deploy.
- **Portal-written prompt copy is silently inert on any tenant carrying a legacy
  `tenants.ai_prompt`** — see A-007 in `docs/os/assumptions.md`. **No longer reachable by
  accident** (Issue 34): the admin form no longer offers the field and the create route
  refuses it, so every newly created tenant — admin or portal — is born on the renderer.
  The condition still exists for any tenant deliberately given a prompt via
  `scripts/update-prompt.js` or the voice seed script, and for any legacy tenant already
  carrying one; those keep their prompt and their precedence behaviour unchanged, and the
  F-F001 portal notice is what warns their owner. ⚠️ **Zero such tenants are known to
  exist** — there is no production deploy, so this is a hazard retained for a population
  that is currently empty.
- **F1-R1 — the EDIT half is CLOSED (this commit); the DELETE half remains open
  below.** Both tables carried `created_at` and no `updated_at` and no
  `set_updated_at` trigger, so `max(created_at)` could not rise on an in-place
  edit. Migration `026` added `updated_at` + the existing trigger to both, and
  `validationInputsChangedAt` now reads it — so an in-place FAQ edit, an in-place
  schedule edit and a doctor **archive** all expire the run. The archive was not
  in the original filing and is the case that mattered most; full entry under
  *F1-R1* in Engineering above.
- **F1-R2 (open, new) — a DELETE still cannot expire a validation run.** The
  residue of F1-R1, and the half no timestamp column can close: removing a row
  **lowers** `max(updated_at)` rather than raising it, so deleting the 5th FAQ
  takes a clinic below `kbMin` while the run still reads fresh and the ring still
  reports the old, **higher** verdict. ⚠️ *This identifier is minted here for
  bookkeeping — the founder filed the condition, not the name.*
  **Start from the analysis, not from rediscovery.** Two candidate signals, both
  named at the fix site (`lifecycleService.validationInputsChangedAt`):
  (a) a tenant-level touch on delete — cheap, but it puts a write on a read path
  and needs a home that `writeStatus` does not already bump (see the
  `tenants.updated_at` exclusion, which is why the obvious column is unavailable);
  (b) carry a **row count** in the union beside the timestamp and compare it to
  the count the run recorded — strictly more correct, since it catches any
  cardinality change in either direction, at the cost of the run having to persist
  what it counted.
  Blast radius unchanged and worth restating precisely: the portal's Go live
  always runs `validate` before `activate` (`runGoLiveChain`), so a deletion that
  drops a clinic below `kbMin` is still refused **at the press**. What is exposed
  is (a) the ring reading one check too high until the next run, and (b) the
  **admin** panel's separate `activate`, which can act on a passing run that a
  deletion has since invalidated.
- **B2-R1 (open, new) — there is no patient-facing way to CANCEL.**
  `appointments.status` has carried `'cancelled'` since migration `003` and
  **nothing writes it**: no tool, no route, no portal control, no script. A
  patient can now book and move; to cancel, someone edits the row by hand. Filed
  deliberately out of B2's scope. The shape is smaller than a reschedule — one
  status flip, no new slot to validate — and it reuses B2's server-side lookup and
  its `appointment_not_found` refusal wholesale.
- **The test suite makes live third-party API calls, so `# fail 0` is not purely a
  function of the code.** The Item 4 session saw `npm test` return `862 / fail 1` on a
  live Gemini embedding 503, then pass unchanged on re-run. This weakens every green
  claim in this file, including `os:check`'s — that script shells out to the same suite,
  so a third-party outage reads as state drift. **Open.** The obvious fix is a stubbed
  embedding in the test path; deliberately not done in the Issue 34 session that recorded
  it. Distinct from the Neon-latency nondeterminism under *Resolved* below, which was a
  different cause and is genuinely closed.

## Resolved

- ~~Test-suite nondeterminism traced to Neon network latency~~ — **resolved** by
  `c673673` (TEST-FLAKE-02). `tests/_support/testEnv.js` is the single seam that
  repoints the suite at a local Postgres via `TEST_DATABASE_URL`, loaded through
  `--require` so it beats every module-level pool construction. Neon is dev-only now.
  **This closed the database cause only.** A second, unrelated source of suite
  nondeterminism — live Gemini calls in the test path — is open under *Known open risks*.
  Do not read this entry as "the suite is deterministic."
