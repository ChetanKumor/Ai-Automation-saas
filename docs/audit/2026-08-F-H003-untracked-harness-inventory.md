# F-H003 — Untracked harness inventory

Filed: 2026-08-26
At commit: `474761b` (the working tree also carries the prior session's
uncommitted `shootD5b.js` fix, `state.md` edits, and
`docs/audit/2026-08-shootd5b-e-flake-filed.md`)
Status: **FILED, NOT ACTED ON.** This session moves, tracks and deletes nothing.

---

## Why this finding exists

A correct diagnosis of the `shootD5b` §E flake — *`waitFor: ready` gates on
`.card`, which on `pricing.html` is the loading skeleton, so the gate is
satisfied before any data exists* — sat unreachable for six sessions. The
mechanism is identical in `shootD2.js`, which has been on disk since
2026-07-29. It was never found by any `git grep`, because **`git grep` searches
only tracked files and `shootD2.js` is not tracked.**

The file is not untracked by accident. It was placed inside a gitignored
directory on purpose, and its own header says so
(`scripts/portal/shots/shootD2.js:4-7`):

    * D2 screenshot evidence — dev tooling, NOT shipped runtime, NOT committed.
    * Lives under scripts/portal/shots/ because that directory is gitignored
    * (.gitignore:163), which keeps D2's "every changed path under public/portal/"
    * acceptance criterion true without juggling an untracked file at the root.

So a per-session acceptance criterion — *"every changed path under
`public/portal/`"* — was satisfied by **hiding a file from git** rather than by
changing fewer files. The criterion passed; the repository lost a harness. That
is the finding.

---

## a. `.gitignore:163` — confirmed

Lines 162–163, verbatim:

    # Portal screenshot evidence (regenerate via scripts/portal/shoot.js)
    scripts/portal/shots/

- `git check-ignore -v scripts/portal/shots/` →
  `.gitignore:163:scripts/portal/shots/` (tab) `scripts/portal/shots/`
- `git check-ignore -q scripts/portal/shots/shootD2.js` → exit **0** (ignored)
- `git ls-files scripts/portal/shots/` → **0 rows**

**Confirmed.** Nothing in that directory is tracked, by construction. The defect
is not the rule; it is what was put behind it.

---

## b. Full inventory of `scripts/portal/shots/`

201 files. **Zero tracked.**

| Kind | Count | Tracked | Harness or artifact | Asserts product behaviour? |
|---|---|---|---|---|
| `shootD2.js` | 1 | no | **HARNESS** (516 lines) | **No** — see below |
| `*.png` | 200 | no | output artifact | no |

### The one harness: `shootD2.js`

- **516 lines.** Header at `scripts/portal/shots/shootD2.js:1-18`.
- Self-contained, and built on the same scaffolding as the nine tracked shoots:
  mints a scratch database (`:197-204`), runs `runner.genesis` (`:209`),
  repoints `process.env.DATABASE_URL` at it (`:211`), spawns Chrome over CDP,
  and drops the scratch DB in a `finally` (`:512-514`).
- Stubs the Gemini SDK offline at `:22-38` (a fixed `STUB_VEC`), so it spends no
  quota.
- Seeds three tenants — Sunrise Dental (draft, checks failing), Ready Dental
  (checks passing), Wizard Clinic — at `:224`, `:275`, `:312`.

**Does it assert anything about product behaviour? No.** It is a pure capture
script. Its twelve `[page, selector]` pairs at `:182-193` are *readiness gates*
fed to `waitFor`, not assertions — there is no expected-value comparison
anywhere in the file. The contrast with its tracked siblings is stark:
`shootD5b.js` carries **74** `['label', expr, expected]` assertion triples;
`shootD2.js` carries **0**. Its only nonzero exits are an unhandled throw
(`:516`) and a missing `DATABASE_URL` (`:50`).

This matters for disposition: losing `shootD2.js` would have lost a
*reproduction recipe*, not a test. Nothing regressed silently because it was
untracked.

**But** `:185-193` is the vacuous-gate bug verbatim —
`document.querySelector('.content .card')` on `pricing.html`, `doctors.html`,
`booking-rules.html`, `faqs.html`, `receptionist.html`, `safety.html`,
`knows.html`, `test.html` and `history.html`. **Nine sites.** Had this file been
tracked, the enumeration in `docs/audit/2026-08-shootd5b-e-flake-filed.md` would
have had nine more rows, and the pattern would have been visible as a *pattern*
rather than as one flake in one file.

### The 200 PNGs

Output artifacts, grouped by filename prefix:

| Prefix | Count | Producer |
|---|---|---|
| `d2-` | 42 | `shots/shootD2.js` (untracked) |
| `d5b-` | 34 | `scripts/portal/shootD5b.js` |
| `d3-` | 33 | `scripts/portal/shootD3.js` |
| `d5a-` | 14 | `scripts/portal/shootD5a.js` |
| `s3-` … `s18-` | 51 | `scripts/portal/shoot.js`, per-session phases |
| `d4-` | 9 | `scripts/portal/shootD4.js` |
| `wizard-` | 7 | `scripts/portal/shootWizard.js` |
| `f1-`, `f3-` | 7 | `scripts/portal/f1.js`, `scripts/portal/f3.js` |
| `login-`, `home-` | 4 | `scripts/portal/shoot.js` |

