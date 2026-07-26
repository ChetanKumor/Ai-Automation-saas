# Frontend Surfaces — Stage 1 Audit

Session: Stage 1, findings only. No implementation.
Date: 2026-07-26
HEAD at audit: `f2601c79d0146dd08064a3178b2e2b561dca8257`
Authorised by: **D-005** (`docs/os/decisions.md`)

---

## Phase 0 — STOP conditions

All six checked and reported. **One condition is literally true and operatively
false**; the reasoning is set out under condition 1. The session proceeded.

| # | Condition | Verdict |
|---|---|---|
| 1 | `state.md` `Verified-at` != HEAD | **Literally TRUE, operatively CLEAR** — see below |
| 2 | `decisions.md` contains no `D-005` | **CLEAR** — present, with a caveat |
| 3 | `npm test` not `# fail 0` | **CLEAR** — 830 tests / 142 suites / 0 fail |
| 4 | An inventory surface resolves to a missing path | **CLEAR** — all resolve; two corrections filed |
| 5 | `public/**` build step, or a framework in root `package.json` | **CLEAR** |
| 6 | "AI Employee" / "AI Operating System" in a surface | **CLEAR** — one hit outside the surfaces |

### 1 — Provenance: literal divergence, operative match

- `git rev-parse HEAD` → `f2601c79d0146dd08064a3178b2e2b561dca8257`
- `docs/os/state.md:5` `Verified-at:` → `f560c184923cc06e56a6fbf53fa33a1e87d2ee30`

These differ, so the condition as written is true. `npm run os:check` nonetheless
reports:

```
running the suite...
os-check OK — state.md matches HEAD.
```

The divergence is benign, and the tool is right to say so. Three reasons:

1. **The literal condition is unsatisfiable by construction.** `scripts/os-check.js:5-6`
   states it: *"A commit cannot record its own sha, so `Verified-at` always names an
   ancestor."* A commit that updates `state.md` cannot contain its own hash. Read
   literally, STOP-1 halts every session in this repository forever, including the one
   that would fix it. That cannot be the intent, so the operative test must be the one
   the repo actually implements.
2. **The implemented rule is narrower and is satisfied.** `scripts/os-check.js:26-35`
   holds a verification valid while nothing outside `docs/os/` has changed since.
   `git diff --name-only f560c18..f2601c7` returns `docs/os/assumptions.md` and
   `docs/os/state.md` only. Nothing in `src/`, `tests/`, `public/`, `web/` or
   `package.json` moved.
