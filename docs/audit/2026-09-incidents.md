Veprio · Admin · Phase 0 audit · no code written

Incidents is a trace list, not a filtered conversations list
The brief's premise was that Incidents is "the conversations page, failure-filtered." Measured at 9cb5316, the conversations route cannot express failure at all, and the traces route cannot express it across tenants. Both spines need a route change; only one of them is the right spine.

HEAD 9cb5316
tests 1207 / suites 199 / fail 0
os:check exit 0 ×2
turn_traces rows 0
tracked files changed 0
The answer, before the working
The spine is turn_traces. The failure signal exists in exactly one table and one column, and neither the conversations route nor the conversations page has any concept of it. A failure-filtered conversations list would have to invent the signal it filters on.

Cross-tenant triage is reachable without a route change, and reaching it that way is wrong. A page can fan out over /admin/api/tenants and call /admin/api/traces once per tenant. But the route applies its LIMIT after ORDER BY created_at DESC and before any failure predicate, so "the failures" can only ever mean "the failures inside the newest N turns." At 200 rows — the route's hard ceiling — a clinic doing a turn a minute is covered for 3.3 hours. A page built this way reports zero incidents for a tenant that has many, and reports it confidently.

So the central finding stands, in a sharper form than the brief anticipated: the gap is not that cross-tenant is unreachable. It is that failure-filtered is unreachable — on either route — because no route can filter on error. That is one predicate and one index, and it belongs to a route session that must land before any page session.

§1
The spine
Q1–Q4, by measurement.

Q1 Can the conversations route express "failed"? no
Read in full at src/admin/adminRoutes.js:330–399. It accepts exactly five inputs — tenant_id (required UUID, :338), status ∈ open|closed|pending (:307, :332), channel ∈ whatsapp|voice (:308, :333), before (cursor), limit (1–100). Its query joins conversations, tenants, customers and messages. It never touches turn_traces.

Against the five failure classes:

What the conversations route can filter on
Failure class	Where it lives	Expressible?
Turn threw	turn_traces.error = {stage,message,status}	no
Turn aborted	turn_traces.error.outcome = 'aborted'	no
Tool call errored	turn_traces.tool_calls[].outcome.status	no
Reply truncated	turn_traces.llm.finish_reason	no
Turn never reached the model	turn_traces.llm IS NULL	no
Zero of five, and not by a narrow margin: the route's FROM clause does not reach the table that carries any of them. I checked the one plausible alternative signal too — conversation_events (migration 029) has three writers (whatsapp/routes.js:265, internalVoice.js:287 and :545) and every one of them writes type: 'handled'. 'escalated' is deliberately absent from the emitters (029_conversation_events.sql:81). There is no failure event.

Q2 Can the traces route express it? partly
GET /admin/api/traces (adminRoutes.js:974–1010 over src/modules/traces/queryService.js:17–33) takes tenant_id (required), conversation_id, correlation_id, limit (1–200, default 50). Its WHERE is assembled from those three ids and nothing else; it returns SELECT * ordered created_at DESC, turn_id DESC.

It can express failure only in the client. Every field the five classes live in comes back in the payload, so a page can classify a row — public/admin/traces.js:80–87 already does, and correctly. What the route cannot do is select on any of them. The consequence is the ordering trap: LIMIT is applied to the newest-first window, not to the failures. Rank-then-truncate, never filter-then-rank.

Two further contract facts worth carrying: the list route returns a bare JSON array, not the {rows, next_before} envelope the conversations route uses — so there is no pagination cursor on traces at all; and SELECT * means every error.message and every tool_calls[].outcome.error in the window crosses the wire whether or not the page renders them.

Q3 The tenant problem reachable, but not usefully
GET /admin/api/tenants (adminRoutes.js:162–168) is SELECT … FROM tenants ORDER BY created_at DESC with no scoping — it is the operator's own tenant list, and it is the seam. A cross-tenant view is therefore reachable today by client-side fan-out: enumerate tenants, then one /admin/api/traces?tenant_id=… per tenant, merge and sort in the browser. Nothing rate-limits it (apiLimiter is attached only to mutating routes; both GETs carry requireAuth alone).