None assert anything; they are images. They are correctly ignored and should
stay ignored.

---

## c. Other untracked `.js` — repository-wide

Search: `git ls-files --others --ignored --exclude-standard -- '*.js'` **and**
`git ls-files --others --exclude-standard -- '*.js'` — i.e. both ignored and
merely-untracked, over the whole repository, not limited to `scripts/`.

### Ignored-and-untracked `.js`, excluding `node_modules`

| Path | Verdict |
|---|---|
| `scripts/portal/shots/shootD2.js` | **The finding.** See §b. |
| `.venv/Lib/site-packages/pip/_vendor/urllib3/contrib/emscripten/emscripten_fetch_worker.js` | vendored Python dependency — not ours |
| `voice-agent/.venv/Lib/site-packages/urllib3/contrib/emscripten/emscripten_fetch_worker.js` | vendored Python dependency — not ours |
| `web/.next/**` (10 directories) | Next.js build output — correctly ignored |

**`scripts/portal/shots/shootD2.js` is the only non-vendor, non-build harness
hidden inside an ignored directory anywhere in the repository.** The pattern is
not systemic; it happened once.

### Untracked but NOT ignored: `scratchpad/`

`scratchpad/` holds roughly 60 `.js` files across about 20 subdirectories —
session probes, CDP shooters, patch generators. Every one is untracked.

**`scratchpad/` is not gitignored.** This was not what I expected and is worth
recording:

    $ git check-ignore -q scratchpad/_probe.js ; echo $?
    1                      # 1 = NOT ignored
    $ git status --porcelain -- scratchpad/_probe.js
    ?? scratchpad/_probe.js

`git status` reports `?? scratchpad/`, and `??` means *untracked*, not
*ignored*. Only files inside it that match an unrelated rule are ignored —
`*.log` at `.gitignore:12`, which is why `git status --ignored=matching` shows
`!! scratchpad/baseline-suite.log`.

One caveat for whoever re-checks this: `git check-ignore -v scratchpad/` **does**
exit 0, printing `.gitignore:164:` with an **empty pattern**, where line 164 is a
blank line. That is an artefact of the trailing slash, not a real match. The
file-level probe above is the authoritative one.

So the standing convention *"`scratchpad/` never committed"* is enforced by
**nothing but discipline**. A `git add -A` commits the whole directory. This is
the same class of defect as F-H003 with the sign flipped: there, a harness was
hidden by an ignore rule that existed; here, working files are exposed by an
ignore rule that does not.

### Also found: a merge-conflict marker committed into `.gitignore`

`.gitignore:156` is:

    >>>>>>> 1a7b8f062315057373a66493f1d7fd96cc85c01b

`git blame` attributes it to `3b438e2` — *"Merge remote .gitignore and local
files"*. The matching `<<<<<<<` and `=======` markers are absent; only the
trailing marker survived. The referenced object exists (`git cat-file -t` →
`commit`).

Harmless in effect — as a gitignore pattern it matches a file literally named
`>>>>>>> 1a7b8f06…`, which will never exist — but it is an unresolved merge
committed into the one file whose job is to be read carefully, and it sits two
lines above the blank-line/CRLF oddity described above.

Not in scope to fix this session. Recorded so the next reader of `.gitignore`
does not have to re-derive it.

---

## d. Recommended disposition — RECOMMENDATION ONLY, NOT APPLIED

| Path | Recommendation | Reason |
|---|---|---|
| `scripts/portal/shots/shootD2.js` | **TRACK** — move to `scripts/portal/shootD2.js`, commit | It is a harness, and all nine of its siblings are tracked at exactly that path. It carries nine more instances of the vacuous-`.card`-gate bug, which is evidence the repository should hold. Its stated reason for hiding — satisfying a *"every changed path under `public/portal/`"* criterion — expired with that session. |
| `scripts/portal/shots/*.png` (200) | **LEAVE IGNORED** | Regenerable output. `.gitignore:163`'s own comment already says so. |
| `.venv/**`, `voice-agent/.venv/**`, `web/.next/**` | **LEAVE IGNORED** | Vendored dependencies and build output. |
| `scratchpad/**` | **ADD `scratchpad/` TO `.gitignore`** | Makes the standing convention structural instead of conventional. Nothing is currently tracked from there, so no file moves and no history is touched. |
| `.gitignore:156` conflict marker | **DELETE the line** | Unresolved merge residue. Inert, but it is noise in the file that governs what the repository can see. |

### One process recommendation

An acceptance criterion of the form *"every changed path under `<dir>`"* is
satisfiable by hiding a file, and that is what happened here. The criterion
should either exempt dev tooling explicitly, or be checked against
`git status --porcelain --ignored`, which would have surfaced
`shots/shootD2.js` the day it was written.

---

## Cross-references

- `docs/audit/2026-08-shootd5b-e-flake-filed.md` — the §E flake whose
  six-session delay this file explains. Its `waitFor: ready` enumeration covers
  `shootD4`, `shootD5a` and `shootD5b`; `shots/shootD2.js:182-193` belongs in it
  if that file is ever tracked.
- `docs/os/state.md`, *Known open risks* — `shootD5a.js:589`, the same vacuous
  gate, reproduced and deliberately left unfixed.