3. **`state.md` at HEAD is fresher than at `Verified-at`, not staler.** The intervening
   commit `f2601c7` is itself a `state.md` correction ("the sequence runs to 34, not
   28"). Halting here would discard a correction in the name of staleness.

The premises this audit draws from `state.md` — the frozen stack, the 830-test
baseline, the gate table — are therefore treated as verified. **The only defect is that
`f2601c7` edited `state.md` without refreshing its own `Verified-at` line**, which
CLAUDE.md requires. Not this session's file to fix, and recorded here so it is not lost.

### 2 — D-005 present, but uncommitted

`D-005 — Frontend modernisation program before any paying customer` is present at
`docs/os/decisions.md:53-67`, dated 2026-07-26, budget 10 sessions, `public/admin/**`
excluded. The override is in force and this session is authorised.

**Caveat worth stating:** D-005 exists only in the working tree. `git status` shows
`M docs/os/decisions.md`, and `git diff` confirms the entire D-005 block is unstaged.
The authorising decision for a ten-session program is currently one `git checkout` from
non-existence. Recommend committing it before Stage 2.

### 3 — Test suite

```
# tests 830
# suites 142
# pass 830
# fail 0
# duration_ms 198541.1046
```

Exactly matches `state.md:60`. Green.

> Process note: the first run of `npm test` and `npm run os:check` were launched
> concurrently and both hit the same local Postgres. That is a contamination risk, so
> both were killed and re-run serially. The figures above are from a clean solo run.

### 4 — Surface inventory

All four surfaces resolve. Two corrections to the inventory as given:

| ID | Given | Actual | Note |
|---|---|---|---|
| S-A | `web/` | `web/` | Confirmed |
| S-D | under `public/` (confirm) | `public/demo/` | Confirmed — 3 pages |
| S-B | under `public/` (confirm) | `public/portal/` | Confirmed — 14 pages |
| S-C | `public/admin/` | `public/admin/` | Confirmed — 10 pages |

No unlisted surface exists under `public/`. `find public -maxdepth 2 -type d` returns
exactly `public/{admin,demo,demo/fonts,portal,portal/fonts}`.

### 5 — `public/**` build-step check

Clear on both halves.

- No build artifact under `public/`: zero files matching `.min.`, `.map`, `bundle`,
  `chunk`, `dist/`, `build/` in `git ls-files public/`.
- Root `package.json` dependencies: `@google/generative-ai`, `axios`, `dotenv`,
  `express`, `express-session`, `node-cron`, `pg`, `pino`, `zod`. Dev: `nodemon`.
  No framework, no bundler. Scripts are `test`, `start`, `dev`, `db:*`, `os:check` —
  none builds anything.
- Zero external asset references in `public/`: no `fonts.googleapis`, no `fonts.gstatic`,
  no CDN. Every byte is served from origin.

§2 is intact. As the session prompt's revision note anticipated, the Next app inside
`web/` is not a breach — see the dating evidence under "When `web/` was introduced".

### 6 — Positioning strings

`git grep -i -E "AI Employee|AI Operating System"` over `web/` and `public/` returns
**nothing**. No surface carries a retired framing.

Two hits exist elsewhere in the repo, neither a surface, so neither triggers STOP-6:

- `README.md:141` — "Build the AI Operating System for businesses."
- `.claude/agents/backend-engineer.md:13` — "channel-independent AI employee"

Both are internal documents. Recorded in the S5 appendix; `README.md` is the one a
visitor to the repository would read first.

---

## Phase 0 report — required contents

### Directory trees

**S-A · `web/`** (git-tracked; `.next/`, `node_modules/`, `next-env.d.ts`,
`*.tsbuildinfo` are gitignored)

```
web/
├── app/
│   ├── (legal)/          acceptable-use, data-deletion, privacy, terms + layout.tsx + legal.module.css
│   ├── (marketing)/      layout.tsx, page.tsx
│   ├── globals.css  layout.tsx  robots.ts  sitemap.ts
├── components/
│   ├── sections/         10 sections × (.tsx + .module.css), + HeroChat.tsx, faqData.ts
│   ├── ui/               Button, Eyebrow (each .tsx + .module.css), Reveal.tsx
│   ├── Footer.tsx  Footer.module.css  Nav.tsx  Nav.module.css
├── lib/                  siteConfig.ts, useScrollReveal.ts
├── public/               favicon.ico, favicon.svg, apple-touch-icon.png, og-image.png
└── next.config.js  package.json  package-lock.json  tsconfig.json  vercel.json  README.md
```

**S-B/S-C/S-D · `public/`**

```
public/
├── admin/    10 .html, 3 .js, 1 .css
├── demo/     3 .html, 3 .js, 5 .css, 3 .json, fonts/ (1 .css + 6 .woff2)
└── portal/   14 .html, 15 .js, 15 .css, fonts/ (1 .css + 6 .woff2)
```

### File count by extension

| Surface | Files |
|---|---|
| S-A `web/` | 24 `.tsx`, 16 `.css`, 5 `.ts`, 4 `.json`, 2 `.png`, 1 each `.svg .md .js .ico` |
| S-D `public/demo/` | 3 `.html`, 3 `.js`, 5 `.css`, 3 `.json`, 6 `.woff2` |
| S-B `public/portal/` | 14 `.html`, 15 `.js`, 15 `.css`, 6 `.woff2` |
| S-C `public/admin/` | 10 `.html`, 3 `.js`, 1 `.css` |

### Total CSS bytes

| Surface | Bytes | Largest single file |
|---|---|---|
| S-B `public/portal/` | **86,677** | `tokens.css` 21,070 |
| S-A `web/` | **50,659** | `(legal)/legal.module.css` 8,027 |
| S-D `public/demo/` | **26,315** | `styles.css` 10,366 |
| S-C `public/admin/` | **3,997** | `style.css` 3,997 |
| **All surfaces** | **167,648** | |

### Stylesheets linked, and what is shared

| Surface | Sources | Shared with |
|---|---|---|
| S-A | `app/globals.css` (global) + 15 `*.module.css` (scoped) | nothing |
| S-B | `fonts/fonts.css` + `tokens.css` on **all 14 pages**, then one page CSS | `fonts.css` byte-identical to S-D's |
| S-D | `fonts/fonts.css` on all 3; `shared.css` on 2 of 3; `styles.css` on `index.html` only | `fonts.css` byte-identical to S-B's |
| S-C | `style.css` only, all 10 pages | nothing |

Two things stand out. `public/portal/tokens.css` is a genuine single shared token
stylesheet, loaded by every portal page — §2's requirement, met. The demo is the
exception: `index.html` loads `styles.css` while `dashboard.html` and `inbox.html` load
`shared.css`, and the two files redeclare the same tokens independently.

`diff public/demo/fonts/fonts.css public/portal/fonts/fonts.css` → **identical**. The
six `.woff2` files are duplicated byte-for-byte across the two directories.

### `web/` specifics

**Framework and version.** Next.js `^15.3.4`, React `^19.1.0`, React-DOM `^19.1.0`.
TypeScript `^5.8.0` (dev). App Router — `web/app/` with route groups `(marketing)` and
`(legal)`.

**Styling approach.** **CSS Modules**, one `.module.css` per component, over a global
`app/globals.css` that carries the whole custom-property scale. No Tailwind, no
styled-components, no CSS-in-JS, no UI library. The only runtime dependencies are
`next`, `react`, `react-dom` — there is no third-party component or styling package to
swap out. Notably clean.

**Own lockfile.** Yes — `web/package-lock.json`, 31,889 bytes, tracked. `web/` is a
fully independent npm project nested inside the repo, with its own `node_modules/`.

**Does root `npm test` execute anything in `web/`?** **No. Plainly: zero.**
`npm test` is `node --test --require ./tests/_support/testEnv.js tests/**/*.test.js`.
`git grep -l "web/" -- tests/` returns nothing; `git grep -lE "\.tsx|next/|from 'react'" -- tests/`
returns nothing. Across 25 test directories, none targets the marketing site. The
highest-priority surface has **no automated coverage of any kind** — not a render test,
not a type-check in CI, not a lint gate. `web/package.json` defines a `lint` script;
nothing invokes it.

**When `web/` was introduced.**

```
git log --diff-filter=A -- web/package.json
34db490  2026-06-26  Add design reference assets
```

**2026-06-26 — three weeks BEFORE `portal-v1-spec.md` (2026-07-17).** The Next app
predates the spec that S-A was suspected of violating. This settles the question the
session prompt raised: no post-spec architecture decision was made without a
`decisions.md` entry, and the revision note's reading is correct on the dating as well
as the text. §2's static constraint was written while `web/` already existed, and scoped
itself to `express.static('public')` regardless.

Only three commits have ever touched `web/`: `34db490` (2026-06-26, introduction),
`2ec6a02` (2026-06-28, redesign), `c8b1b9e` (2026-07-24, Prantivo repositioning).

**Does any deploy config build or serve `web/`?** **Nothing in the repository does.**

- No `railway.json`, no `Dockerfile`, no `Procfile`, no `.github/` workflow — `git ls-files`
  matches none of them.
- `server.js:90` is `app.use(express.static(path.join(__dirname, 'public')))`. `public/`
  only. Express never serves `web/`.
- `git grep -n "/web/" -- src/ server.js scripts/` returns nothing. No backend code
  references the directory.
- The sole deploy-adjacent file is `web/vercel.json`, and it configures **security
  headers only** — no build command, no output directory. It implies Vercel by
  convention, and nothing else.

So `web/` is built and hosted, if at all, by a process with no representation in this
repository. Amendment text for `state.md` is proposed at the end of this document, as
the definition of done requires. It is filed as **F-F004** below, because an
architecture decision that exists only in a founder's Vercel dashboard is exactly what
S1's "unlogged architecture decision" clause is for.

---

## Findings

**9 numbered findings.** The cap is 25 and I did not approach it. That is a real result,
not a filtered one: `public/portal/` and `public/demo/` are carefully built, and most of
what a generic audit would flag is either already handled or explicitly documented in
the code. Two checks I expected to produce findings — C-3 copy compliance and C-4 fixed
widths — came back essentially clean, and I have said so rather than manufacturing
severity. The S5 appendix holds 9 further items that did not earn a number.

**Ranking note.** F-F001 is ranked first by explicit instruction. The general rule
(severity, then S-A/S-D above S-B) would otherwise place the three S-A S1 findings above
it, since F-F001 is S-B. Every other finding follows the rule.

---

### F-F001 · S1 · The portal reports success for edits that are silently inert

```
Surface:            S-B
Location:           src/modules/ai/aiService.js:466-467, :400-405
                    public/portal/shell.js:109
                    src/modules/validation/validationService.js:293-299
                    public/admin/tenant-detail.html:104  (the remedy's reference)
Current behaviour:  Carried in per the session prompt; see
                    docs/specs/issue-34-legacy-prompt-shadows-portal-config.md.
                    On a tenant with non-null tenants.ai_prompt, the renderer never
                    runs and every portal-written string is inert. The owner is shown
                    "Saved · v{N}" and a new config version.
Problem:            A success state that lies, on the one surface whose entire job is
                    to tell the owner what their receptionist knows.
User impact:        A clinic owner edits hours, pricing, greeting or escalation copy,
                    is told it saved, and the receptionist keeps using the old prompt.
                    They discover it from a patient, if at all.
Engineering impact: Carried in.
Severity:           S1 — "states something false".
Confidence:         high
Recommendation:     Carried in as a portal-side warning surface. See below for the
                    precise frontend site, which this session located.
Effort:             4h
```

**What this session adds — the exact remedy site.** Not a re-derivation; the seeded
finding named the backend cause and the operator's three warnings, and said the remedy
is portal-side. This is where portal-side is:

`public/portal/shell.js:109` maps the validation check to owner-facing copy:

```js
'tenant.legacy_prompt': { label: 'Using the latest instruction format', actor: 'system', material: false },
```

Two independent mechanisms suppress it, and a third inverts it:

1. `validationService.js:296` returns **`warn(...)`**, not `fail(...)`, when the legacy
   prompt is set. `shell.js:157` and `shell.js:161` both count only
   `c.severity === 'fail'`. A `warn` can never register as a blocker.
2. `material: false` excludes the check from the readiness ring outright —
   `shell.js:75` documents `material: true` as the flag that "counts toward the
   readiness ring and gates go-live".
3. The label is **affirmative and unconditional**. On precisely the tenants where the
   check is warning that the renderer is dormant, the owner-facing string asserts
   "Using the latest instruction format". Were the suppression lifted tomorrow, the
   copy would still state the opposite of the finding.

So "owner warned zero ways" is not an omission — it is three deliberate frontend
decisions stacked. That is good news for the fix: the remedy is entirely within
`public/portal/`, needs no backend change, and the surface already contains the pattern
to copy (see Preserve As-Is, the `receptionist.html:99` gap notice).

---

### F-F002 · S1 · Placeholder domain, entity and contact ship in the rendered marketing site

```
Surface:            S-A
Location:           web/lib/siteConfig.ts:2, :4, :12, :13, :15
                    consumed at web/app/layout.tsx:23, :70, :71, :72, :75, :79
                    web/app/robots.ts:10
                    web/app/sitemap.ts:7, :12, :17, :22, :27
Current behaviour:  siteConfig.siteUrl is the literal string "https://yourdomain.com".
                    legalEntityName is "[REGISTERED ENTITY NAME]". contactEmail is
                    "support@yourdomain.com". Social URLs are "x.com/yourhandle" and
                    "linkedin.com/company/yourcompany".
                    Verified in built output, not inferred — web/.next/server/app/index.html
                    contains:
                      <meta property="og:url" content="https://yourdomain.com"/>
                      <meta property="og:image" content="https://yourdomain.com/og-image.png"/>
Problem:            The site states a domain, a legal entity, a support address and two
                    social accounts that do not exist.
User impact:        A prospect who shares the link in WhatsApp gets no preview card —
                    the OG image resolves against yourdomain.com and 404s. That is the
                    exact sharing path a Hyderabad clinic referral travels.
Engineering impact: siteUrl feeds metadataBase, so it contaminates every canonical URL,
                    both OG image URLs, all five sitemap entries and the robots.txt
                    sitemap pointer from a single constant. One-line fix, five-file
                    blast radius. web/README.md:101 and :118 already list these as
                    pre-launch steps; the checklist exists and was not run.
Severity:           S1 — "states something false", and blocks launch gate 2: Meta app
                    review requires a reachable privacy-policy URL on a real domain.
Confidence:         high — read the source and the build artifact.
Recommendation:     web/ — replace the five literals in lib/siteConfig.ts. No component
                    change. Then add a build-time assertion: a module-scope throw when
                    siteUrl includes "yourdomain.com" and NODE_ENV is production, so
                    next build fails loudly rather than shipping placeholders again.
Effort:             1h (0.5h values, 0.5h the guard)
```

---

### F-F003 · S1 · Four legal pages render 24 bracketed placeholders to any visitor

```
Surface:            S-A
Location:           web/app/(legal)/privacy/page.tsx      — 10 spans (:47, :48, :92, :94,
                                                             :96, :235, :286, :318, :320, :322)
                    web/app/(legal)/terms/page.tsx        — 7 spans  (:47, :48, :86, :258,
                                                             :266, :267, :268)
                    web/app/(legal)/data-deletion/page.tsx — 5 spans (:47, :69, :112, :129)
                    web/app/(legal)/acceptable-use/page.tsx — 2 spans (:47, :160)
                    styled by web/app/(legal)/legal.module.css:319-326
Current behaviour:  Each page renders literal [DATE], [REGISTERED ENTITY NAME],
                    [REGISTERED ADDRESS], [GRIEVANCE OFFICER NAME], [CITY],
                    [privacy@yourdomain.com], [legal@yourdomain.com],
                    [abuse@yourdomain.com]. The .ph class renders them in accent
                    colour on an accent-glow background — highlighted, not hidden.
                    All four pages are linked from the Footer on every page
                    (Footer.tsx:41-44) and from the Trust panel (Trust.tsx:129-137).
Problem:            The public legal documents are unfilled templates.
User impact:        A clinic owner doing diligence clicks "Privacy Policy" and reads a
                    policy with the company's own name blanked out. For a trust-based
                    Indian clinic sale — the founder's own stated distribution risk —
                    this is worse than having no legal page. Trust.tsx:120-122 promises
                    "Request an export or full deletion at any time" and links to a
                    page that gives [privacy@yourdomain.com] as the address to write to.
Engineering impact: The DPDP grievance-officer block (privacy/page.tsx:318-322) is a
                    statutory disclosure carrying three placeholders.
Severity:           S1 — "states something false", and blocks launch gate 2: WhatsApp
                    Business Platform review requires a valid privacy policy and data
                    deletion URL.
Confidence:         high
Recommendation:     web/ — the four page.tsx files. Route the repeated values through
                    lib/siteConfig.ts rather than fixing 24 sites by hand, so the next
                    address change is one edit. Needs founder input for the entity
                    name, registered address, city and grievance officer; that is a
                    content dependency, not an engineering one, and should be requested
                    before the Stage 2 session that executes this.
Effort:             3h engineering, plus founder-supplied values
```

---

### F-F004 · S1 · `web/` is absent from the recorded stack and from every deploy path

```
Surface:            S-A
Location:           docs/os/state.md:104-121 (stack, no web/ entry, no Vercel)
                    web/vercel.json  (headers only — no build or output config)
                    server.js:90  (express.static serves public/ only)
                    absent: railway.json, Dockerfile, Procfile, .github/
Current behaviour:  The company's only prospect-facing surface is built and hosted by a
                    process with zero repository representation. state.md's frozen
                    stack names Railway, Neon, Plivo, Sarvam, Gemini — and no web host.
                    Nothing in the repo builds, serves, tests or lints web/.
Problem:            An architecture decision — the marketing site is a separately
                    deployed Next app on a second host — was made and never logged.
User impact:        Indirect but real: nobody can answer "where does the site deploy
                    from, and what happens if that account lapses" from the repository.
                    A DNS or Vercel change is unreproducible and unreviewable.
Engineering impact: Issue 20's scope is incomplete — its checklist covers the Express
                    app and public/**, and silently omits the surface a prospect sees
                    first. Combined with the zero test coverage noted in Phase 0, web/
                    can break at any commit with nothing to catch it.
Severity:           S1 — "reveals an unlogged architecture decision".
Confidence:         high
Recommendation:     Documentation, not code. Amend state.md per the text proposed at
                    the end of this document, and append a decisions.md entry recording
                    the split-host choice with a falsifiable prediction. Separately,
                    Issue 20 should gain a line item for the web/ deploy.
                    Do NOT resolve this by moving web/ into the Express app — that is a
                    migration, which D-005 and the session constraints both forbid.
Effort:             1h documentation. Founder must confirm the actual host.
```

---

### F-F005 · S2 · The vernacular product's marketing site renders no vernacular script, and could not

```
Surface:            S-A
Location:           web/app/layout.tsx:6-16  (Geist + Geist_Mono, subsets: ["latin"])
                    web/components/sections/HeroChat.tsx:7-12  (6 messages, all English)
                    claim made at web/components/sections/Hero.tsx:34-36
                    and web/lib/siteConfig.ts:7
Current behaviour:  git grep -P "[\x{0C00}-\x{0C7F}]" -- web/ returns nothing. The same
                    for Devanagari, except the rasterised og-image.png. Zero Telugu and
                    zero Hindi across 24 .tsx files. The hero WhatsApp mockup — the
                    largest element above the fold — plays a six-message booking
                    conversation entirely in English, on a page whose subhead reads
                    "in Telugu, Hindi, and English".
                    Both next/font/google calls declare subsets: ["latin"] only.
Problem:            The site asserts vernacular capability and demonstrates none, and
                    the font configuration means adding a Telugu line would render
                    tofu rather than Telugu.
User impact:        The differentiator against every generic chatbot is Telugu. A
                    Hyderabad clinic owner sees an English demo and has to take the
                    Telugu claim on faith — the one claim the product could prove
                    instantly and for free. The demo surface proves it
                    (public/demo/app.js:105); the marketing site does not.
Engineering impact: The trap is the second half. Whoever adds Telugu copy will see it
                    fail in a way that looks like a content bug, because
                    subsets: ["latin"] silently excludes the glyphs regardless of
                    family support. Geist has no Telugu coverage at all, so the fix is
                    a second family, not a subset flag.
Severity:           S2 — a prospect sees it and it costs credibility.
Confidence:         high on the source facts. The visual claim that a Telugu hero
                    "reads well" needs a render — noted in Cannot Be Audited.
Recommendation:     web/ — layout.tsx adds Noto_Sans_Telugu from next/font/google with
                    subsets: ["telugu"] and display: "swap" (never "optional"), exposed
                    as --font-telugu; globals.css gains a --font-te var; HeroChat.tsx
                    carries the inbound messages in Telugu with lang="te" on those
                    bubbles, mirroring public/demo/app.js:105. Keep the agent replies
                    bilingual so an English-reading prospect can still follow.
                    display: "swap" is already correct on both existing faces — keep it.
Effort:             5h (2h font wiring, 2h bilingual copy, 1h layout at the longer
                    Telugu string lengths)
```

---

### F-F006 · S2 · The mobile nav menu stays open after a link is tapped

```
Surface:            S-A
Location:           web/components/Nav.tsx:79-88  (the <a> elements carry no onClick)
                    web/components/Nav.module.css:101-113  (.open { display: flex })
                    menuOpen state at Nav.tsx:18, toggled only at Nav.tsx:61
Current behaviour:  Tapping a nav link navigates to its in-page anchor. menuOpen is
                    never set false, so the drawer — a full-width panel with a 0.95-alpha
                    background and a 14px backdrop blur — stays open over the section
                    the user just jumped to. The only way to close it is to find and tap
                    the hamburger again. There is also no Escape handler and no
                    close-on-outside-tap.
Problem:            The primary navigation on mobile obscures its own destination.
User impact:        Every mobile visitor who uses the menu, on a site whose audience
                    browses from an Indian phone. They tap "Pricing", the page scrolls,
                    and pricing is behind a blurred panel. It reads as broken.
Engineering impact: Three lines. The state and the handler already exist.
Severity:           S2 — a prospect sees it and it costs credibility.
Confidence:         high — the handler is demonstrably absent; no render needed to
                    know that display:flex persists when nothing clears the state.
Recommendation:     web/ — Nav.tsx only. onClick={() => setMenuOpen(false)} on the
                    mobile links at :83-87; a keydown listener clearing on Escape.
                    No CSS change.
Effort:             1h including the Escape handler
```

---

### F-F007 · S2 · Collapsed FAQ answers stay in the accessibility tree and in-page find

```
Surface:            S-A
Location:           web/components/sections/Faq.module.css:96-109
                    web/components/sections/Faq.tsx:83-89, aria at :66-67
Current behaviour:  Collapse is grid-template-rows: 0fr on .faqAWrap with
                    overflow: hidden on .faqAInner. The answer text is never
                    display:none, never visibility:hidden, and carries no hidden
                    attribute. aria-expanded is correctly false and aria-controls
                    correctly targets the panel, but the panel content remains exposed.
Problem:            Content that is visually collapsed is still announced, still
                    searchable, and — if an answer ever contains a link — still
                    tabbable while invisible.
User impact:        A screen-reader user hears every answer read out regardless of
                    which are open, so the accordion communicates no structure to them.
                    Any visitor using Ctrl+F gets matches that scroll to blank space.
Engineering impact: The 0fr/1fr grid technique is the right animation choice and should
                    stay; it just needs the panel marked inert when closed. FAQ_ITEMS
                    answers are plain strings today (faqData.ts), so nothing is
                    currently tabbable — this is latent, and becomes live the first time
                    an answer gains a link.
Severity:           S2 — a prospect sees it and it costs credibility. Held at S2 rather
                    than S1 because nothing false is stated.
Confidence:         high on the DOM facts; the screen-reader behaviour follows from them
                    but has not been verified against an actual reader — see Cannot Be
                    Audited.
Recommendation:     web/ — Faq.tsx and Faq.module.css. Add inert={!isOpen} to the
                    .faqAWrap div (React 19 supports the inert prop natively, so no new
                    dependency) and pair it with visibility: hidden on the collapsed
                    state, transitioning visibility alongside grid-template-rows so the
                    animation survives.
Effort:             2h including a keyboard pass
```

---

### F-F008 · S2 · The marketing site and the owner portal use different brand accents

```
Surface:            S-A / S-B
Location:           web/app/globals.css:24      --accent: #5C8DF0   (periwinkle blue)
                    public/portal/tokens.css:35 --accent: var(--teal) → #0f766e (teal)
                    public/portal/tokens.css:30 --teal: #0f766e
                    public/demo/shared.css:15   --teal: #0f766e
                    web/app/globals.css:8       --ink-900: #0B0C0E  (near-black ground)
                    public/portal/tokens.css:19 --bg: #f6f8fa       (near-white ground)
Current behaviour:  The two surfaces a customer meets in sequence — marketing site,
                    then the portal they are handed at onboarding — share no brand
                    value. Blue accent on near-black, then teal accent on near-white.
                    --accent is one of only three token names in the whole codebase
                    that resolve to different values in different files, and it is the
                    one that carries brand identity.
Problem:            There is no single source of truth for the brand, so the product
                    does not look like one product.
User impact:        A clinic owner signs up from a dark blue-accented site and logs in
                    to a light teal-accented tool. Nothing breaks; it just reads as two
                    vendors. For a first-ten-clinics trust sale — the exact thing D-005
                    is funding — that is the credibility cost the program exists to buy
                    down.
Engineering impact: Quantified in "The token question" below: 26 token names defined in
                    more than one file, 46 duplicate definitions, 3 divergences.
Severity:           S2 — a prospect sees it and it costs credibility. Cited against S-A
                    because that is the higher-priority surface; the remedy touches both.
Confidence:         high on the values. Whether the divergence reads as "two vendors" or
                    as "marketing site and app" is a judgement a render would sharpen.
Recommendation:     Decide the brand accent first — that is a founder call, not an
                    engineering one, and the audit should not pre-empt it. Then apply
                    via the shared values file proposed in the token question. Changing
                    web/'s accent is one line in globals.css because every component
                    already reads var(--accent); changing the portal's is one line in
                    tokens.css for the same reason. The architecture is already right;
                    only the values disagree.
Effort:             2h to apply once the decision exists. Excludes the decision.
```

---

### F-F009 · S2 · Four focus indicators are colour-only

```
Surface:            S-A
Location:           web/components/Nav.module.css:130-133      .mobileMenu a
                    web/components/Footer.module.css:113-116   .fcol a
                    web/app/(legal)/legal.module.css:388-391   .legalLinks a
                    web/app/(legal)/legal.module.css:162-166   .toc a  (colour + border-color)
Current behaviour:  14 rules in web/ set outline: none on :focus-visible. Ten replace it
                    with a visible ring — box-shadow: 0 0 0 2px var(--ink-900),
                    0 0 0 4px var(--accent) or 0 0 0 3px var(--accent-glow). Four do not:
                    three change only color, the fourth adds border-color.
Problem:            On those four, keyboard focus is signalled by a hue change alone.
User impact:        A keyboard user tabbing the footer or the legal-page table of
                    contents cannot reliably tell where focus is; for a red-green or
                    low-vision visitor on the near-black ground, not at all. The legal
                    ToC is a navigation control, so focus loss there means losing your
                    place in the document.
Engineering impact: Trivial and mechanical — the correct pattern already exists ten
                    times in the same files. This is drift, not a design position.
Severity:           S2 — a prospect sees it and it costs credibility. Reported as one
                    finding per surface per C-4. public/** has no equivalent defect:
                    tokens.css:406 and login.html:26 both remove the outline but replace
                    it with a 3px teal ring, which is a legitimate substitution.
Confidence:         high on the CSS. Whether the ring is perceptible against every
                    background needs a render — see Cannot Be Audited.
Recommendation:     web/ — style files only, no .tsx. Apply the existing
                    box-shadow: 0 0 0 2px var(--ink-900), 0 0 0 4px var(--accent) pattern
                    at the four sites, keeping the colour change as a secondary cue.
Effort:             1h
```

---

## Four named checks

### C-1 · Script coverage and tofu risk

**`public/**` (S-B, S-D): correct, and the best-built thing in the repository.**

`public/demo/fonts/fonts.css` and `public/portal/fonts/fonts.css` are byte-identical and
declare six faces — Noto Sans Telugu 400/600/700 and Noto Sans Devanagari 400/600/700.
Every face is:

- **self-hosted** (`src: url('./noto-telugu-400.woff2')`), same-origin, zero CDN
  dependency — confirmed by a repo-wide grep finding no `fonts.googleapis`, no
  `fonts.gstatic`, no CDN reference anywhere in `public/`;
- **`unicode-range`-scoped** — Telugu at `U+0C00-0C7F` plus the shared marks
  `U+0951-0952, U+0964-0965, U+1CDA, U+1CF2, U+200C-200D, U+25CC`; Devanagari at
  `U+0900-097F` plus `U+1CD0-1CF9, U+20A8, U+20B9, U+20F0, U+A830-A839, U+A8E0-A8FF,
  U+11B00-11B09`. The ZWNJ/ZWJ pair and the dotted-circle at `U+25CC` are both present,
  which is what keeps conjunct rendering and orphaned-matra display correct;
- **`font-display: swap`** on all six — never `optional`, so a slow connection delays
  the glyph rather than dropping the face.

Fallback resolution: `--te: 'Noto Sans Telugu', system-ui, sans-serif`. If the woff2
fails, this lands on `system-ui`, which on Windows has no Telugu coverage and would
produce tofu. Same-origin static assets make that failure unlikely, and there is no
better vanilla fallback available. Correct as built.

Declared in three places — `public/demo/shared.css:35-36`, `public/demo/styles.css:29-30`,
`public/portal/tokens.css:74-75` — with identical values. `shared.css` defines `--te`
even though `dashboard.html` and `inbox.html` do not currently use it, so a future
Telugu string on either page renders correctly rather than tofu. That is the right
default.

`public/demo/app.js:105` emits `<div class="turn__te" lang="te">`. The `lang` attribute
is set on the Telugu content — correct for both screen readers and font selection.

**S-A (`web/`): the failure mode is already present, in its quietest form.**

`web/app/layout.tsx:6-16` loads Geist and Geist_Mono with `subsets: ["latin"]`. Neither
`telugu` nor `devanagari` is declared, so those glyphs would never load. `display` is
`"swap"` on both — correct, and the `display: 'optional'` failure mode the prompt asked
about is **not** present.

But the subset question is currently moot, because **`web/` renders no Telugu or
Devanagari at all**. That is F-F005. The two facts compound: the site does not
demonstrate the vernacular claim, and the font configuration would silently defeat the
first attempt to fix that. Geist carries no Telugu coverage, so adding `subsets: ["telugu"]`
is not the fix — a second family is.

### C-2 · Default-aesthetic check

**S-A — sits inside the near-black cluster, with a hue that is not the tell.**

`web/app/globals.css:6-57` is a dark scale: ground `--ink-900: #0B0C0E`, surfaces
`#121317 / #181A1F / #202329`, hairline borders at `rgba(255,255,255,0.08)` and `0.14`,
text `#F5F6F7 / #A2A6AD / #6C6F77`. A **single** functional accent, `--accent: #5C8DF0`,
with the comment "links / focus / live dot only". Radius `4 / 8 / 12 / 999px`. Two
elevation shadows, both pure black at 0.45 alpha.

Against the three named clusters: the ground and the one-accent discipline are squarely
cluster two — near-black plus a single accent, hairline borders, restrained radius.
The accent hue is not: `#5C8DF0` is a periwinkle blue, neither acid-green nor vermilion.
The type is a geometric sans (Geist), not a high-contrast serif, so cluster one does not
apply; there are no hairline rules over dense columns, so cluster three does not either.

The honest read: **structurally in the default near-black cluster, distinguishable by
hue and by restraint.** The one-accent rule is enforced, which is more discipline than
the default look usually carries. The WhatsApp palette at `globals.css:28-36` is
explicitly fenced as "MOCKUP ONLY" and correctly reproduces Meta's real colours —
that is authenticity, not a default. I am recording this as evidence, not filing it as
a finding: nothing here is a defect, and D-005's budget should not be spent on a hue
change absent a reason.

**S-D — outside all three clusters.**

`public/demo/shared.css:7-37` and `styles.css:5-31` are a light UI palette: ground
`#eef2f6`, cards `#ffffff`, ink `#0f172a`, teal accent `#0f766e`, plus green/amber
reserved for state. Radius `14px / 10px`, two soft shadows at 0.04–0.06 alpha on a
slate-tinted rgba. `--wa-bubble: #d9fdd3` is WhatsApp's real outbound green. This reads
as a working clinic tool, which is what a demo in the room should read as. No cluster
match, no finding.

The one substantive C-2 observation is not a cluster at all — it is that S-A and S-D/S-B
share no brand values whatsoever. Filed as F-F008.

### C-3 · Copy compliance against `portal-v1-spec.md` §1

Audited against the spec's own binding rule. **This check came back substantially
clean, and I found no numbered finding in it.**

**Action-name consistency — passes.** Every save path runs
`Save changes` → `Saving…` → `Saved`. Verified across all ten writing pages:
`clinic-profile.js:177,192,194`, `hours.js:214,229,231`, `pricing.js:282,297,299`,
`booking-rules.js:155,174,176`, `safety.js:183,199,201`, `receptionist.js:189,203,205`,
`doctors.js:243,244,246,263,265,266`, `faqs.js:103,177,180,192`, `wizard.js:149`.
**"Submitted" does not appear anywhere in `public/portal/`.** The specific failure C-3
names is absent.

**Controls named for owner intent — passes.** `shell.js:85-109` maps every system check
name to owner-facing copy: `config.exists` → "Clinic details saved", `kb.retrieval` →
"Knowledge is searchable", `numbers.e164` → "Escalation phone number added",
`turn.scripted` → "Test call". The mechanism name never reaches the owner. The one
exception is the label at `shell.js:109`, which is not a naming problem but a truth
problem — F-F001.

**Errors — passes, contrary to first appearance.** `'Something went wrong. Try again.'`
appears identically in ten files, which looks like the vague-error antipattern. Reading
the call sites refutes it. `hours.js:221-224` is representative:

```js
if (res.status === 401) { window.location.replace('login.html'); return; }
const data = await res.json().catch(() => ({}));
if (res.status === 400 && Array.isArray(data.fields)) { applyErrors(data.fields); return; }
if (!res.ok) { toast(data.error || 'Something went wrong. Try again.', false); return; }
```

Session expiry redirects rather than showing a dead-end message. Validation failures are
applied to the named fields — and `tokens.css:412-425` styles a per-field
`.field__error` whose comment reads "Errors name the fix (§4)". The generic string is
only the last-resort fallback after the server's own `data.error`, reached on 5xx and
network failure, where "Try again" is in fact the correct advice. This is correctly
layered and I withdrew the finding I had drafted against it.

**Empty states — not fully assessable from source.** Ten empty-state hooks exist
(`doctors.js:385,419`, `faqs.js:266,301`, `history.js:251,256`, `hours.js:166`,
`pricing.js:199`, `test.js:26,68`), and the `emptyAdd` naming suggests the
invite-an-action pattern C-3 asks for rather than a bare description of emptiness. The
one literal string visible is `test.js:68` `'No saved config yet'`, which describes
emptiness without inviting the fix. A single instance, and the surrounding markup may
supply the action. Logged in the appendix rather than numbered.

### C-4 · Quality floor

| Check | S-A `web/` | S-B `public/portal/` | S-D `public/demo/` | S-C `public/admin/` |
|---|---|---|---|---|
| Focus outline removed without replacement | **4 sites** → F-F009 | none (2 removals, both replaced) | none | not assessed (excluded) |
| `prefers-reduced-motion` present | yes, global `*` block | yes, narrow | yes, narrow | absent (excluded) |
| Fixed width unable to reflow < 380px | **none** | **none** | **none** | **none** |
| `<meta viewport>` | n/a (Next) | 14/14 | 3/3 | 10/10 |
| Viewport via Metadata API | **present, verified** | n/a | n/a | n/a |
| Raw `<img>` where `next/image` applies | **none — zero `<img>` in `web/`** | n/a | n/a | n/a |
| `'use client'` on components not needing it | 5 files, 4 justified | n/a | n/a | n/a |

**Viewport on `web/` — verified, not assumed.** `web/app/layout.tsx:18-20` exports a
`Viewport` object setting only `themeColor`, with no `width` or `initialScale`. Rather
than reason about whether Next supplies its default when the export is partially
specified, I read the build output. `web/.next/server/app/index.html` contains:

```html
<meta name="viewport" content="width=device-width, initial-scale=1"/>
```

Next 15 emits its default and the partial export does not suppress it. **No finding.**
(The `.next/` directory is gitignored, so this is a local build artifact; `siteConfig.ts`
and `layout.tsx` are unchanged since `c8b1b9e`, so it reflects HEAD.)

**Fixed widths — clean across all four surfaces.** A grep for `width:` or `min-width:`
at ≥380px, excluding `max-width`, returns **zero hits** in both `public/` and `web/`.
Layout constraints are expressed as `max-width` (`.wrap` at 1180px,
`--content-max: 760px`) or as `clamp()` (`globals.css:98-101`). `--sidebar-w: 232px` is
the only fixed dimension and is well under the threshold. `public/demo/shared.css:42`
carries `html, body { max-width: 100%; overflow-x: hidden }`. Nothing to file.

**Viewport meta on `public/**` — 27 of 27 pages.** All ten admin, all three demo and all
fourteen portal pages declare it. Demo and portal use
`width=device-width, initial-scale=1, viewport-fit=cover`; admin uses
`width=device-width, initial-scale=1.0`. No page is missing it.

**`prefers-reduced-motion` — present everywhere it is needed, narrow in `public/**`.**
`web/app/globals.css:117-134` is a proper global block: `scroll-behavior: auto` plus
`animation-duration/transition-duration: 0.01ms !important` on `*`, and it neutralises
the `.reveal-hidden` transform so scroll-reveal content is not left invisible. Six
component modules add their own. Correct and thorough.

`public/**` blocks are narrower: `portal/tokens.css:287-289` silences only
`.badge--ok .badge__dot`, and `demo/shared.css:110-112` only `.live__dot`. Each silences
the one *animation* on its surface while leaving *transitions* running. The practical
impact is small — the demo declares one transition across three stylesheets
(`styles.css` 0, `dashboard.css` 0, `inbox.css` 1) — so a user requesting reduced motion
gets essentially what they asked for. Appendix, not a finding.

**`'use client'` — 5 files, 4 clearly justified.** `Nav.tsx` (scroll listener + menu
state), `HeroChat.tsx` (IntersectionObserver-driven animation), `Reveal.tsx` and
`useScrollReveal.ts` (IntersectionObserver) all require client JS. `Faq.tsx` is the one
candidate: its accordion is `useState` over a `Set`, which native
`<details>`/`<summary>` would deliver with zero JavaScript. Against that, the current
implementation drives `aria-expanded`/`aria-controls` correctly and animates with the
`0fr`/`1fr` grid technique, both of which are harder with `<details>`. A genuine
trade-off rather than a defect — appendix.

---

## Preserve As-Is

Cited to the same standard as the findings. These are load-bearing and should not be
touched by any Stage 2 session.

1. **The self-hosted vernacular font pipeline.** `public/{demo,portal}/fonts/fonts.css`
   — six faces, `unicode-range`-scoped, `font-display: swap`, zero external requests.
   Generated by a script and marked "Do not edit by hand". This is the single highest-
   consequence rendering detail in the product and it is correct. Do not migrate it to
   a CDN, do not merge the two copies in a way that reintroduces a build step.

2. **`lang="te"` on Telugu content.** `public/demo/app.js:105`. Copy this pattern when
   fixing F-F005 rather than inventing another.

3. **`public/portal/tokens.css` as a real shared stylesheet.** 21,070 bytes, 43 custom
   properties, loaded by all 14 portal pages. §2's "one shared tokens stylesheet"
   requirement is genuinely met, not nominally.

4. **The honest gap notice.** `public/portal/receptionist.html:99`:
   *"These settings are saved to your account, but Prantivo hasn't finished connecting
   them to live phone calls yet — your calls keep using the current voice until that's
   done. We'll let you know when it's active."*
   This is the product telling an owner the truth about an unfinished seam, in their
   language, without jargon. **It is also the exact template F-F001's remedy needs** —
   the pattern already exists on the surface that needs it. Preserve the copy and reuse
   the component.

5. **The save-state discipline.** `Save changes` → `Saving…` → `Saved` across all ten
   writing pages, with the server's returned value refilled into the form
   (`hours.js:227` `fill(data.section)`) so the owner sees what was actually persisted
   rather than what they typed. Better than the spec requires.

6. **Layered error handling.** The 401-redirect / 400-field-errors / server-message /
   generic-fallback ladder described under C-3. Do not "improve" the repeated generic
   string without reading the ladder above it.

7. **The unknown-check default.** `public/portal/shell.js:111-117`: an unrecognised
   validation check renders with a prettified name and counts as material, so a
   check nobody wrote copy for degrades into a visible item rather than vanishing.
   Given F-F001, this instinct is exactly right — it is only the explicit
   `material: false` at `:109` that defeats it.

8. **`web/`'s dependency minimalism.** Three runtime dependencies: `next`, `react`,
   `react-dom`. No UI kit, no CSS-in-JS, no animation library, no icon package — every
   icon is an inline SVG. For a solo maintainer this is the difference between a site
   that still builds in a year and one that does not.

9. **Zero fixed widths and full viewport coverage.** Documented under C-4. Whatever
   Stage 2 does, it should not be the change that introduces the first fixed pixel
   width.

10. **`web/app/globals.css:117-134`** — the reduced-motion block that also resets
    `.reveal-hidden`. Scroll-reveal implementations routinely leave content permanently
    invisible under reduced motion; this one does not.

---

## The token question

**Is there one source of truth for the brand values? No. There are five, and no
mechanism would notice them drifting.**

Values live in `public/portal/tokens.css` (43 custom properties),
`public/demo/shared.css` (25), `public/demo/styles.css` (21), `web/app/globals.css` (34),
and `public/admin/style.css` (**0** — every value hardcoded inline, which is the S-C
token count the accounting requires).

Counting definitions of the same token name across those files:

| Measure | Count |
|---|---|
| Token names defined in more than one file | **26** |
| …with an identical value everywhere | **23** |
| …with a divergent value | **3** |
| Total redundant definitions (defs beyond the first) | **46** |

The three divergences:

| Token | `portal/tokens.css` | `demo/*.css` | `web/globals.css` |
|---|---|---|---|
| `--accent` | `var(--teal)` → `#0f766e` | — | `#5c8df0` |
| `--bg` | `#f6f8fa` | `#eef2f6` | — |
| `--sans` | `'Inter', system-ui, …` | `system-ui, …` | `var(--font-geist-sans), …` |

`--bg` is a deliberate, documented choice — `tokens.css:19-20` explains the portal ground
is "a hair lighter than the demo's `#eef2f6`". That is a decision, and it is recorded at
the point of divergence. Correct practice.

`--accent` is not. It is the brand, and it disagrees across the stack split (F-F008).

`--sans` is a third case: the portal names `'Inter'` first, but **no `@font-face` for
Inter exists anywhere in `public/`, and there is no Google Fonts link**. The declared
face silently resolves to `system-ui` for every owner without Inter installed locally.
The portal's typography is therefore not the typography it declares. Appendix item.

The remaining 23 names — `--card #ffffff`, `--ink #0f172a`, `--ink-2 #334155`,
`--muted #64748b`, `--line #e2e8f0`, the teal ramp, the green ramp, the amber ramp,
`--radius 14px`, `--radius-sm 10px`, both shadows, `--te`, `--hi` — agree today across
all three `public/**` definitions. They agree by hand, and nothing checks that they
still do. Each is one careless edit from becoming a fourth divergence, discovered by eye.

### Proposed remedy

Not codegen. Generating `public/tokens.css` from a shared source would introduce a build
step into `public/`, which breaches §2 — the constraint that makes this problem exist is
also the constraint that rules out the obvious fix. And for a solo maintainer, a
generator is a second thing to maintain and a first thing to forget.

**Propose: a hand-maintained values file plus a drift check in the existing test suite.**

1. **`docs/design/brand-values.md`** — one table, the canonical value for every token
   name that appears on more than one surface, and for each a one-line note where a
   surface deliberately differs (as `--bg` already does). Documentation, not a build
   input. Nothing imports it; it is the thing a human consults before editing a token.

2. **`tests/design/tokenDrift.test.js`** — a node:test file that parses the `:root`
   blocks of the four stylesheets and the table in the markdown, then asserts that every
   token named in the table matches everywhere it is defined, except where the table
   records a deliberate divergence. Roughly 60 lines, `fs.readFileSync` plus a regex;
   no dependency, no build step, no change to how any surface loads CSS. It runs inside
   the existing `npm test` and turns a silent divergence into a named failure.

This is the only cross-surface design-system item that warrants a program. It is worth
doing because it is cheap, it is enforced, and it does not touch the shipped bytes.
Everything else in this audit is per-surface polish and should be scoped as such.

**One deliberate omission.** The duplicated font assets — six `.woff2` files and a
byte-identical `fonts.css` in both `public/demo/fonts/` and `public/portal/fonts/` —
are *not* worth deduplicating. Hoisting them to `public/fonts/` would save perhaps 200KB
of repository size and couple two surfaces that currently deploy and change
independently. The duplication is the cheaper defect. Left alone on purpose.

---

## Effort totals per surface

| Surface | Findings | Hours |
|---|---|---|
| **S-A** `web/` | F-F002 (1) · F-F003 (3) · F-F004 (1) · F-F005 (5) · F-F006 (1) · F-F007 (2) · F-F009 (1) | **14h** |
| **S-A / S-B shared** | F-F008 (2) | **2h** |
| **S-B** `public/portal/` | F-F001 (4) | **4h** |
| **S-D** `public/demo/` | none | **0h** |
| Cross-surface | token values file + drift test | **4h** |
| **Total, numbered findings** | | **24h** |

**Against the ten-session cap: the in-scope backlog fits, with room to spare.**

At a conservative 4–6 productive hours per session, 24 hours is **4 to 6 sessions**.
D-005 funds ten. The gap runs the right way, and Stage 2 should be told so plainly
rather than discovering it while sizing epics.

Three qualifications on that number:

- **F-F003 carries a content dependency, not an engineering one.** The 3h is the
  engineering; the entity name, registered address, city and grievance officer must come
  from the founder. If those values are not in hand when the session starts, the session
  stalls. Request them before Stage 2.
- **F-F008's 2h excludes the brand decision itself**, which is a founder call and not
  billable to the program.
- **The S5 appendix is unscheduled**, per D-005 and the S-B correctness-only rule. If
  the remaining four-to-six sessions are spent on appendix items, that is a choice worth
  making consciously — the prediction D-005 is testing concerns credibility with
  prospects, and every appendix item is either invisible to a prospect or on a surface
  a prospect never sees.

**The honest recommendation:** the four S1 findings (8h) close the gap between what the
surfaces claim and what is true. The four S-A S2 findings (9h) are what D-005's
prediction actually rides on. That is 17 hours, three sessions, and it is the whole
program worth funding today. Hold the remainder against what the first ten clinic
conversations reveal, which is what D-005's review date is for.

---

## Cannot be audited from source

Owed to a session with a running render and a real device, after Issue 20 deploys. Not
guessed at here.

1. **Real glyph rendering.** Whether Telugu conjuncts and matras render correctly at the
   declared weights, on Windows, Android and iOS. The `unicode-range` declarations are
   right on paper; only a render proves the faces cover the actual fixture strings.
2. **Motion in practice.** Whether `HeroChat`'s IntersectionObserver animation and the
   `0fr`/`1fr` FAQ transition feel considered or cheap, and whether scroll-reveal fires
   at sensible thresholds on a slow device.
3. **Focus visibility in practice.** F-F009 identifies four colour-only indicators from
   source. Whether the *other ten* rings are actually perceptible against
   `--ink-900` and against the `--surface-2` cards needs eyes.
4. **Responsive behaviour on hardware.** Zero fixed widths is necessary, not sufficient.
   The portal sidebar at `--sidebar-w: 232px` on a 360px phone, and the `web/` hero's
   two-column split at the 900px breakpoint, both need a device.
5. **Perceived performance.** Actual LCP and INP for `web/` over an Indian mobile
   network. The dependency list is minimal and there are no images to optimise, which is
   promising, but promising is not measured.
6. **Hydration and layout shift.** Whether the five `'use client'` components cause
   visible shift on hydration, particularly `Nav`'s `scrolled` state, which computes on
   mount and could flash an unscrolled header.
7. **Screen-reader behaviour.** F-F007's DOM facts are certain; the announced result
   with NVDA, VoiceOver and TalkBack is inferred and should be confirmed.
8. **Whether `web/` deploys at all.** F-F004 establishes that nothing in the repository
   builds it. Whether a Vercel project exists, what domain it serves, and whether it
   tracks `main` are founder facts that no amount of reading will settle.
9. **The OG card.** F-F002 shows the OG URL is a placeholder. Once fixed, whether the
   1200×630 image reads well as a WhatsApp preview thumbnail — the primary sharing
   surface for this audience — needs a real send.

---

## S5 appendix — demoted, unscheduled

Not scheduled under D-005 until the numbered set is closed. Recorded so they are not
rediscovered.

1. **`'Inter'` is declared but never loaded** (S-B). `public/portal/tokens.css:73` names
   `'Inter'` first in `--sans`; no `@font-face` and no font link exists in `public/`. The
   portal silently renders in `system-ui`. Either self-host Inter beside the Noto faces
   or drop the name from the stack — the second is one line and honest.

2. **46 redundant token definitions** (cross-surface). Quantified above. The drift test
   is proposed as a numbered cross-surface item; the redundancy itself is tolerable.

3. **`public/demo/styles.css` duplicates `shared.css`** (S-D). `index.html` loads
   `styles.css`; `dashboard.html` and `inbox.html` load `shared.css`. The two redeclare
   21 and 25 properties with 18 in common. Collapsing them into `shared.css` plus a
   page file is a contained vanilla-CSS change with no framework implication.

4. **Narrow `prefers-reduced-motion` blocks** (S-B, S-D). `portal/tokens.css:287-289` and
   `demo/shared.css:110-112` each silence one animation and leave transitions running.
   Widening each to a `*` block matching `web/app/globals.css:117-134` is a few lines.

5. **`'use client'` on `Faq.tsx`** (S-A). Native `<details>`/`<summary>` would ship zero
   JavaScript, at the cost of the current correct ARIA wiring and grid animation. A
   trade-off, not a defect.

6. **`"Saved · v3"` exposes a version counter** (S-B). Eight pages append a version
   number to the save confirmation. Arguably system mechanics reaching the owner,
   against §1's rule — though the history page makes versions a real owner-facing
   concept, which mostly redeems it.

7. **`.lang-te` / `.lang-hi` classes without a `lang` attribute** (S-B).
   `history.css:104-105`, `knows.css:95-96`, `receptionist.css:71-72` and
   `clinic-profile.css:63-64` select on a class to set the font, but the corresponding
   markup sets no `lang`. Screen readers will read Telugu with an English voice.
   `demo/app.js:105` shows the right pattern.

8. **`test.js:68` `'No saved config yet'`** (S-B). The one empty state whose literal
   string describes emptiness rather than inviting the action, against C-3's rule.
   Single instance; surrounding markup may already supply the action.

9. **`README.md:141` — "Build the AI Operating System for businesses."** Not a surface,
   so not a STOP-6 trigger, but it is the first line a visitor to the repository reads
   about the product's purpose, and it is a retired framing. `state.md:20` records the
   retirement. One-line fix.
   (`.claude/agents/backend-engineer.md:13` carries "AI employee" for the same reason
   and the same fix.)

---

## Proposed amendment to `docs/os/state.md`

Required by the definition of done, because Phase 0 established that **no deploy config
builds or serves `web/`**. Not applied in this session — `state.md` is not this session's
file to edit.

The dating question resolved the other way: `web/package.json` was added **2026-06-26**,
which **predates** `portal-v1-spec.md` (2026-07-17). No amendment is owed on that ground.

Proposed insertion into the **Stack (frozen)** section of `docs/os/state.md`, after the
Plivo bullet:

```markdown
- **`web/` is a separate Next.js 15 / React 19 / TypeScript application** — the
  marketing site, and the only prospect-facing surface. It is not served by
  `server.js` (`express.static` covers `public/` only), is not built by any script
  in the root `package.json`, and is not exercised by `npm test` — zero of the 830
  tests touch it. It carries its own `package-lock.json` and `node_modules/`.
  Introduced `34db490` (2026-06-26), which predates `docs/specs/portal-v1-spec.md`;
  §2's static-stack constraint is `public/**`-scoped and `web/` has never been in
  breach of it.
  ⚠️ **Hosting is not repo-derivable.** `web/vercel.json` sets security headers only
  — no build command, no output directory — and no `railway.json`, `Dockerfile`,
  `Procfile` or CI workflow exists. Vercel is implied by convention and nothing more.
  The deploy target must be confirmed by the founder and recorded in
  `docs/os/decisions.md`. See `docs/audit/2026-07-frontend.md` F-F004.
```

And in **Launch gates**, gate 2's evidence column should note that the marketing
surface is outside Issue 20's current scope — a first production deploy as scoped today
ships the Express app and `public/**`, and leaves the surface a prospect sees first
un-deployed by any reviewable process.

Two further records are owed and are not `state.md`'s to carry:

- **`docs/os/decisions.md`** — an entry logging the split-host architecture, with a
  falsifiable prediction and a review date, per that file's own format rule. F-F004
  exists because this entry does not.
- **`f2601c7` left `Verified-at` stale.** Noted under Phase 0 condition 1. The next
  session to touch `state.md` should refresh the line in the same commit.
