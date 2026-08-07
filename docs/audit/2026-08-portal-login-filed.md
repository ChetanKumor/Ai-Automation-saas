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