Why that is the wrong answer even though it works
It cannot answer the page's question. N requests each return the newest ≤200 turns for one tenant. Failures older than that tenant's 200th-newest turn are invisible, and the page has no way to know they were dropped. The page would say "no incidents" and mean "no incidents in a window I can't describe."
No index supports the query anyway. 022_turn_traces.sql:36–38 creates (tenant_id, created_at DESC), (conversation_id) and (correlation_id). Nothing supports a cross-tenant scan ordered by time, and nothing is partial on error IS NOT NULL.
It amplifies F-A031. N × 200 rows of SELECT * pulls the entire unbounded free-text surface of every tenant into one browser tab, to render six columns none of which is free text.
On genesis day N = 1 and the fan-out is indistinguishable from a single call. That is exactly what makes it dangerous: it will look correct for as long as it is untestable, and stop being correct without a symptom.

Q4 Which spine traces
A trace list keyed by failure, with conversation as an attribute — with a route change first. The measurements that force it:

The failure signal exists in one table. The conversations route does not read that table, and giving it one would mean joining turn_traces into the thread list — putting a turn-grained fact on a thread-grained row, where "this thread had a failure" cannot say which turn, when, or of what kind.
The trace list already renders the exact six columns Incidents needs (time, correlation id, conversation, channel, total, status) and already links to the explainer. Incidents is that list with a different WHERE, a tenant column, and a rank.
The classifier already exists and is already correct — traces.js:80–87, a pure function of error. A conversations-spined Incidents would need a second one.
§2
Severity
Q5–Q7. Derived, and where it cannot be derived, excluded.

Q5 Every closed-set field that can indicate failure
Enumerated by reading each writer, not by grepping for values.

