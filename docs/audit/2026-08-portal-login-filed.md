# Filed at the portal-login diagnosis — found, not fixed

Two items found while diagnosing "I created portal credentials and cannot sign
in" (2026-08-07). Neither is fixed here: the session's scope was diagnosis plus
`scripts/seed-portal-owner.js`, and both of these sit in surfaces that were
explicitly out of scope (portal UI; the admin panel's owner data).

The **root cause** of that session's failure is not filed here because it was
fixed: the dev database was one migration behind (`027_password_changed_at.sql`
pending), so login raised `42703` and returned 500 for every account.
`npm run db:migrate` cleared it. What is filed below is why that took a
diagnosis session instead of a glance.

**Second session, 2026-08-08 (HEAD `4bf1283`).** `LOGIN-F3` and `LOGIN-F4` below
were added while diagnosing a *different* failure wearing the same symptom:
portal login returning 401 for `owner@clinic.com`. That session's root cause is
again not filed here, because it is again data rather than code — `users` held
**two** active rows with that email, on two different tenants, so
`routes.js:118`'s `rows.length === 1` rule failed closed exactly as designed and
the password was never compared. What is filed is, once more, why seeing that
took a session. `LOGIN-F1` gained an addendum correcting a mis-statement about
its scope.

---

## LOGIN-F1 — the login page reports a server fault as a wrong password

**Severity:** low user impact, high diagnostic cost. It is why the root cause
above was invisible.

**What happens.** `public/portal/login.html:130-136`:

```js
if (res.status === 429) {
  showError('Too many sign-in attempts. Wait a few minutes, then try again.');
} else {
  showError('That email and password don’t match. Check them and try again.');
}
```

The `else` is reached by **every** non-`ok`, non-429 response. A 500 therefore
renders as a credentials error. The comment above it assumes the only other
outcome is the route's deliberate generic 401 ("Server returns a single generic
401 (no account-existence oracle)"), which is true of the route's *intended*
paths and false of its failure path — `src/portal/routes.js:119-122` returns
`500 {"error":"Login failed"}` when the lookup throws.

**Measured, 2026-08-07**, against a dev database missing `password_changed_at`:

| request | HTTP | what the owner was told |
|---|---|---|
| real email, any password | **500** | "That email and password don't match." |
| unknown email | **500** | "That email and password don't match." |
| empty password (short-circuits at `routes.js:107`, before the query) | 401 | same |

Every password was correct. Nothing the owner could type would have worked, and
nothing on screen said so.

**Why it matters beyond this incident.** The three states an owner can be in —
wrong credentials, rate-limited, backend broken — collapse to two messages. The
429 case is handled well and proves the pattern is affordable. A misconfigured
`DATABASE_URL`, a pending migration, or a dead database are all indistinguishable
from a typo, on the one screen an owner sees before they can reach any other
surface.

**The fix is small and deliberately not taken here.** A third branch on
`res.status >= 500` saying the service is having trouble rather than blaming the
credentials. It must not leak *why* — the generic-401 discipline exists to deny
an account-existence oracle, and a 500 branch does not weaken it, because a 500
is not conditioned on whether the account exists (both rows in the table above
returned it).

**Not filed as a security issue.** The 500 body is already generic
(`{"error":"Login failed"}`) and carries no detail; the real error goes to the
server log only (`logger.error({ err: err.message }, 'portal login lookup
failed')`). This is a diagnosability defect, not a disclosure one.

**Addendum, 2026-08-08 — the boundary, because it was mis-stated once already.**
F1 is about **HTTP-level** failures, not transport ones. A `fetch()` that never
receives a response — process down, port closed, connection refused, DNS failure
— **rejects**, and `public/portal/login.html:120-124` catches exactly that and
shows its own distinct, honest message: *"Can't reach the server. Check your
connection and try again."* That branch is correct, and conflating it with this
finding is wrong: an unreachable server does **not** render as bad credentials.

What F1 covers is the narrower case where the server **did** answer and the
answer was neither `ok` nor 429 — every 5xx, plus any 403/404/502 a proxy might
inject — all of which fall through `:132-136` and blame the credentials.

The usable diagnostic, worth stating because a later session will want it:
**"Can't reach the server" is a reliable signal that the process is down or
unreachable. "That email and password don't match" proves the server answered**
— but says nothing about whether that answer was a real 401 or a 500. Of the
three states an owner can be in, only the transport failure is honestly
reported; the other two remain collapsed.

---

## LOGIN-F2 — `My Clinic` has four active owner accounts, which closes its reset route

**Severity:** dev-data only at this commit. Zero production tenants.

**State on the dev database (Neon), 2026-08-07:**

| tenant | active owners |
|---|---|
| `c933c478-83d8-4199-93fb-6c23ca1bdabb` — My Clinic | **4** (`owner@test.com`, `owner@gmail.com`, `owner@example.com`, `clinic@example.com`) |
| `11111111-1111-1111-1111-111111111111` — Smile Dental (Voice Dev) | 1 |
| `03c6bf8c…` — Sunrise Dental Care | 0 |
| `41b9d2e7…` — Dr.Sharma Dental Clinic | 0 |

**Consequence.** `findTenantOwner` (`src/admin/adminRoutes.js:854-862`) returns
`{ count: 4, owner: null }`, so both F3-R1 routes refuse that tenant: the reset
(`:940-944`) answers 409 *"This clinic has 4 active owner accounts. Reset is
refused rather than guess which one"*, and the verification card reports
`owner_count: 4` with a null email. The refusal is **correct** — it is exactly
the "hand a working password to the wrong person" failure F3-R1 bought out of —
but it means there is no operator path back into that tenant.

Portal **login** is unaffected: it matches on `lower(email)` across all tenants
and each of the four addresses is distinct, so `rows.length === 1` holds for each.

**Why nothing was changed.** Deactivating three rows is a data mutation on the
founder's dev database, outside the session's scope, and the founder ruled
file-only. `scripts/seed-portal-owner.js` refuses to *add* a fifth without
`--allow-second-owner`, so the state cannot deepen by accident.

**How it probably arose, and the real gap.** Four owner rows on one tenant is
what repeated attempts at the admin create card look like when sign-in is
failing for an unrelated reason — the operator assumes the account is wrong and
makes another. The create route has no
"this tenant already has an owner" warning; it only rejects a duplicate
*email* on that tenant (`:810-815`). A second owner on a tenant that already has
one is a strictly worse state than the 409 it avoids, and nothing says so at the
point of creation. Worth a guard on that card if the pattern recurs.

**Addendum, 2026-08-08 — the pattern recurred, and this time it broke login.**
`My Clinic` now holds **five** active owner accounts, not four: a row for
`owner@clinic.com` was added at `2026-08-07T16:16:37Z` (`last_login_at` null, so
never used). The paragraph above predicted the mechanism exactly — another
attempt made while sign-in was failing for an unrelated reason.

The new row is materially worse than the previous four, because
`owner@clinic.com` **already existed on a different tenant**, Smile Dental (Voice
Dev) `11111111-1111-1111-1111-111111111111`, which is the address actually in use
(`last_login_at 2026-08-07T13:11:59Z`). `users` is `UNIQUE (tenant_id, email)`
only, so the duplicate is perfectly legal — and portal login matches on
`lower(email)` **across all tenants** (`routes.js:114-116`, the one deliberately
tenant-agnostic lookup). Two rows therefore came back, `routes.js:118`'s
`rows.length === 1` failed closed, `user` stayed null, and every attempt returned
the generic 401 **without the password ever being compared** — `verifyPassword`
ran against `DECOY_HASH` at `:126`, as designed. The sentence in F2 above that
"portal login is unaffected … each of the four addresses is distinct" was true
when written and is what stopped being true.

**Neither creation path guards this.** `scripts/seed-portal-owner.js:183-198`
(guard 4) scopes its check to one tenant — `WHERE tenant_id = $1 AND role =
'owner' AND active = true AND lower(email) <> $2` — so it detects a *differently
named* second owner on the same tenant and is blind to the *same* address on
another tenant. `POST /admin/api/tenants/:id/owner` (`adminRoutes.js:810-815`)
rejects only a duplicate email **on that tenant**. So the one collision that
breaks login for both accounts is the one neither writer looks for. Filed
separately as **LOGIN-F5**, because it is a product defect rather than a
property of this dev database.

---

## LOGIN-F3 — nothing logs on the way out, so a completed request and a hung one are identical in the log

**Severity:** no runtime impact, high diagnostic cost, and it grows with
production. It is what sent the 2026-08-08 session hunting a server that was
dying mid-request, which it never was.

**What happens.** `server.js:13-18` logs every request on the way *in*:

```js
logger.info({ requestId: req.id, method: req.method, path: req.url }, 'incoming request');
```

Nothing logs on the way out. There is no `res.on('finish')` handler, no
`pino-http`, no status or response-time logging anywhere in `src/`. Verified by
grep rather than assumed: the only `res.on('close')` hits in the tree are
`src/routes/internalVoice.js:134` and `:339`, and both are voice-turn *abort*
handlers, not completion logs.

**The consequence.** A request that completed and a request that hung produce
byte-identical output: one `incoming request` line, and nothing else, ever.
Measured 2026-08-08 against a healthy server at HEAD — a `POST
/portal/api/login` that returned `401 {"error":"Invalid credentials"}` in
1058 ms emitted exactly one line:

```json
{"level":30,"time":1786128733560,"pid":2584,"requestId":"09ba91a4-9fb8-469f-8615-6805380d0c0b","method":"POST","path":"/portal/api/login","msg":"incoming request"}
```

So three `incoming request` lines with no completion after them — the observation
that opened that session — is exactly what three **successful** 401s look like.
The log could not distinguish it from three hangs, and the founder reasonably
read it as the latter.

**The partial exceptions make it worse, not better.** Some failure paths *do*
log: `src/portal/routes.js:120` (`portal login lookup failed`, the 500 branch),
`src/portal/auth.js:147`, `server.js:100` for `/health`. So the log is
informative about some faults and silent about every success, which makes the
absence of a second line genuinely ambiguous rather than uniformly meaningless.
It does carry one real signal, recorded here because that session used it: the
absence of `portal login lookup failed` after an `incoming request` for
`/portal/api/login` **rules out** the 42703 → 500 path that caused the previous
incident.

**Operational cost in production.** From logs alone there is no way to answer:
did this request finish, how long did it take, what status did the caller
receive. A latency regression, a route that has started returning 500s, a
request blocked on a saturated pg pool, and a client that disconnected mid-flight
are all equally invisible. Launch gate 7 is *"one call traceable end-to-end"*;
`turn_traces` (Issue 22) covers the AI turn, but the HTTP envelope around it has
an open bracket and no close. The first production incident that is not an
outright crash gets debugged without any of this.

**The fix is small and deliberately not taken here.** One `res.on('finish')` in
the existing middleware at `server.js:13-18`, carrying `requestId`, `statusCode`
and elapsed ms. No dependency needed. The one design point worth a moment:
`finish` fires on a completed response and `close` fires on a client disconnect
as well — logging **both, distinguished**, is what would make a hang visible;
logging only `finish` leaves the abandoned-request case exactly as silent as it
is today.

---

## LOGIN-F4 — the dev server can wedge before `app.listen`, alive with zero sockets

**Severity:** dev environment only. Filed as **strongly-fitting, not proven** —
the process exited before it could be autopsied directly, so the mechanism below
is inference from a complete set of observations plus a control, not a
demonstration.

**Observed 2026-08-08 at HEAD `4bf1283`.** `npm run dev` started 21:46:06;
nodemon spawned `node server.js` as PID 22308 at 21:46:19. Nine minutes later
that process was:

- **alive** — present in the process table, `Responding: True`, 13 threads
- **holding zero TCP sockets** — nothing `LISTENING` on 3000, *and no outbound
  connection to Neon either*. `netstat -ano` filtered on the PID returned no
  rows; `Get-NetTCPConnection -OwningProcess 22308` found none.
- **not executing** — CPU frozen at exactly `2.6875 s` across samples 1.5 s
  apart: blocked, not spinning
- **refusing connections** — a raw `TcpClient` to `127.0.0.1:3000` got
  `WSAECONNREFUSED`

Zero sockets *including the database connection* places the block **before
`server.js:123`** (`app.listen`). A frozen CPU counter places it in a
synchronous wait rather than an event-loop stall.

**The control.** The same `server.js`, same commit, same `.env`, launched with
**stdout and stderr redirected to files** instead of inheriting a console,
reached `{"msg":"server started","host":"0.0.0.0","port":"3000"}` in about 0.5 s
and bound the port, with an empty stderr. The boot path, the 24-variable `.env`,
`SESSION_SECRET` and the pool config are therefore all healthy; the one variable
that changed was the destination of fd 1.

**The hypothesis.** A blocked write to an interactive Windows console —
QuickEdit/mark mode, where a click in the terminal suspends the writing process
at its next `WriteFile` against the console handle. It accounts for every
observation above, and independently for the founder's report that multi-line
paste into that same prompt was silently swallowing commands: the same console
in the same state. It fits the timing too, since `server.js` writes to stdout
early and repeatedly — dotenv's banner from `:1`, then logger lines including
`voice channel enabled` at `:41` (reached because `VOICE_ENABLED=true`) — all of
it before `app.listen` at `:123`.

**Ruled out, recorded so nobody re-derives them.** Not pino `thread-stream`
back-pressure: **`pino-pretty` is not installed**, so `src/infra/logging/logger.js:20-27`'s
`require.resolve` throws, `opts.transport` is never set, and pino writes straight
to fd 1 with no worker thread in the picture. Not a port conflict — nothing else
held 3000. Not a boot crash — the process was alive and the control run's stderr
was empty. Not env or schema — `db:status` reported `Pending (0)` and the control
run booted clean.

**Why it is filed and not fixed.** There is nothing in `src/` to fix: the
application booted correctly every time it was given a non-console stdout. The
workaround is the useful part — **redirect the dev server's output to a file**
when diagnosing, which both avoids the wedge and leaves a scrollback that can be
grepped.

**The trap it sets, which is the reason to file it at all.** A wedged process
looks *running* by every check anyone is likely to make: it is in the process
list, nodemon reports no crash, and the terminal still shows the last line it
managed to print. Only the socket table shows the truth. **The cheap check is
whether anything is `LISTENING` on the port — not whether node is in the process
list.**

---

## LOGIN-F5 — neither writer guards a cross-tenant email collision, and it is silent at write time

**Severity:** **product defect**, not dev-environment noise. Zero production
tenants at this commit, so today's blast radius is a dev database — but nothing
about the mechanism is dev-specific, and the first time it fires in production it
locks out an owner who did nothing wrong.

**What is unguarded.** Portal login is the one deliberately tenant-agnostic
lookup: `src/portal/routes.js:114-116` matches `WHERE lower(email) = $1 AND
active = true` across **all** tenants, and `:118` admits a user only when
`rows.length === 1`. The uniqueness login depends on is therefore **global on
`lower(email)`**. Neither write path enforces it:

- `scripts/seed-portal-owner.js:183-198` (guard 4) checks `WHERE tenant_id = $1
  AND role = 'owner' AND active = true AND lower(email) <> $2` — one tenant, and
  it is looking for a *differently named* second owner. The same address on
  another tenant is invisible to it.
- `src/admin/adminRoutes.js:810-815` checks `WHERE tenant_id = $1 AND
  lower(email) = $2` and refuses with *"An account with this email already exists
  for this clinic."* — again one tenant. Its `23505` backstop at `:829-831` is the
  `UNIQUE (tenant_id, email)` index, which is per-tenant too.

The schema agrees with the writers and disagrees with login: `users` is `UNIQUE
(tenant_id, email)` only. A second row carrying the same address on a different
tenant is legal at every layer that could refuse it, and fatal at the only layer
that reads it.

**It breaks BOTH accounts, which is the sharp part.** The collision is symmetric.
The owner who already existed and was signing in fine is locked out by a write to
a *different* tenant — one they cannot see, did not request, and are never told
about. The new owner is locked out as well. Both receive the generic 401, and per
LOGIN-F1 the login page tells both of them their credentials are wrong. Nothing
on any surface says the word "duplicate".

**Silent at write time.** The creating operator sees success: `201` plus a
one-time temp password from the admin card, or `✓ Portal owner created` from the
CLI. The failure surfaces later, on someone else's machine, as a 401 against a
password that is correct. Measured 2026-08-08 — the row created at `16:16:37Z`
reported success, and the owner it broke had signed in successfully at
`13:11:59Z` the same day. Full trace in the LOGIN-F2 addendum above.

**Why this is a product defect.** Two clinics whose owners share an email address
is ordinary, not exotic:

- a husband-and-wife practice running two registered clinics off one address
- a small chain using a single `admin@` or `owner@` address across branches
- an agency, accountant or practice manager onboarding several clinics under
  their own address

In each case, onboarding the **second** clinic silently breaks the **first** — at
exactly the moment a new customer is being set up, which is both the worst
possible time and the moment an operator is least likely to suspect an account
created earlier on an unrelated tenant. The wedge is Hyderabad-area dental
clinics (`docs/os/state.md`), which makes the chain and practice-manager cases
likely rather than hypothetical.

**Forward-looking note, deliberately not a fix.** This is availability, not
isolation: login fails **closed**, no cross-tenant data is exposed, and INV-1
holds throughout. Both write paths are operator-only today (admin panel behind
`ADMIN_PASSWORD`, or a dev CLI), so it is not reachable by an untrusted party.
**If self-serve signup is ever built, this becomes a trivial lockout vector** —
register a victim's address against a tenant of your own and they can never sign
in again. Whoever builds signup should read this entry first.

**The natural fix shape.** Check global uniqueness on `lower(email)` at both
write paths — `SELECT 1 FROM users WHERE lower(email) = $1 AND active = true`,
with no `tenant_id` predicate — and reject with an operator-facing error that
names the real problem rather than restating the same-tenant one, e.g. *"This
email is already in use by another clinic. Portal sign-in matches on email across
all clinics, so creating this account would stop both from signing in."* The
admin card's existing same-tenant 409 copy stays as it is; this is a second,
differently-worded refusal, not a replacement. A database-level `UNIQUE
(lower(email))` would be stronger and would close the race that two concurrent
creates still leave open — but it is a migration on a column that currently
permits duplicates, so it cannot be written until the question below is answered.

**Open question, deliberately unanswered here: existing collisions need a cleanup
path.** A check at the write paths stops *new* collisions and does nothing about
rows already in the table — and a `UNIQUE` index cannot be created at all while
one duplicate remains. Someone has to decide which row wins, whether the loser is
deactivated (what this session did by hand, on one row, from a scratch script) or
renamed, who gets told, and whether any of it gets an operator surface or stays a
manual database job. Note also that **no surface on either the admin panel or the
portal lists user accounts**, so an operator cannot currently *find* a collision
without querying the database directly. That is part of the same fix, not a
separate one.

---

## Not filed: the stale-database trap itself

`docs/os/state.md` already records this class three times (`025` at B2, `026` at
F1-R1, `026` again before B2-R1) with the durable fix named and unbuilt: *"the
test bootstrap to refuse to run when `TEST_DATABASE_URL` has pending migrations."*
2026-08-07 is the **fourth** occurrence and the first on `DATABASE_URL` rather
than the test database, which is materially worse — the suite cannot see it.
Every suite that needs a new column mints a genesis scratch DB from `schema.sql`,
so the suite reported 989/989 green while portal login was returning 500 for
every account on the dev database.

`scripts/seed-portal-owner.js` now refuses to run with pending migrations
(mirroring `scripts/provision-tenant.js:79-86`), which covers the seeding path
only. Nothing on the **login** path, the **server boot** path, or the **test
bootstrap** checks.