Closed sets, and the code that writes each value
Field	Complete value set	Written at
error	SQL NULL · object	writer.js:83 via j():63 — never a scalar
error.outcome	'aborted' · absent	collector.js:87 (setAbort) is the only writer
error.abort_reason	'client_gone' · 'deadline'	internalVoice.js:152 abortReason(), used at :300 and :311
error.aborted_after_commit	true · false	collector.js:89 — !!afterCommit
error.stage	hydrate_validate · persist_inbound · fetch_parallel · persist_outbound · dispatch · generate_reply · null	the six timer.start() literals (internalVoice.js:155,196,236,259,402,436,470,526,583; whatsapp/routes.js:184,216,233) plus the explicit args at testTurnService.js:139, whatsapp/routes.js:208 & :228, scriptedTurnCheck.js:259, and the ?? 'generate_reply' fallback at collector.js:73
tool_calls[].outcome.status	'ok' · 'error'	aiService.js:511–517 toolOutcome — the only producer
tool_calls[].outcome.success	true · false · absent	aiService.js:514–516
channel	'whatsapp' · 'voice' · 'test'	whatsapp/routes.js:149, internalVoice.js:124 & :363, testTurnService.js:98 (F-A032: the DDL comment still names two)
Not closed — say so rather than pretend
error.status is not a closed set. collector.js:75 writes err.response?.status ?? err.status ?? null — an HTTP status from whatever upstream threw (Meta's Cloud API, Gemini). Any integer, or null. It is a useful detail and must not be a severity input.
llm.finish_reason is closed at Gemini, open here. aiService.js:507 passes response.candidates[0].finishReason through verbatim; nothing in this repo constrains or enumerates it. MAX_TOKENS is known to occur — extractionHandler.js:127 special-cases it — and a MAX_TOKENS turn is a truncated reply the patient actually saw, with error NULL. Real, and not derivable from a set this repo owns.
error.message and tool_calls[].outcome.error are unbounded free text (F-A031). Not sets at all.
Q6 A severity mapping that is a pure function of those sets
The mapping already exists, is already correct, and Incidents must consume it rather than write a second one. public/admin/traces.js:80–87:

// derived from `error` AND NOTHING ELSE
function statusOf(row) {
  const e = row ? row.error : null;
  if (e == null) return { key: 'ok', … };
  if (typeof e === 'object' && e.outcome === 'aborted')
                 return { key: 'aborted', … };
  return           { key: 'failed', … };
}
Three levels, total over the column's two-value domain (NULL · object), no thresholds, no counts, no windows. The one extension Incidents can justify is a fourth level below failed, and only because it reads a different closed set on the same row:

The proposed ladder — every level a pure function of a closed set
Level	Predicate	Closed set it reads
failed	error IS NOT NULL AND error.outcome IS DISTINCT FROM 'aborted'	error presence
aborted	error.outcome = 'aborted'	error.outcome
tool error	error IS NULL AND ∃ tool_calls[].outcome.status = 'error'	outcome.status
ok	none of the above	—
The third level is the one that earns its place: seed fixture 2 (seed-turn-traces.js:165–180) is a turn with error: null and a book_appointment call that returned {status:'error'}. The turn succeeded; the patient did not get their booking. The trace viewer ranks it ok, correctly, because it is asking a different question. Incidents is asking this one.

Excluded, by name, because they encode a guess
Any ordering of failed above or below aborted by badness. aborted_after_commit: true means the turn crossed the point of no return and completed persistence anyway — internalVoice.js:295–305 still returns the reply. That abort is less severe than most failures. false means generation stopped, which is more severe than a failed tool call. The field is closed, but which of the two is "worse" is a judgement about patient impact that no column states. Rank by recency inside a level; do not rank the levels against each other beyond the four above.
Stage-weighted severity (a dispatch failure "matters more" than a fetch_parallel one). The stage set is closed; the weighting is invented.
error.status-derived severity (5xx worse than 4xx). Not a closed set; see Q5.
MAX_TOKENS as a level. Genuinely a failure, genuinely visible to the patient, and genuinely not derivable from a set this repo owns. Excluded, and filed rather than smuggled in.
Q7 What this page cannot say until real traffic exists
Structurally unavailable, so that no later session mistakes their absence for an oversight:

Any rate. "3% of turns failed" needs a denominator the page would have to fetch separately and would be reading off the same truncated window.
Any trend or comparison. No baseline exists. The first production row is also the first datum.
"This tenant is degraded." A verdict about a tenant is a statement about a rate over a window. See above.
Silence detection — "this tenant has sent nothing in 6 hours." turn_traces records turns that happened; absence of rows is indistinguishable from a clinic that was closed. This needs an expected-volume model that does not exist.
Ranking tenants by health. Same reason as degradation.
Anything about the WhatsApp or voice transport itself — delivery failures after dispatch returns, worker crashes, webhook drops. None of it reaches turn_traces.
What it can say on day one: this turn, for this tenant, at this time, failed in this way — here is its trace. A list of facts, each of which is individually true. That is the whole product, and it is enough.

§3
The rest of Phase 0
P0-1 · HEAD and tree
9cb5316903e0301dd259779d25033030e3731405, branch main. git status --porcelain at session start: M docs/os/clocks.md, nothing else. clocks.md was never opened, never staged, never stashed, and is excluded by explicit pathspec ':!docs/os/clocks.md' from every diff and diffstat in this session.
note state.md's Verified-at is 485bb95 ≠ HEAD, so by CLAUDE.md's rule every line in it is unverified. The delta is one commit touching docs/os/state.md and nothing else (git show --stat 9cb5316: 1 file, +297/−4), and scripts/os-check.js:54 classifies docs/os/ as EXEMPT — which is why os:check reports OK. I treated state.md as a lead, not a source: every claim below is re-derived from code.
P0-2 · The conversations page as it stands
Read at public/admin/conversations.html (123 lines) and conversations.js (204). List of threads across both channels with an in-page detail view that interleaves messages and call-session cards. Three filters — tenant, channel, status — plus Refresh and cursor pagination.

The dead "All tenants" option is confirmed at HEAD. conversations.html:61 still ships <option value="">All tenants</option>; conversations.js:51 executes sel.innerHTML = '' before populating, so it is gone at runtime and the first clinic is selected by default. The brief's description was right and the markup is the stale half.

One edge the S3a note does not cover: if /admin/api/tenants throws, loadTenants() rejects at :44–45 before reaching :51, so the dead option stays in the DOM and the table stays on "Loading…" forever. Cosmetic today, and worth knowing before anything copies this bootstrap.
P0-3 · The trace viewer's contract, re-derived
Byte for byte, from adminRoutes.js:974–1031. Both routes carry requireAuth only; both answer 401 {"error":"Unauthorized"} unauthenticated.

GET /admin/api/traces — 400 {"error":"conversation_id must be a UUID"} · 400 {"error":"tenant_id must be a UUID"} · 400 {"error":"correlation_id must look like <prefix>_<16 hex>"} · 400 {"error":"tenant_id is required; conversation_id and correlation_id narrow within it"} · 400 {"error":"limit must be an integer between 1 and 200"} · 500 {"error":"Failed to list traces"}. Success is a bare array. Shape checks run before the required-tenant check, deliberately, so the three 400s stay reachable.

GET /admin/api/traces/:turn_id — 400 {"error":"turn_id must be a UUID"} · 400 {"error":"tenant_id is required and must be a UUID"} (absent tenant_id fails this, since UUID_RE.test(undefined) is false) · 404 {"error":"Trace not found"} for both "another tenant's" and "does not exist" · 500 {"error":"Failed to fetch trace"}.

Incidents inherits all of it. A page that omits tenant_id gets the 400 and, if it renders errors as empty state, displays "nothing" — which is why traces.js declines to build such a URL at all (listUrl returns null) and surfaces the route's own message instead of a second copy of its validation. Incidents must do the same.
P0-4 · The shell contract and the registries measured, not predicted
I created a probe sixth page and ran the two design tests. Results are in §4. The delta a sixth page must provide:
tests/design/adminNav.test.js — PAGES += 'incidents.html'; and if it is a nav destination, EXPECTED_HREFS += '/admin/incidents.html' and CURRENT += the key. The cross-check at :197–203 holds those two to each other, so they move together or not at all.
tests/design/adminShell.test.js — PAGES += the name; EXPECTED_IDS += a hand-counted value; incidents.js added to the badge-literal scan list at :263 if it emits badge-* literals (it will).
The page itself: the canonical <nav> block byte-identical to the other five modulo aria-current; /portal/fonts/fonts.css and /admin/style.css linked, /admin/shell.css last; no nav rule in any inline <style>; a .page-head with an h1.page-head__title and a p.page-head__sub that is >20 chars, ends in a full stop, and is unique across all six; <a href="/admin/logout">Logout</a> as a GET on an anchor; /admin/app.js loaded.
If Incidents joins the nav, all six <nav> blocks change in one commit. There is no nav component; parity is enforced by comparison.
EXPECTED_IDS is still not derived — re-confirmed by mutation, not by reading the comment. Adding one id to traces.html produced "traces.html has 19 ids, expected 18". A derived count would have stayed green. See M2 in §4.
P0-5 · Seed path
scripts/seed-turn-traces.js carries both guards intact — assertNotProduction() at :93 with no override, and assertLocalHost() on pg's own parsed target at :104–118. Six fixtures at :149–224. Against Incidents' needs:
present failed (fixture 4: {stage:'fetch_parallel', status:500, message:…}, deliberately over the 240-char cap) · aborted (fixture 3: abort_reason:'deadline', aborted_after_commit:false) · a tool-error-on-a-clean-turn (fixture 2) · three ok rows.
absent abort_reason: 'client_gone' · aborted_after_commit: true · any second tenant.
It would have to be extended, and only barely. Two fixtures and a loop over --tenant. --clear is already tenant-scoped (:242), so two invocations are independently undoable. The guards ride along unchanged; the channel: 'test' prohibition at :21–27 stays absolute — a seed row on that channel spends a clinic owner's portal test-turn allowance.

note The default tenant 11111111-… does not exist in the local saas_crm_test database (it holds two leftover probe tenants and 0 turn_traces rows, confirmed by read-only SELECT), so the script dies at :251 with defaults here. Pass --tenant.
P0-6 · Free text
Incidents should surface neither, and does not need to. Every field in the Q6 ladder is a closed set. The list columns — time, tenant, severity, channel, stage, correlation id — are all closed sets or ids. The row's job is to route the operator to the trace viewer, which already owns the disclosure.

If a later session adds an error preview to the list, it inherits the F-A031 treatment without exception: collapsed disclosure, the label naming the hazard, truncation at FREE_TEXT_CAP, escaped, and the CONTENT-CLASS:FREE-TEXT token at the site. traces.js:217–231 is the implementation and it should be shared, not copied.

One inheritance is not optional and is easy to miss: the route is SELECT *, so the free text arrives in the payload regardless of what the page renders. A cross-tenant fan-out multiplies that by the tenant count. Not rendering it is not the same as not fetching it.
P0-7 · Suite
npm test, once: # tests 1207 · # suites 199 · # pass 1206 · # fail 1 · # skipped 0 · duration_ms 514158.7.

I did not capture the failing test's name — I piped to tail -30 and the summary block does not name failures. That is my error and I am not going to dress it up. What I can report instead: two subsequent complete full-suite runs, under os:check, at 1207 / 199 / pass 1207 / fail 0; and tests/crm/extraction.unit.test.js, the documented F-A001 flake, green 3/3 in isolation (3 tests, 0 fail, 873ms / 849ms / 885ms). Consistent with F-A001; not proven to be it. No file was modified.
P0-8 · os:check
Preconditions, measured before starting: C: 9.87 GB free (≥7) · 0 node processes · 0 zyon_* scratch databases on localhost · 0 headless/harness Chrome. Five chrome.exe processes were present and are the operator's own persistent browser — --no-startup-window on the real User Data profile plus crashpad/gpu/network/storage helpers, none headless, none on a temp profile, none spawned by this session. Foreground, alone, nothing else running.

Run 1 — printed os-check OK — state.md matches HEAD. .os-check-last.log 390527 bytes, md5 3eeb4c08729babf31c3363db2ca0fa04, mtime Sep 5 00:21, tail 1207/199/pass 1207/fail 0, duration 458016ms. Its exit code was masked by a pipe — $? after a pipeline is tail's, not npm's.

Run 2, instrumented correctly in PowerShell: LASTEXITCODE=0. .os-check-last.log 390477 bytes, md5 e8d54c75493ca27ce571f0ad22041086, mtime Sep 5 00:31, tail 1207/199/pass 1207/fail 0, duration 452180ms. cmp against run 1: DIFFER — two genuine runs, not one log read twice (the K2 rule).

Prior log for contrast: 391431 bytes, mtime Sep 4 19:19.
P0-9 · Predicted delta per test-block, per commit
Blocks are the unit. Predicted +13 tests / +3 suites across three commits, under the +20 ceiling. Detail in §5.

carry The registry work adds zero blocks — measured, not assumed: with a sixth page in both PAGES arrays the two design files still reported # tests 8 / # suites 2. Both file headers claim this and both are correct.
P0-10 · Instruments and their red-checks
In §6. Three were exercised live this session.
P0-11 · Scoping
In §5.
§4
Mutations: applied, failed, reverted
Every mutation asserts its match count and its byte delta before it writes, or it is not a mutation (F-A030). The applier refuses on a wrong anchor and refuses on a zero byte delta.

M1 · Does a sixth page actually move the registries?
Applied: public/admin/incidents.html, 86 bytes, a stub with no nav and no shell links. git status confirmed ?? public/admin/incidents.html.

Failed: 8 tests · 6 pass · 2 fail — both files, both at the disk-derivation assertion (adminNav.test.js:184, adminShell.test.js:355): "PAGES must be EXACTLY the .html files in public/admin minus the named exclusions." F-A034's closure is live and load-bearing at HEAD.

Then, variant B — 'incidents.html' added to both PAGES arrays (applier reported matches=1, bytes 10576 → 10594 and 20105 → 20123; grep-verified at adminNav.test.js:66 and adminShell.test.js:70). 8 tests · 2 pass · 6 fail, naming exactly six requirements:

incidents.html has no <nav> block                (nav parity)
incidents.html has no <nav> block                (aria-current)
incidents.html must link /admin/shell.css        (stylesheet order)
incidents.html must carry a .page-head row       (header + subtitle)
incidents.html has 0 ids, expected undefined     (EXPECTED_IDS value)
every page needs a pinned id count …             (EXPECTED_IDS key set)
And the number that mattered: # tests 8 / # suites 2, unmoved. A page adds zero blocks.

Reverted: git checkout -- both files, rm the probe. Grep-verified: 0 occurrences of incidents.html in either file, probe absent from disk.

⚠ F-A042 fired live during that revert, and I am reporting it rather than hiding it
git checkout -- under core.autocrlf=true rewrote both files from w/lf to w/crlf — 10576 → 10786 and 20105 → 20478 bytes. I restored the LF bytes explicitly. The files are now byte-identical to the HEAD blob (git cat-file blob HEAD:… | cmp → identical) and git hash-object of each equals its own index entry exactly: 00239f52… and 6aa74e24….

git status --porcelain nevertheless still lists them, because the stat cache now expects the CRLF copy that checkout wrote. git diff --name-only — the content-level view — lists only docs/os/clocks.md, and nothing is staged. I did not run git add to clear the flag (the brief says nothing staged) and I did not re-run checkout to clear it either, because that would change 583 bytes of on-disk content to make a status line look right. The lesson for the next session: revert a mutation from a byte snapshot, never with git checkout. M2 and M3 below use snapshots and neither left a mark.

M2 · Is EXPECTED_IDS derived?
Applied: <span id="probeId"></span> appended after <tbody id="traceRows"> in traces.html. Applier: matches=1, bytes 9523 → 9549 (delta 26). Grep-verified: 1 occurrence; disk id count 18 → 19.

Failed: 5 tests · 4 pass · 1 fail — "traces.html has 19 ids, expected 18." The count is a real hand-pinned literal; a derived one would have followed the page and stayed green. F-A020 re-confirmed by measurement.

Reverted from byte snapshot. md5 back to 560ab18626c897ddbbd59176c7c5434a, cmp vs HEAD blob identical, git status did not flag the file.

M3 · Is the severity red-check aimed at the line that carries the behaviour?
Applied: e.outcome === 'aborted' → 'ABORTED_TYPO' at traces.js:83 — the abort branch itself, not a line near it. Applier: matches=1, bytes 25728 → 25733. Grep-verified at :83.

Failed: 12 tests · 11 pass · 1 fail — tracePage.unit.test.js:77, "reads status off `error` and out of no other column." That is the correctly-aimed guard for the severity derivation, and Incidents inherits it.

Reverted from byte snapshot. md5 back to e9677fc44cd6d54f200abb20c758d11f, cmp vs HEAD blob identical, suite green at 12/12, git status unmarked.

§5
Scoping recommendation
P0-11. Three sessions, in this order. The first is not a page session and must not be skipped.

Commit order and predicted delta
#	Session	Δ tests / suites	Touches
1	The failure predicate. One route change: /admin/api/traces gains a failed_only (or severity) filter applied inside the SQL, before LIMIT; and the cross-tenant question is answered on the server, not by fan-out. Plus the partial index the predicate needs.	+6 / +1	adminRoutes.js · queryService.js · a migration + schema.sql in lockstep · tests/traces/tracesRoutes.test.js
2	The page. incidents.html + incidents.js, UMD-lite, consuming statusOf rather than re-deriving it. Registries. Seed extended by two fixtures and a second tenant.	+7 / +2	public/admin/* · both design registries · seed-turn-traces.js · a new unit test + a contract test
3	Optional, and only if the 48-hour watch asks for it. The capture instrument extended to the new page; the stale page-count prose batch (§7).	+0 / +0	scripts/admin/trace-capture.js · comments only
Total +13 / +3, against the +20 ceiling. The registry work contributes zero blocks (measured, M1). The +6 in session 1 is the predicate's own truth table: filter on, filter off, each severity level reachable, the cross-tenant read scoped, and the deny shape for a malformed filter value.

STOP conditions I would want
Session 1 ships no page. If it starts drawing one, stop — the predicate is the deliverable and it is independently testable against seeded rows.
Session 2 writes no second classifier. If incidents.js contains its own statusOf, stop. Two derivations of one fact is how they drift.
If the predicted delta for session 2 exceeds +10 blocks, the page is doing more than listing. Stop and re-scope.
If any severity level requires a value not in the Q5 table, stop. That is the fabrication boundary.
If the cross-tenant read cannot be made to deny a tenant the operator should not see — but note the operator sees all tenants by design (/admin/api/tenants), so the risk here is not a leak, it is the habit: a cross-tenant read that takes its scope from the row rather than the request is exactly the shape ADMIN-S3a closed. Stop if it reappears.
Where the evidence points somewhere the brief did not anticipate
The brief framed the tenant problem as the thing that "changes everything downstream." It is real, but it is not the binding constraint. The binding constraint is that no route can filter on error. Fix that and the cross-tenant shape falls out of the same query; leave it and a cross-tenant route would still return the wrong rows, just from more tenants. That reordering is the one substantive change I would make to §1's plan.

§6
Instruments and their red-checks
P0-10. Each red-check points at the line that carries the behaviour, and each names a failure that can actually occur.

Instrument	Deliberate wrong state	Real failure it catches
adminNav + adminShell registries
exercised · M1	Add the page file without registering it. (Not: delete a PAGES entry — that was ADMIN-S4's red-check and it stayed green, which is how F-A034 was found.)	A sixth page shipping outside every shell assertion while looking checked. Occurs the moment someone adds a page in a hurry.
EXPECTED_IDS count
exercised · M2	Add one id to the page. Aimed at the page, not at the literal — mutating the literal would only prove the assertion runs.	A handler binding site silently lost in a refactor. This panel drives every page by getElementById.
Severity derivation
exercised · M3	traces.js:83 — the abort branch condition itself. Not :82 (the null guard) and not :86 (the fallthrough): only :83 distinguishes the two non-null envelopes.	An aborted turn ranked as failed, or a failed one ranked as aborted. Both are wrong answers the operator would act on.
Tenant-scope on every URL
to be built	Delete tenant_id from the URL builder and assert it returns null rather than a URL. Aimed at the builder, since the route's refusal is already covered by the contract test.	A page rendering the route's 400 as "no incidents" — a different and untrue answer. Occurs whenever a filter is added carelessly.
The failure predicate (session 1)
to be built	Seed a tenant with limit+1 clean turns newer than one failed turn, then request with the filter on. A predicate applied after LIMIT returns zero rows; one applied inside the WHERE returns the failure.	The exact defect this whole audit exists to prevent. It cannot be caught by any fixture that fits inside one page of results, which is why the fixture must deliberately exceed the limit.
trace-capture.js TREE + CONTENT interlocks
exists, unchanged	Compare a tree against itself — --mode compare must refuse when before.treeId === after.treeId.	A screenshot pair taken against an unchanged tree and read as evidence of a change. Not needed for a Phase 0, and no Chrome was spawned this session.
A guard I would not build
An assertion that the severity ladder has exactly four levels. It restates the implementation, points at no line that carries behaviour, and passes forever — F-A039's shape. The levels are guarded by the fixtures that exercise each one, which is where the behaviour actually lives.

§7
Stale premises
Eleventh consecutive session. Four, with evidence.

1 · In the brief — "Incidents is the conversations page, failure-filtered"
Flagged by the brief itself as untested, and it is false. Zero of five failure classes are expressible on that route, and it does not read the table any of them live in. Evidence: adminRoutes.js:330–399; conversation_events has three writers and all write 'handled'.
2 · In the brief — "Cross-tenant is unreachable without a route change"
Reachable, via fan-out over /admin/api/tenants (adminRoutes.js:162–168, unscoped by design, no rate limiter on GETs). The unreachable thing is failure-filtered, on either route. Same conclusion, different and more useful reason.
3 · In the repo — tracePage.unit.test.js:18 says "ELEVEN test() blocks"; the file has twelve
And docs/os/state.md:193 repeats "consolidating it to eleven." state.md:187's "+12/+4" is the correct figure, and 12+7=19 matches the recorded total. Wrong since birth: git show 088bb95:tests/admin/tracePage.unit.test.js | grep -c "^\s*it(" → 12 at the file's only commit. Two documents say eleven, one says twelve, disk says twelve. This one bites directly: P0-9 tells a session to predict deltas per block, and the file the precedent is documented against mis-states its own block count.
4 · In the repo — the admin page count in prose has already drifted
Eight sites say "four" and one says "five": conversations.html:10, login.html:44, shell.css:16,19,68,85, style.css:7, tenant-detail.html:10, tenant-new.html:11,15, tenants.html:17,24 all say four; only traces.html:10 says five. ADMIN-S4 updated its own copy and no other. A sixth page makes it worse. Per S3c's rule — 37 of 41 citations stale means stamp, never half-chase — this is a stamp, in its own commit, not a fix folded into a page session.
§8
The most dangerous thing I found
Failed turns that trace as clean successes — in scope, and it undermines the page before it is built
Three live paths write a turn_traces row with error: NULL after a turn has failed or been aborted. statusOf ranks every one of them ok, correctly reading a column that is lying to it. An Incidents page filtering on error IS NOT NULL would never show them.

WhatsApp, fetch_parallel. whatsapp/routes.js:185–192 — assembleConversationContext throws. The inner try at :154 has a finally (:277) but no catch, so trace.flush() runs with collector.error still null and the exception continues to :280, which logs "reply pipeline failed — message stored, reply skipped". The log knows. The trace does not.
WhatsApp, persist_outbound. :234–240, the outbound INSERT. Same mechanism, same silence — and worse, because the patient already received the reply that failed to store.
Voice SSE, client disconnect. internalVoice.js:517–521 and :556–562 both return on aborted. The SSE handler never calls setAbort at all — the only two call sites, :300 and :311, are in the unary handler. Its own comment at :362 calls the wiring an "intentional mirror"; this is where the mirror is not one. Every barge-in and hang-up traces as a clean success.
The unary voice path is correct: :306–320 wraps everything and always sets one envelope or the other. That is what makes this a gap rather than a design.

Why it is the most dangerous thing: Incidents is built to be trusted when it is empty. Every other limitation in this audit is a thing the page cannot say; this is a thing it would say wrongly, and confidently, in the exact direction that hides the problem. And it is invisible today because turn_traces has zero rows — it becomes real on genesis day, which is the day the page is first believed.

Filed, not fixed. It is a writer-side change across three call sites in two files, with a red-check per site, and it belongs before the page — arguably before session 1.

A smaller one, recorded for completeness: in the unary voice path an abort that fires after commit and then throws takes the :316–318 branch and lands as failed, not aborted — the same event in two envelopes depending on committed. It is honest either way; it just means an operator counting aborts will undercount.

§9
For the 48-hour live watch
On genesis day Incidents shows every AI turn that recorded a failure or an abort, newest first, with its tenant, its stage and a link to its trace — and, until traffic exists, that list is empty and the empty state is the honest answer. It cannot show rates, trends, degradation, silence, or anything about a message that never became a turn; and until the three error: NULL writer gaps in §8 are closed, an empty list is not proof that nothing failed.

Phase 0 only. No production code and no tests were written. Three mutations were applied, grep-verified, red-checked and reverted; git diff --name-only at report time lists docs/os/clocks.md and nothing else, and nothing is staged. docs/os/clocks.md is founder-owned: it was never opened, never staged, never stashed, and excluded by explicit pathspec from every diff and diffstat run this session. server.js was never started. No Chrome was spawned.