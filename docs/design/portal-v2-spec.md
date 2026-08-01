# Prantivo Portal — Product Design Specification v2

**Author:** Lead Product Design
**Status:** Proposal. Requires a `docs/os/decisions.md` override before scheduling (see §0.2).
**Supersedes:** the design-language clause of `docs/specs/portal-v1.md` §4 only. All security invariants (INV-1…INV-6), data-placement rules (§7), and copy rules survive unchanged and are binding on this document.
**Applies to:** `public/portal/` (S-B, 14 pages). Consumed by, not applied to, `web/` (S-A) and `public/demo/` (S-D).

---

## 0. Scope, honesty, and cost

### 0.1 What this document is

A redesign of the owner-facing AI Receptionist portal from *internal admin panel* to *premium B2B product*, expressed as design decisions and token values. It contains no implementation code by instruction. It is written to be executed as **token-value edits plus copy edits over existing markup**, not as a rewrite. `docs/specs/portal-v1.md` §2 forbids introducing a framework or a build step into `public/`; nothing here requires one. The improve-in-place rule holds: no page is re-authored, no custom property is renamed, no file is moved.

### 0.2 What it costs, and what it does not buy

| | |
|---|---|
| Gates closed | **None.** G-PROOF, G-PAY, G-TEN all remain false. |
| External clocks advanced | **None.** |
| Hierarchy rank | **H5** — requires a written override to be scheduled at all. |
| Sessions, Tier 1 only | 4–5 |
| Sessions, full document | 14–18 |
| Delay to nearest gate | Tier 1 costs ~1 week of build clock; the external clocks do not care and keep not running |

The override, if written, needs a falsifiable prediction. The only honest one available: *the next N clinic owners who see the portal in a demo do not ask whether the product is finished.* That is testable at the first three demos and is the review condition.

### 0.3 What Tier 1 fixes that is already a filed defect

Two items in the Stage-1 audit are resolved by this design rather than added to the backlog:

- **F-F008** (marketing site and portal use different brand accents, 2h, "excludes the brand decision itself, which is a founder call"). §2.2 makes the brand decision: **teal wins, as a ramp, and the light-ground and dark-ground steps are named separately.** `web/`'s `#14b8a6` and the portal's `#0f766e` stop being a divergence and become two documented steps of one scale. The founder call is made here; the 2h remains.
- **F-F001** (the portal reports success for edits that are silently inert). §2.11 and §3.0 introduce the **truth strip** as a system-level component. The remedy the audit located at `shell.js:109` gets a designed home rather than being bolted on.

### 0.4 The thirteen requested screens, mapped to reality

| Requested | Exists today | Owner-facing name | Tier |
|---|---|---|---|
| Login | yes (`login.html`) | Sign in | **1** |
| Dashboard | yes (Home/Readiness) | Home | **1** |
| AI Settings | yes (Receptionist + Safety & handoff) | Receptionist · Safety & handoff | **1** |
| Knowledge Base | **partly** — FAQs only; Documents was never built | FAQs · Documents *(inert `Soon` row — see §3.0)* | **1** |
| Tenant Settings | yes, split across 5 pages | Clinic profile · Hours · Pricing · Doctors · Booking rules | **1** |
| Conversations | no (demo `inbox.html` is a proof surface, not the portal) | Conversations | **2** |
| Appointments | no (`appointments` table exists) | Appointments | **2** |
| CRM | no (`crm_*` tables exist, backend only) | Patients | **2** |
| Analytics | no — excluded by portal-v1 §9 | Activity | **3** |
| Integrations | no | Connections | **3**, read-only |
| Billing | no | Plan & billing | **3**, G-PAY |
| User Management | no — excluded by portal-v1 §9 (single owner) | People | **3**, G-PAY |
| Workflow Builder | no | — | **Do not build** |

**Tier 1 — reskin.** Redesign of surfaces that exist. Zero backend work, zero new routes, zero new tables. This is the whole of what "make it look premium" actually requires.
**Tier 2 — after G-PROOF.** Conversations, Appointments and Patients are worthless before there is production traffic to put in them, and they design themselves wrong when designed against fixtures. Specified here at layout depth so the IA has room reserved; not scheduled.
**Tier 3 — after G-PAY.** Activity, Connections, Plan & billing, People. Each is generalisation ahead of a paying customer.
**Workflow Builder — refused.** A rules engine with a visual builder is the platform positioning under a new name. `workflows` exists as a backend module in `ZYON_V2_SPEC.md` §3; exposing it to owners converts an AI Receptionist into an automation platform, which is the retired framing. When a clinic asks for an automation, it is configuration for that clinic until three clinics ask for the same one. §6.1 records what to build instead.

---

## 1. Reading the product before designing it

Design decisions below are derived from these five facts, not from the reference products.

**1. The user is a non-technical clinic owner, frequently on a phone, in daylight.** The acceptance criterion in portal-v1 §11 is a fresh clinic configured *on a phone, unaided, in under 45 minutes*. This kills the dark-dashboard direction the reference list would otherwise pull toward: a near-black ground is what developer tools look like, and it is illegible on an uncalibrated Android screen in an Indian clinic at midday. **The ground stays light.** Dark mode is Tier 3 and optional.

**2. The interface must set three scripts side by side.** Telugu, Devanagari, and Latin appear in the same form, often in the same card — a greeting field per enabled language, sitting under an English label. This is the most constraining typographic fact in the brief and it disqualifies almost every "premium SaaS" typeface. Geist has no Telugu. Inter has no Telugu. The audit already found that the portal *declares* Inter with no `@font-face` behind it, so the portal's stated typography is currently fiction. §2.3 resolves this in the direction the product's own content demands.

**3. The product's promise is that the receptionist says only what the clinic told it to say.** Prices are quoted verbatim from a config-rendered FACTS block, never from model memory. The portal's real job is therefore not "settings" — it is **showing the owner the relationship between what they typed and what will be said.** That is the design problem, and it is where the one bold element goes.

**4. The product currently lies in one specific way.** F-F001: an owner edits hours, is told `Saved · v12`, and the receptionist keeps using the old prompt. Premium is not a shadow value. Premium is a product that is never wrong about its own state. Stripe's test-mode banner is the canonical instance of this and it is the single most transferable idea on the reference list.

**5. There is one maintainer and no build step.** Every decision must survive a solo founder returning to it in eight months. That rules out a component framework, an icon package, a charting library, a CSS-in-JS runtime, and a token generator. The audit explicitly praises the existing dependency minimalism; this spec does not spend it.

### 1.1 What actually makes the reference products feel premium

Extracted as principles, not appearances. These are the acceptance criteria for every decision below.

1. **Colour is rationed.** One accent, spent only where action or state lives. Neutrals carry the entire interface. A premium UI looks almost monochrome until you need something.
2. **Hairlines, not shadows.** Structure is drawn with 1px borders. Elevation is reserved for the four things that genuinely float. A card with a drop shadow is a 2014 admin panel.
3. **Type carries the hierarchy, weight carries the emphasis.** Few sizes, decisive weight jumps, tight tracking above 20px, generous leading on prose. Never bold and coloured and larger to make one point.
4. **Density is deliberate and never varies by accident.** The same vertical rhythm on every page. Most amateur interfaces are identifiable by inconsistent gaps alone.
5. **Numbers are set as data.** Tabular figures, right-aligned in columns, one decimal convention. Fees and times that jitter between rows read as unreliable — fatal for a product whose promise is price accuracy.
6. **Every state is designed.** Empty, loading, partial, error, offline, over-limit. Premium products feel premium because nothing ever looks broken; there is no gap where the design stopped.
7. **Latency is absorbed with structure, not spinners.** Skeletons in the shape of the answer.
8. **Motion is short, functional, and mostly absent.** 120–240ms, opacity and small translate, never on layout properties, never a spring. One orchestrated moment per product, not effects scattered everywhere.
9. **The keyboard is a real input.** Visible focus, Escape closes, Enter submits, one command surface.
10. **Copy is plain and stable.** The verb that starts an action names its result. `Save changes → Saving… → Saved`, which this codebase already does correctly on all ten writing pages and which is preserved verbatim.
11. **The product tells the truth about itself,** including when it is degraded, unfinished, or not live.

### 1.2 Design thesis

> **The receptionist's register.**

The subject's own artifacts are a ruled appointment register, a fee board on the clinic wall, and a name plate. All three are instruments of *legible public truth* — things a patient can read and hold you to. That is exactly what a config portal for a verbatim-quoting receptionist is.

So: **ruled, legible, verifiable.** Hairline rules as the primary structural device. Tabular figures on every number. One accent. And one place, and only one place, where the interface goes dark and speaks in the patient's language — the Verbatim panel (§2.11), which is the signature.

### 1.3 The one risk, and its justification

**The Verbatim panel inverts the product's ground.** Everywhere else, Prantivo is a calm near-white tool. In one docked panel it becomes an ink field carrying Telugu and Devanagari at display size, showing what the receptionist will actually say.

Justification: it makes the highest-consequence rendering detail in the product — vernacular glyph fidelity, per the audit's C-1 and Preserve-As-Is #1 — the most visible thing in the interface, where a tofu box would be caught in the first five seconds instead of in a demo. It converts the product's core promise from a claim into a continuously visible fact. And it means the portal's memorable element is something no competitor's dashboard has, because no competitor's dashboard has to render Telugu.

Cost, stated: it is the one part of this spec that needs new markup rather than new token values.

**`knows.html` is the Verbatim panel's predecessor, and its status is undecided.** The page shipped at `PORTAL-P5-S15` as "What it knows": a read-only summary of what the receptionist has been told, assembled through the renderer's own gates. That is the same question the Verbatim panel answers — *what will it actually say?* — asked one step earlier and without the ink ground. D2 filed it under CHECK (§3.0) so it stays reachable, which is a placement decision, **not** a decision about its future.

**D4 Phase 0 decides**, and only after reading the page:

- **Retire it** — if the Verbatim panel is a strict superset of what `knows.html` renders, keeping both leaves two surfaces answering one question, which is how they drift apart.
- **Retain it as a linked advanced view** — if it shows anything the panel does not (whole-config breadth rather than per-page depth, for instance), it earns its place, and the panel should link to it.

**Not decided here.** Deciding before reading the page is how a real surface gets deleted on an assumption, and `knows.html` has exactly one inbound link to lose.

### 1.4 Reconciling the two signatures

portal-v1 §4 names the **readiness ring** as the one bold element portal-wide. This spec introduces a second. Two signatures is one too many, so they are separated by rule:

- The **readiness ring** is Home's signature. It appears on Home and inside the wizard's Review step. Nowhere else.
- The **Verbatim panel** is the product's signature. It appears on the eight editing pages and on Test. Never on Home.

They never share a screen. Restraint is preserved by segregation rather than by deletion.

---

## 2. Design system

Token names follow the existing `public/portal/tokens.css` vocabulary wherever one exists. New names are additive. **No custom property is renamed** — renaming 43 properties across 15 stylesheets is churn with no user-visible result.

### 2.1 Colour

#### Ground and ink — unchanged

The slate ramp already in `tokens.css` is correct and contrast-checked. It is kept in full.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#F6F8FA` | App ground. Deliberately lighter than the demo's `#EEF2F6`; that divergence is documented at `tokens.css:19` and stays. |
| `--card` | `#FFFFFF` | Surface. |
| `--ink` | `#0F172A` | Primary text, headings. |
| `--ink-2` | `#334155` | Body, secondary text. |
| `--muted` | `#64748B` | Labels, help text, meta. |
| `--faint` | `#94A3B8` | Disabled, de-emphasised, placeholder. |
| `--line` | `#E2E8F0` | Hairline borders. **The primary structural device.** |
| `--line-2` | `#EEF2F6` | Inner dividers, table row rules, chart gridlines. |

**New:**

| Token | Value | Role |
|---|---|---|
| `--field` | `#0C1420` | The ink ground. Used for exactly one component product-wide: the Verbatim panel. Slate-blue rather than black, so it harmonises with `--ink` rather than fighting it. |
| `--field-2` | `#141C2A` | Raised surface inside the ink ground (message bubble, code block). |
| `--field-line` | `rgba(255,255,255,0.10)` | Hairline on the ink ground. |
| `--field-ink` | `#E8EDF2` | Primary text on the ink ground. |
| `--field-muted` | `#94A3B8` | Meta on the ink ground. |

#### The teal ramp — the brand decision (closes F-F008)

Teal is kept. It is consumed on all 14 portal pages, covered by the root suite, and it is the correct hue for clinical trust without the medical-blue cliché or the indigo every B2B SaaS defaults to. The marketing site is the surface that already moved once; it moves again, to a *step of this scale* rather than to a different hue.

| Token | Value | Contrast | Use |
|---|---|---|---|
| `--teal-50` | `#F0FDFA` | — | Active nav background, selected row, subtle info fill |
| `--teal-100` | `#CCFBF1` | — | Badge fill on light ground |
| `--teal-200` | `#99F6E4` | — | Chart series fill, hover on tinted surfaces |
| `--teal-300` | `#5EEAD4` | — | Reserved |
| `--teal-400` | `#2DD4BF` | 9.4:1 on `--field` | **Accent on the ink ground.** Hover state there. |
| `--teal-500` | `#14B8A6` | 7.9:1 on `--field` | **Accent on the ink ground.** Links, focus, live dot in the Verbatim panel. This is `web/globals.css`'s current value — now a named step, not a divergence. |
| `--teal-600` | `#0D9488` | 3.9:1 on `--card` | Chart series 1. Large text and non-text UI only. |
| `--teal-700` | `#0F766E` | **5.4:1** on `--card` | **The accent on the light ground.** Primary buttons, active nav text, links, focus ring. Unchanged from today. |
| `--teal-800` | `#115E59` | 7.4:1 | Primary button hover |
| `--teal-900` | `#134E4A` | 9.6:1 | Primary button pressed |
| `--accent` | `var(--teal-700)` | | The alias every component uses on light ground. |
| `--accent-on-field` | `var(--teal-500)` | | The alias every component uses on the ink ground. |

**Rule:** an interface element gets accent colour only if it is (a) the primary action on the screen, (b) the current navigation position, (c) a link, (d) a focus indicator, or (e) the live indicator. Nothing else. No accent-coloured headings, no accent-coloured icons in a resting state, no accent borders on cards.

#### Semantic colour — states only, never decoration

Existing values are kept; the ramps are completed so badges, banners and inline errors draw from one place.

| State | Fill | Border | Text/icon | Meaning in this product |
|---|---|---|---|---|
| Success | `--green-50 #F0FDF4` | `--green-200 #BBF7D0` | `--green-700 #15803D` | Live · saved · check passed |
| Attention | `--amber-50 #FFFBEB` | `--amber-200 #FDE68A` | `--amber-700 #B45309` | Action needed · paused · not yet connected |
| Error | `--red-50 #FEF2F2` | `--red-200 #FECACA` | `--red-700 #B91C1C` | Failed · invalid · blocked |
| Neutral | `--line-2` | `--line` | `--muted` | Draft · operator-run · not applicable |

**Rule:** status is never colour-only. Every status carries an icon and a word. This is an accessibility requirement (§2.13) and a legibility requirement on cheap screens.

#### Contrast floor

WCAG 2.2 AA is the floor, not the target. Every pair below is verified:

| Pair | Ratio |
|---|---|
| `--ink` on `--card` | 16.9:1 |
| `--ink-2` on `--card` | 10.4:1 |
| `--muted` on `--card` | 5.3:1 |
| `--muted` on `--bg` | 5.0:1 |
| `--faint` on `--card` | 2.8:1 — **non-text only**, never body copy |
| `--teal-700` on `--card` | 5.4:1 |
| `#FFFFFF` on `--teal-700` | 5.4:1 |
| `--teal-500` on `--field` | 7.9:1 |
| `--field-ink` on `--field` | 14.6:1 |
| `--red-700` on `--red-50` | 6.6:1 |

`--faint` is the one token that fails text contrast and it is therefore restricted by rule to icons at rest, disabled control chrome, and placeholder text — never to help text, which is `--muted`.

### 2.2 Typography

#### The family decision

**One family across all three scripts: Noto Sans.**

The portal already self-hosts six Noto faces — Telugu 400/600/700 and Devanagari 400/600/700 — `unicode-range`-scoped, `font-display: swap`, zero CDN. The audit calls this the best-built thing in the repository and marks it Preserve-As-Is #1. Adding **Noto Sans (Latin)** through the identical pipeline makes the entire product one typographic family.

Why this over the obvious answer:

- Inter is *the* premium-SaaS default face. On a brief that names Linear, Vercel and Clerk, reaching for Inter is arriving where the prompt started. More importantly it has no Telugu, so a Telugu greeting and its English label would sit in two unrelated families with mismatched x-heights and stroke weights, in the same card, at the same optical size — visible as a seam to anyone who reads Telugu, which is the entire target market.
- Noto Sans Latin, Telugu and Devanagari share design metrics by construction. A trilingual card sets on one baseline grid. **No product in this category can do that, and it is a direct consequence of who the customer is.**
- The existing declaration is currently false — `--sans: 'Inter', system-ui, …` with no `@font-face` anywhere in `public/`, silently resolving to `system-ui`. This fixes a documented untruth rather than adding a font.
- One new pipeline invocation, no build step, no CDN, no dependency. The generator script already exists and is marked "Do not edit by hand."

Noto Sans is neutral at body size, which is correct for a form-heavy tool. Its plainness at display size is handled with tracking and weight (below), not with a second family.

| Token | Stack | Applied to |
|---|---|---|
| `--sans` | `'Noto Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | Everything Latin |
| `--te` | `'Noto Sans Telugu', 'Noto Sans', system-ui, sans-serif` | Elements with `lang="te"` |
| `--hi` | `'Noto Sans Devanagari', 'Noto Sans', system-ui, sans-serif` | Elements with `lang="hi"` |
| `--mono` | `ui-monospace, 'SF Mono', Menlo, Consolas, monospace` | Config version ids, trace ids, API references. **Not** for fees, dates, or phone numbers. |

Weights loaded: **400, 500, 600, 700.** Four weights per script. No 300, no 800 — a light weight is unreadable at 13px on a cheap Android panel and an extra-bold has no job in this system.

`lang` attributes are mandatory on every vernacular string. `public/demo/app.js:105` already does this correctly (`<div class="turn__te" lang="te">`) and is the pattern to copy; it drives both font selection and screen-reader pronunciation.

#### The scale

A modular scale would produce sizes nobody needs. This is a hand-set scale of nine steps, each with a job. Body sits at 15px, matching the current portal — 16 is too loose for dense forms, 14 too small for a 45-year-old owner on a phone.

| Token | Size / line-height | Weight | Tracking | Job |
|---|---|---|---|---|
| `--t-display` | 30 / 36 | 600 | −0.025em | Sign-in headline. Readiness score numeral. One per page maximum, and most pages have none. |
| `--t-h1` | 22 / 28 | 600 | −0.018em | Page title in the page header |
| `--t-h2` | 17 / 24 | 600 | −0.011em | Card title |
| `--t-h3` | 15 / 22 | 600 | −0.006em | Sub-section within a card; table group header |
| `--t-body` | 15 / 24 | 400 | 0 | Default. Form values, prose, table cells. |
| `--t-body-sm` | 13.5 / 20 | 400 | 0 | Nav items, dense table cells, secondary rows |
| `--t-label` | 13 / 18 | 500 | 0 | Field labels, column headers |
| `--t-help` | 12.5 / 18 | 400 | 0 | Help text under a field, meta, timestamps |
| `--t-micro` | 11 / 14 | 600 | 0.05em, uppercase | Nav group headers, badge text, eyebrow labels. **Uppercase only here.** |

Vernacular strings render one step larger than their Latin equivalent at the same nominal size. Telugu and Devanagari carry matras and conjuncts above and below the baseline that are unreadable at Latin's optical size:

| Latin | Telugu / Devanagari |
|---|---|
| `--t-body` 15/24 | 16 / 30 |
| `--t-h2` 17/24 | 18 / 30 |
| Verbatim panel body | 19 / 34 |

Line-height, not just size — the descender and superscript marks need the room, and cramped leading is where Telugu starts looking broken.

#### Prose and numeral rules

- **Measure:** body prose is capped at 68ch. `--content-max` stays 760px.
- **Tabular figures are on by default** for every fee, time, date, count, duration, phone number, version number, and table cell containing a number. This is the single highest-leverage typographic decision in the product: proportional figures make a column of fees jitter, and a jittering fee column undermines a product whose promise is price accuracy.
- **Currency:** `₹` always, no space, integers only, thousands-separated Indian-style (`₹1,50,000`). `price_from` renders as `starts at ₹800`, never `₹800+`.
- **Time:** 12-hour with lowercase meridiem, `9:30 am`. Ranges use an en dash with hairline spaces: `9:30 am – 1:00 pm`.
- **Dates:** `12 Aug 2026` in content, `Mon 12 Aug` in schedules, relative only under 24 hours (`14 min ago`).
- **Sentence case everywhere.** Page titles, card titles, buttons, labels, table headers, menu items. Title Case appears nowhere in this product. The only uppercase is `--t-micro`.

### 2.3 Spacing — 8px system

Base 8, with a 4px half-step for intra-component spacing only. Existing token names are kept and the scale is extended by two steps.

| Token | Value | Use |
|---|---|---|
| `--s-1` | 4px | Icon-to-label, badge padding, inline gaps. **Never between components.** |
| `--s-2` | 8px | Label to input; tight stacks |
| `--s-3` | 12px | Input vertical padding; table cell padding |
| `--s-4` | 16px | Field to field; card inner padding on mobile |
| `--s-5` | 24px | Card inner padding on desktop; card to card |
| `--s-6` | 32px | Section to section within a page |
| `--s-7` | 48px | Page header to first card; page bottom padding |
| `--s-8` | 64px | *new* — empty-state vertical padding |
| `--s-9` | 96px | *new* — sign-in page vertical centring |

**Rules.**
- Only these values. No `18px`, no `10px`, no `padding: 7px 14px`.
- Vertical rhythm within a card is `--s-4` between fields, always. A card whose fields are spaced 16 / 16 / 20 / 16 is how amateur reads, and it is the most common defect in the existing pages.
- Horizontal page padding: `--s-6` desktop, `--s-4` mobile.
- Touch targets: **44×44 minimum on mobile**, 32px minimum height on desktop, 24×24 absolute floor for any pointer target (WCAG 2.2 AA).

### 2.4 Border radius

Current values (14 / 10 / 8) are uniformly a little soft, which reads friendly rather than precise. Tightened, and made proportional — smaller elements take smaller radii, which is what stops an interface looking inflated.

| Token | Value | Applied to |
|---|---|---|
| `--r-xs` | 4px | Badges, tags, checkboxes, focus ring corners |
| `--r-sm` | 6px | Buttons, inputs, selects, nav items, table row hover |
| `--r-md` | 10px | Cards, banners, dropdown menus, toasts |
| `--r-lg` | 14px | Modals, mobile sheets, the Verbatim panel |
| `--r-full` | 999px | Pills, avatars, the readiness ring, toggle knobs |

Token-value edit only. `--radius` / `--radius-sm` / `--radius-xs` remain as aliases so no existing rule breaks: `--radius: var(--r-md)`, `--radius-sm: var(--r-sm)`, `--radius-xs: var(--r-xs)`.

### 2.5 Elevation

**Cards do not have shadows.** A card is `background: --card` plus `1px solid --line`. This is the largest single visual change in the redesign and it is what separates the reference products from a template: on Stripe, Linear and Vercel, a resting surface is drawn, not floated.

Exactly four things cast a shadow, because exactly four things genuinely float:

| Token | Composition | Casts |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(15,23,42,.06)` | Dropdown menus, popovers, select panels |
| `--shadow-md` | `0 2px 4px rgba(15,23,42,.05), 0 8px 20px rgba(15,23,42,.08)` | Toasts, the sticky mobile save bar when content is behind it |
| `--shadow-lg` | `0 4px 8px rgba(15,23,42,.06), 0 20px 48px rgba(15,23,42,.14)` | Modals, mobile drawer |
| `--shadow-field` | `0 1px 2px rgba(0,0,0,.4), 0 16px 40px rgba(0,0,0,.35)` | The Verbatim panel when it floats as a mobile sheet |

Shadows are slate-tinted, never pure black, on the light ground — pure black on a cool grey reads dirty. Every shadow is two layers: a tight contact shadow and a soft ambient one. A single-layer shadow is the tell.

`--shadow` and `--shadow-sm` keep their existing names as aliases to `--shadow-md` and `--shadow-sm` so existing declarations continue to resolve.

### 2.6 Iconography

No icon package. Inline SVG, drawn to one grammar, as the audit's Preserve-As-Is #8 requires. Adding `lucide` or `heroicons` would violate the standing prohibition on new dependencies without a named seam, and the seam does not exist for icons.

| Property | Value |
|---|---|
| Box | 20×20 default · 16×16 in dense table rows and nav · 24×24 in empty states and the truth strip |
| Stroke | 1.5px at 20px, 1.25px at 16px. **Optically corrected, not scaled.** |
| Colour | `currentColor` always. Never a hardcoded hex. |
| Caps / joins | round / round |
| Fill | none, except the live dot, the readiness ring, and the toggle knob |
| Grid | 20px box, 2px optical padding, geometry snapped to whole pixels |

**Semantic set (fixed).** One icon per meaning, never reused for another: check (pass), alert-triangle (action needed), x-circle (failed), clock (pending/hours), phone (voice), message (WhatsApp), calendar (appointments), user (doctor/patient), rupee (pricing), book (FAQs/documents), shield (safety), play (test), history (revisions), lock (operator-only), external (link out).

**Rule:** an icon never appears without a text label except in a table row-action cluster, and there each carries an `aria-label` and a tooltip.

### 2.7 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-1` | 120ms | Hover, focus, colour change, toggle |
| `--dur-2` | 180ms | Dropdown, toast, inline expand, tooltip |
| `--dur-3` | 240ms | Modal, mobile drawer, Verbatim panel sheet |
| `--dur-4` | 600ms | The readiness ring's first draw. **Nothing else may use this.** |
| `--ease-out` | `cubic-bezier(.16,1,.3,1)` | Entrances, expansions |
| `--ease-in-out` | `cubic-bezier(.4,0,.2,1)` | State changes, exits |
| `--ease-linear` | `linear` | Progress, indeterminate loaders |

**Principles.**
1. **Never animate layout properties.** `transform` and `opacity` only. No `width`, `height`, `top`, `margin` transitions — they cost frames and they look cheap on the low-end Android the owner is holding.
2. **Entrances move 4–8px, never more.** A modal fades in and rises 8px. A toast rises 8px. Nothing slides across the screen.
3. **No springs, no bounce, no overshoot.** Overshoot reads as playful; this product is asking a clinic to trust it with patient calls.
4. **Page transitions do not exist.** This is a multi-page app; navigation is instant. Do not add a crossfade to simulate an SPA.
5. **One orchestrated moment in the product:** the readiness ring drawing from 0 to its value over `--dur-4` on first paint of Home, once per session. Everything else is a 120–180ms functional response to an input.
6. **Loading is structural, not spinning.** Skeletons (§2.10). A spinner appears in exactly two places: inside a button while its request is in flight, and in the Verbatim panel while a preview regenerates.
7. **Reduced motion is global, not per-component.** The current `public/**` blocks silence one animation each (`tokens.css:287`); `web/globals.css:117-134` has the correct global pattern and is the model. Under `prefers-reduced-motion: reduce`: all durations to `0.01ms`, `scroll-behavior: auto`, the readiness ring paints at its final value, and any element whose resting state is a transform must be reset so nothing is left invisible.

### 2.8 Layout and grid

**Desktop (≥1024px)**

```
┌────────────┬──────────────────────────────────────────┬─────────────┐
│            │  top bar   56px   truth strip (conditional)│             │
│  sidebar   ├──────────────────────────────────────────┤  Verbatim   │
│   232px    │                                          │   panel     │
│  fixed     │  page header                             │   360px     │
│            │  ───────────────────────────  hairline   │   docked    │
│            │                                          │  (editing   │
│            │  card                                    │   pages     │
│            │  card                                    │   only)     │
│            │                                          │             │
└────────────┴──────────────────────────────────────────┴─────────────┘
             │← content, max-width 760px, centred in its column →│
```

- Sidebar `--sidebar-w: 232px`, fixed, `--card` ground, `1px solid --line` on the right. Unchanged width — it is correct and it is the only fixed dimension in the product (audit C-4).
- Content column max 760px (`--content-max`, unchanged). Below 1440px it is left-aligned with `--s-6` padding; at ≥1440px it centres in the available space.
- The Verbatim panel docks at 360px on ≥1280px. Between 1024 and 1280 it collapses to a rail with a toggle. Below 1024 it becomes a bottom sheet.
- **No dashboard grid.** No 12-column system, no widget mosaic, no drag-to-rearrange. This is a form product; a grid system would be scaffolding for a layout nobody needs. Tier 2's Activity page is the only screen with a multi-column arrangement and it is a fixed 2-up.

**Tablet (768–1023px)** — sidebar collapses to the existing off-canvas drawer. Content full width, max 760px, centred. Verbatim panel is a bottom sheet.

**Mobile (<768px)** — single column. Drawer nav. Sticky page header. Sticky save bar on dirty. Verbatim panel is a bottom sheet with a persistent 44px handle.

**The 380px floor.** The audit confirms zero fixed widths ≥380px across all four surfaces and calls this out as Preserve-As-Is #9. Nothing in this spec introduces one. Every table has a defined <768px behaviour (§2.10). Every fee, name and Telugu string must wrap at 320px without horizontal scroll.

### 2.9 Component library

Twenty-one components. Every one already has a home in the existing pages except the truth strip, the Verbatim panel, and the command palette.

#### Buttons

| Variant | Resting | Hover | Pressed | Use |
|---|---|---|---|---|
| **Primary** | `--teal-700` fill, white text, no border, no shadow | `--teal-800` | `--teal-900` | One per card. `Save changes`, `Go live`, `Sign in`. |
| **Secondary** | `--card` fill, `1px --line`, `--ink-2` text | `--bg` fill, `--line` darkens to `#CBD5E1` | `--line-2` fill | `Cancel`, `Add another`, `Preview` |
| **Ghost** | transparent, `--ink-2` text | `--bg` fill | `--line-2` fill | Table row actions, toolbar, nav |
| **Danger** | `--card` fill, `1px --red-200`, `--red-700` text | `--red-50` fill | `--red-100` fill | `Delete`, `Pause receptionist`. Never a solid red fill — a filled red button invites a misclick on a destructive action. |
| **Link** | no chrome, `--teal-700`, underline on hover only | | | Inline in prose |

Geometry: height 36px default / 32px small / 44px on mobile and for the primary action on any page. Horizontal padding `--s-4`, `--r-sm`, `--t-body-sm` at weight 500, icon 16px with `--s-2` gap.

**States.** Disabled: `--line-2` fill, `--faint` text, no border, `cursor: not-allowed`, and **a reason must be adjacent** — a disabled `Go live` without a sentence saying why is a dead end. Loading: label swaps to the present participle (`Saving…`), a 14px spinner replaces the icon slot, width is held so the button does not resize, the button is `aria-busy` and non-interactive but not `disabled` (so it keeps focus). Focus: §2.13's ring.

**Rules.** Exactly one primary per card and one per modal. Buttons carry verbs, never nouns. The verb persists: `Save changes` → `Saving…` → toast `Saved`. `Submit` appears nowhere, and the audit confirms it currently does not — preserve that.

#### Inputs

Height 40px (44px mobile). `--card` fill, `1px --line`, `--r-sm`, `--s-3` horizontal padding, `--t-body`, `--ink` text, `--faint` placeholder.

- **Hover:** border to `#CBD5E1`.
- **Focus:** border to `--teal-700`, plus the focus ring. No fill change, no glow.
- **Error:** border `--red-500 #DC2626`, message below in `--red-700` at `--t-help` with a 14px alert icon, `aria-invalid`, `aria-describedby` to the message.
- **Disabled:** `--bg` fill, `--faint` text, `--line-2` border.
- **Read-only** (Timezone, the built-in protections panel): `--bg` fill, `--ink-2` text, no border, a lock icon and the reason in help text. Visually distinct from disabled — read-only means *by design*, disabled means *not yet*.

**Label above, always.** No floating labels, no placeholder-as-label. Help text sits below the input in `--muted` at `--t-help`; it explains consequence, not mechanics — "Patients hear this before anything else", not "Max 200 characters". Character counters appear only within 20% of the cap.

**Vernacular fields** get: a language chip in the label row (`తెలుగు` / `हिन्दी` / English), `lang` and `dir` set on the input, the vernacular type scale, and a native-script placeholder. A Telugu greeting field with an English placeholder is the kind of detail that tells an owner this product was not built for them.

**Specialised inputs.**
- *Phone* — a fixed `+91` prefix segment inside the field on `--bg` with a hairline divider, then the number. Normalises through `normalizePhone` on blur and shows the normalised form (INV-6: rejected clearly, never silently rewritten).
- *Fee* — `₹` prefix segment, integer only, tabular figures, right-aligned. Rejects scientific notation explicitly (the defect caught in P2-S6).
- *Time* — native `<input type="time">` on mobile; a 15-minute-step select on desktop.
- *Textarea* — 4 rows default, resize vertical only, auto-grows to 12 rows.
- *Toggle* — 36×20 track, 16px knob, `--faint` off / `--teal-700` on, 120ms. Label to the left, state word to the right (`On` / `Off`) so state is not colour-only.
- *Select* — same geometry as input, 16px chevron, custom `--shadow-sm` panel with 32px options and a check on the selected. Never a native `<select>` on desktop; native on mobile.
- *Multi-select* (payment methods, languages) — checkbox rows, not chips-in-a-box.

#### Cards

The primary container. `--card` fill, `1px --line`, `--r-md`, **no shadow**, `--s-5` padding (`--s-4` mobile).

Anatomy, top to bottom: title (`--t-h2`) · optional one-line description (`--muted`, `--t-help`) · `--s-4` gap · fields · a `--line-2` hairline · footer row with the save action left-aligned and save state right-aligned.

**Card footer states:** clean (button secondary-styled and inert, no message) · dirty (button primary, "Unsaved changes" in `--amber-700` at left) · saving (`Saving…`) · saved (`Saved · v12` in `--muted` with a check, fading after 4s).

The `Saved · v{N}` convention is retained exactly. The version number is the product being transparent about a real mechanism the owner can reference when calling support, and it is set in `--mono`.

Card variants: **default** · **inset** (`--bg` fill, no border — for a read-only block inside a card, e.g. the built-in protections panel) · **stat** (Home/Activity, a `--t-display` numeral over a `--t-label` caption) · **destructive** (`--red-200` border, appears only in a Danger zone section at the page bottom).

#### Tables

The register. Structure is drawn with horizontal rules only — **no vertical rules, no zebra striping, no cell borders.** Zebra striping is the single strongest signal that an interface is a database viewer.

| Element | Spec |
|---|---|
| Header row | `--t-label` at 500, `--muted`, `--s-3` vertical padding, `1px --line` beneath, sticky on scroll |
| Body row | `--s-3` vertical padding, `1px --line-2` beneath, last row no rule |
| Row hover | `--bg` fill, 120ms |
| Row height | 48px default, 40px dense, 56px with an avatar |
| Alignment | Text left · numbers, fees and dates **right, tabular** · actions right |
| Row actions | Ghost icon buttons, revealed on hover and always visible on touch, `aria-label` each |
| Selection | Checkbox column only where a bulk action exists. It exists nowhere in Tier 1. |
| Sorting | Header is a button; the active column shows a 12px arrow; sort persists in the URL |
| Pagination | Not used under 50 rows. Above: `Showing 1–25 of 63` in `--muted`, previous/next secondary buttons. Never infinite scroll in a config tool. |

**Below 768px, tables become cards.** Every table in this product defines its card form explicitly (see each screen). The three-column-scroll pattern is banned — a horizontally scrolling table on a phone is how the owner misses a fee.

#### Badges

Height 22px, `--r-xs`, `--t-micro`, `--s-1`/`--s-2` padding, 6px dot or 12px icon plus a word.

`Live` (green, animated dot — the only ambient animation in the product) · `Paused` (amber) · `Draft` (neutral) · `Action needed` (amber) · `Failed` (red) · `Operator` (neutral, lock icon) · `Soon` (neutral, for unbuilt nav items — this pattern already exists in `tokens.css` and is preserved).

#### Truth strip — *new, system-level*

A full-width band directly beneath the top bar, above the page header. **It appears only when the system's state and the owner's reasonable expectation diverge.** When they agree, it does not exist — an always-present banner is wallpaper within a week.

| Condition | Tone | Copy | Action |
|---|---|---|---|
| Not live | neutral | Your receptionist isn't answering calls yet. Changes are saved and will apply when you go live. | `See what's left` → Home |
| **Legacy prompt set (F-F001)** | **amber** | **Some of your settings aren't reaching your receptionist yet. Prantivo is fixing this — your saved changes are safe.** | `What this affects` → modal listing the inert sections |
| Paused | amber | Your receptionist is paused. Calls and messages aren't being answered. | `Resume` |
| Partially connected | amber | WhatsApp is connected. Phone calls aren't set up yet. | `See status` |

40px tall, tinted fill, `1px` bottom border, 16px icon, `--t-body-sm`, action right-aligned as a link button. Not dismissible — it is a state, not a notice. `role="status"`, `aria-live="polite"`.

This is the component that makes the product premium in the way that matters. It is also the remedy the audit located at `shell.js:109` and could not place, and it borrows the copy voice from `receptionist.html:99` — the existing gap notice the audit marks Preserve-As-Is #4 and calls "the exact template F-F001's remedy needs."

#### Toasts

Bottom-right desktop (`--s-5` inset), **top-centre mobile** so a thumb does not cover it. `--card`, `1px --line`, `--r-md`, `--shadow-md`, max 380px, enters with opacity + 8px rise over `--dur-2`.

Success 4s auto-dismiss, `role="status"`. Error persistent with a `Dismiss` action, `role="alert"`. Max 3 stacked; a fourth replaces the oldest.

**Toasts never carry validation errors.** Field errors are inline on the field. A toast that says "Please fix the errors below" is an interface admitting it does not know where the error is.

#### Modals

Used for exactly three things: destructive confirmation, a required decision that cannot be inline, and snapshot viewing (History). Never for a form that fits on a page.

520px max width, `--r-lg`, `--shadow-lg`, `--s-5` padding, scrim `rgba(15,23,42,.45)`. Enters with opacity + 8px rise over `--dur-3`. Focus traps on open and returns on close. Escape closes; scrim click closes; a destructive modal requires the explicit button.

**Destructive confirmation names the consequence in the button, not `Confirm`:** `Delete this doctor`, `Pause the receptionist`. Body states what happens in one sentence. Where the action is irreversible and non-obvious, the confirm button is disabled until the object's name is typed — used only for deleting a doctor with future appointments.

Below 768px a modal becomes a bottom sheet: full width, `--r-lg` top corners only, rises from the bottom over `--dur-3`, drag-to-dismiss on the handle.

#### Empty, loading, and error states

These are the components most responsible for whether a product feels finished. Each is specified per screen in §3; the shared shapes:

**Empty.** A 24px icon in a 48px `--bg` circle · a `--t-h3` line naming what is missing · a `--muted` `--t-help` line naming the consequence · a primary button. Copy invites the action, never describes the void. `Add your first doctor` / `Patients can't book until at least one doctor has weekly hours set` / `[Add a doctor]`. Vertical padding `--s-8`, centred, max 380px.

The audit flagged `test.js:68` `'No saved config yet'` as the one string that describes emptiness without inviting the fix. Under this spec it reads: *Save your clinic details first — the test uses your real settings.* with a link to Clinic profile.

**Loading.** Skeletons only, in the exact shape of the answer: `--line-2` blocks at `--r-xs`, at the real heights (16px line, 40px input, 48px row), with a 1.4s left-to-right shimmer at 6% white. Shown only if the response is expected to exceed 300ms; below that, nothing, because a flash of skeleton is worse than a pause. A page never shows a centred spinner when its layout is known. Table skeleton renders 5 rows. Never animate skeleton height.

**Error.** Four layers, matching the existing ladder that the audit examined and endorsed (Preserve-As-Is #6) — do not collapse it:
1. **Field** — inline, red, names the fix. `Closing time must be after opening time.`
2. **Card** — a `--red-50` banner inside the card, above the footer, when the whole save failed.
3. **Page** — a centred block replacing content: alert icon, `Couldn't load your pricing`, one `--muted` line, `Try again` primary.
4. **Session** — 401 redirects to sign-in silently (existing behaviour; correct — a dead-end message is worse).

`Something went wrong. Try again.` remains the last-resort fallback after `data.error`, reached only on 5xx and network failure. The audit examined this and withdrew its finding; do not "improve" it without reading the ladder above it.

**Offline.** A `--muted` strip above the sticky save bar: `You're offline. Changes will save when you reconnect.` Save buttons hold their dirty state rather than erroring.

#### Charts (Tier 3)

**Inline SVG. No charting library.** Adding one violates the standing prohibition on new dependencies, and the four charts this product will ever need are 40 lines each.

Rules: no gradient fills, no drop shadows, no 3D, no donut, **no pie charts ever** — a clinic owner comparing five treatment volumes needs a bar chart. Y axis starts at zero for bars; a truncated line-chart axis is labelled as such. Gridlines horizontal only, `--line-2`, 1px. Axis labels `--muted` `--t-help`, tabular. Series 1 `--teal-600`, series 2 `#94A3B8`, series 3 `--amber-700`. Direct labels at the line end for ≤3 series; a legend only above that. Height 220px desktop / 180px mobile. Hover shows a vertical `--line` rule and a `--shadow-sm` tooltip; on touch, tap-to-pin.

Every chart has an empty state (`No calls yet this week` with the axis still drawn, so the shape of the eventual answer is legible) and a loading state (axes drawn, plot area skeletoned).

#### Command palette (Tier 1, cheap)

`⌘K` / `Ctrl+K`. Fuzzy search over the **12 navigation destinations** (§3.0). 560px, `--r-lg`, `--shadow-lg`, positioned 15vh from the top. Arrow keys navigate, Enter opens, Escape closes.

> **Corrected at D2.** This read *"the 13 pages, the doctor list, and the treatment list"*. Two corrections. The page count is **12 navigation destinations**, not 13 — `Documents` is an inert row and is excluded, because a result that routes nowhere is worse than no result. And **the doctor and treatment lists were not built**: searching them means reading tenant data, which would have made the palette the one component in D2 that needed a fetch. It ships as titles only. Adding data search later is a real feature with a real cost, not a detail that was skipped.

This is ~80 lines of vanilla JS with no dependency and it is the highest ratio of perceived sophistication to effort in the entire specification. It is also genuinely useful in a product of this size where the owner is looking for one fee.

#### Other components

**Nav item** — 32px, `--r-sm`, `--s-2`/`--s-3` padding, 16px icon in `--faint`, `--t-body-sm` at 500. Active: `--teal-50` fill, `--teal-700` text at 600, icon `--teal-700`, plus a 2px `--teal-700` left bar inset 4px. The bar matters: it survives greyscale and colour-blindness, which a tint alone does not.

**Nav group header** — `--t-micro`, `--faint`, `--s-4` top / `--s-2` bottom padding, no rule.

**Page header** — title `--t-h1`, optional `--muted` description, right-aligned action cluster, `1px --line` beneath, `--s-6` bottom margin. Sticky on mobile with a 4px shadow on scroll.

**Tabs** — used within a page only, never as primary navigation. Underline style: 2px `--teal-700` beneath the active label, `--muted` inactive, `--ink` on hover. `role="tablist"`, arrow-key navigation.

**Segmented control** — for 2–4 mutually exclusive options that are settings, not navigation (tone: professional/warm; length: concise/standard). `--bg` track, `--card` selected pill with `--shadow-sm`, 32px.

**Sticky save bar (mobile only)** — appears when any card on the page is dirty. Full width, fixed bottom, `--card`, `1px --line` top, `--shadow-md`, `--s-3` padding, safe-area inset respected. Primary save right, `Discard` ghost left. This exists because on a phone the card footer scrolls out of reach and the owner cannot find the button — the most likely cause of failing the 45-minute unaided target.

### 2.10 The Verbatim panel — the signature

**The problem it solves.** The owner types a greeting, a fee, an after-hours message. What they cannot see is what the receptionist will actually *say* — the rendered composite of their facts, the guardrails, and the language. The portal today buries this in a "prompt preview" and a separate Test page. That is backwards: it is the product's entire promise and it should be visible while editing, not after.

**Form.** A 360px panel docked to the right of the content column on ≥1280px. The one place in the product with an ink ground.

```
┌──────────────────────────────────┐
│ ● Live preview        Telugu ▾  │   --field-muted, teal-500 dot
├──────────────────────────────────┤
│                                  │
│  ┌────────────────────────────┐  │
│  │ నమస్కారం, శ్రీ డెంటల్       │  │   Noto Sans Telugu 600
│  │ కేర్‌కి స్వాగతం.            │  │   19/34, --field-ink
│  └────────────────────────────┘  │   --field-2 bubble, --r-md
│  Hello, welcome to Sri Dental     │   --field-muted, --t-help
│  Care.                            │   English gloss, always present
│                                  │
│  ─────────────────────────────   │   --field-line
│                                  │
│  WHAT IT KNOWS RIGHT NOW         │   --t-micro, --field-muted
│  Consultation      ₹500          │   tabular, --field-ink
│  Root canal   from ₹4,500        │
│  Open today   9:30 am – 8 pm     │
│                                  │
│  ─────────────────────────────   │
│                                  │
│  ⚠ 3 treatments have no price    │   --amber, tappable
│                                  │
├──────────────────────────────────┤
│  Hear it  ▸        Open test →   │   ghost buttons
└──────────────────────────────────┘
```

**Behaviour.**
- Regenerates 600ms after the owner stops typing, or immediately on save. Regenerating shows a 2px `--teal-500` progress line at the panel top — not a spinner over the content, so the previous value stays readable.
- The language selector lists only the clinic's enabled languages. It defaults to the first enabled, which for the Hyderabad wedge is Telugu.
- **The English gloss under every vernacular string is mandatory and non-configurable.** The owner may not read Telugu fluently; a preview they cannot verify is theatre.
- The FACTS block shows only what the current page controls, plus the always-relevant (today's hours, consultation fee). Editing Pricing shows fees; editing Hours shows the schedule.
- Warnings are live and tappable, jumping to the offending field.
- `Hear it` plays a cached Sarvam TTS render of the greeting. **Tier 2** — it needs a paid key and a production deploy, and portal-v1 §5.11 explicitly scopes browser voice testing out of v1. The button ships disabled in Tier 1 with the reason adjacent, per the disabled-button rule.

**Placement rules.** Present on the eight editing pages and Test. Absent on Home, History, and all Tier 2/3 pages. Collapsible to a 44px rail with a `Preview` label, state persisted in `localStorage`. Below 1280px it becomes a bottom sheet with a persistent handle showing the first line of the greeting — so even collapsed, the owner sees their receptionist's voice.

**Accessibility.** `lang` on every vernacular string. `aria-live="polite"` on the preview region so a screen-reader user hears the regenerated text. The English gloss is not `aria-hidden` — it is the accessible content for a non-Telugu-reading owner.

**Why this is the one bold element.** It puts the product's promise, the customer's language, and the highest-consequence rendering detail in the product all in the same 360px column. A tofu box in Telugu is caught in five seconds instead of in a demo. No template produces this, because no template has to.

### 2.11 Accessibility

WCAG 2.2 AA as a floor. Non-negotiable items:

**Focus.** Visible on every interactive element, on every surface. Light ground: 2px `--teal-700` ring at 2px offset. Ink ground: 2px `--teal-500` ring plus a 2px `--field` inner ring so it reads against both the panel and any bubble behind it. **Focus is never colour-only** — the audit filed F-F009 for exactly this on four `web/` sites; nothing in `public/portal/` may repeat it. `:focus-visible`, so mouse users do not see rings.

**Keyboard.**

| Key | Action |
|---|---|
| Tab | Nav → truth strip action → page actions → cards in order → Verbatim panel |
| `⌘K` / `Ctrl+K` | Command palette |
| `⌘S` / `Ctrl+S` | Save the focused card |
| Escape | Close modal, sheet, palette, dropdown; revert an inline edit |
| Enter | Submit the focused card; open the focused row |
| Arrows | Within tablist, select panel, palette results, table rows |

Skip-to-content link, first tab stop, visible on focus. Focus traps in modals and the mobile drawer, focus returned to the trigger on close.

**Screen readers.** Landmarks (`nav` / `main` / `complementary` for the Verbatim panel). One `h1` per page, no skipped levels. Every input has a `<label>`; help text and errors are wired with `aria-describedby`; invalid fields carry `aria-invalid`. Tables use `<th scope="col">` and a `<caption>`. Icon-only buttons carry `aria-label`. Live regions: toasts `status`/`alert`, truth strip `status`, readiness score `status`, preview `polite`.

**Colour.** Status is never colour-only — always icon plus word. Charts distinguish series by direct label, not legend swatch. The full interface is usable in greyscale; the active nav item's 2px left bar exists for this reason.

**Motion.** The global reduced-motion block of §2.7. Under reduce, the readiness ring paints at its final value and the live dot stops pulsing.

**Targets.** 24×24 CSS px absolute minimum (2.2 AA), 44×44 on mobile, 8px minimum between adjacent targets in a row-action cluster.

**Zoom and text.** Usable at 200% zoom and at 320px width with no horizontal scroll and no loss of function. No text in images.

**Language.** `lang="en"` on `<html>`; `lang="te"` / `lang="hi"` on every vernacular string, including in the Verbatim panel, tables, and toasts.

### 2.12 Responsive system

| Breakpoint | Layout |
|---|---|
| **≥1440px** | Sidebar 232 · content 760 centred · Verbatim 360 docked |
| **1280–1439** | Sidebar 232 · content fluid to 760 · Verbatim 360 docked |
| **1024–1279** | Sidebar 232 · content fluid · Verbatim collapsed to a 44px rail |
| **768–1023** | Sidebar → drawer · content full width, max 760, centred · Verbatim → bottom sheet |
| **480–767** | Single column · `--s-4` padding · tables → cards · sticky header · sticky save bar |
| **320–479** | As above at `--s-4` · `--t-h1` drops to 20px · action clusters wrap to full-width stacked buttons |

Mobile is a primary target, not a degradation: the v1 acceptance criterion is a fresh clinic configured **on a phone, unaided, in under 45 minutes.** Every screen below states its mobile layout, and where a desktop pattern has no mobile equivalent, the mobile pattern is the one that gets designed first.

---

## 3. Screens

Each screen states only what differs from §2. Shared behaviour — focus rings, toast rules, the error ladder, the save-state discipline, skeleton shapes — is inherited and not restated.

### 3.0 Global chrome and navigation

**Sidebar.** The current flat 12-item list is replaced with four labelled groups. The order is the owner's mental model, not the system's structure — the ordering principle in portal-v1 §4 is kept; only the grouping is new. A flat 12-item list is the single clearest "internal admin panel" signal in the current portal.

> **Inventory, corrected at D2 (`ae5e607`).** An earlier draft of this section assumed **14 navigation destinations**. That number was never true, and it conflated three different counts. The real figures:
>
> | Count | Value | What it is |
> |---|---|---|
> | **Navigation destinations** | **12** | Pages the owner can actually navigate to from the sidebar or `⌘K` |
> | Sidebar rows | 13 | The 12 destinations plus `Documents`, which is **inert** |
> | Files with the shell | 13 | The 12 destinations plus `wizard.html` |
> | `.html` files in `public/portal/` | 14 | The 13 above plus `login.html` |
>
> **`Documents` is an inert `Soon` row, not a destination.** It has no page and no `href`; it is listed so the nav teaches the product's shape, and it cannot 404. `⌘K` deliberately excludes it — a search result that goes nowhere is worse than no result.
>
> **`wizard.html` and `login.html` are pages, not destinations.** Neither appears in the nav. `login.html` carries no shell at all; `wizard.html` carries the shell but is reached from Home, and its steps embed other pages via `is-embedded`.
>
> Statements elsewhere in this document that say "all 14 pages" about the **stylesheet or the file sweep** are correct — `tokens.css` genuinely is linked by all 14 `.html` files, `login.html` included. Only claims about *navigation* were wrong.

```
◆ Prantivo                      brand mark, --teal-700, 30px, --r-sm
  AI Receptionist               --t-micro, --faint

  ⌂  Home

  YOUR CLINIC
  ▸  Clinic profile
  ▸  Hours & holidays
  ▸  Pricing
  ▸  Doctors
  ▸  Booking rules

  WHAT IT KNOWS
  ▸  FAQs
  ▸  Documents         [Soon]    inert — no page, no href

  HOW IT BEHAVES
  ▸  Receptionist
  ▸  Safety & handoff

  CHECK
  ▸  What it knows               knows.html — see below
  ▸  Test
  ▸  History
  ─────────────────────────      --line
  ◔  Sri Dental Care             clinic name, --t-body-sm
     Owner                       role, --t-help, --muted
```

**`knows.html` belongs under CHECK.** An earlier draft of this diagram omitted it entirely while listing `Documents`, which had it been built as drawn would have orphaned a real, shipped page — the sidebar is `knows.html`'s only inbound link. It sits under CHECK rather than WHAT IT KNOWS for two reasons: it is a read-only summary the owner *inspects* rather than knowledge they *edit*, and in the v1 flat order it already sat immediately adjacent to Test and History. Filing it under WHAT IT KNOWS would also place a group header directly above an item with the identical label.

Groups are labels, not accordions — nothing collapses, because with 12 items collapsing hides more than it helps. **Reserved slot:** a `TODAY` group (Conversations · Appointments · Patients) sits directly beneath Home when Tier 2 ships. Designing the group structure now is what stops Tier 2 forcing an IA rewrite. It is declared and renders nothing while empty (shipped at D2).

Unbuilt items are listed with an inert `Soon` badge rather than hidden — this pattern already exists in `tokens.css` and is correct: an owner who reads the nav learns the product's shape.

**Sidebar footer — clinic name + role.** 28px avatar with the clinic's initials in `--teal-100` / `--teal-800`, the clinic name at `--t-body-sm` weight 600, and the signed-in **role** at `--t-help` `--muted`. Both truncate with ellipsis.

> **Corrected at D2.** This previously read *clinic name + owner email*. **The email is not obtainable.** `GET /portal/api/me` returns `user: { id, role }` and no address (`src/portal/routes.js:171`); surfacing one would require a route change, which D2 was scoped to exclude. Role is the correct identity field for this slot — it is true, it is already on the page, and it preserves the two-line composition. Should an email ever be wanted here, it is a backend change first, not a design change.

**Top bar.** 56px, `--card`, `1px --line` bottom. Left: mobile burger, then a breadcrumb only when nested (History → snapshot). Right, in order: the lifecycle control, the command-palette hint (`⌘K` in `--faint` `--mono`), the account menu.

> **Breadcrumb — reserved, renders nothing today (D2).** The slot exists in the top bar and is shipped hidden, because **no portal view is currently nested.** The one nested view this section names — History → snapshot — is implemented as a **modal**, not a route (see §3.7), so there is no parent to walk back to. The slot is kept rather than deleted so the first genuinely nested screen does not have to re-cut the top bar; it is the same kind of reservation as the empty `TODAY` nav group.

**Lifecycle control.** The most important control in the product, and it is a status object rather than a button:

| State | Presentation | Action |
|---|---|---|
| Draft, checks failing | Neutral badge `Not live` + `N left` count | Opens Home |
| Draft, all material checks passing | **Primary button `Go live`** | Confirmation modal |
| Live | Green badge, pulsing dot, `Live` | Menu: `Pause receptionist` (danger) |
| Paused | Amber badge `Paused` | Menu: `Resume` |

It is the only element in the top bar allowed accent or semantic colour.

**Truth strip** sits below the top bar, above the page header, per §2.9.

**Account menu.** Clinic name, owner email, `Sign out`. No settings, no theme switcher, no help centre until one exists — a menu of dead links is worse than a short menu.

---

### 3.1 Sign in

*Exists: `login.html`. Tier 1.*

The first thing a prospective customer's owner ever sees, and currently the screen most likely to read as internal tooling.

**Layout.** Two panes on ≥900px. Left 46%: `--field` ink ground carrying the product's one idea — the brand mark, a `--t-display` line, and a static rendering of a Telugu exchange in the Verbatim panel's bubble style with its English gloss. No animation, no carousel, no rotating testimonial. Right 54%: `--card`, the form centred at 360px max.

The ink pane is the same surface as the Verbatim panel — the owner meets the product's signature before they sign in, and recognises it afterwards.

**Form.** `Sign in` at `--t-h1`. One `--muted` line: `Manage your clinic's AI receptionist.` Email · password with a show/hide ghost toggle · full-width 44px primary `Sign in`. Beneath, in `--t-help`: `Forgot your password? Contact Prantivo and we'll reset it for you.` — accurate, since v1 reset is operator-assisted. No sign-up link; there is no self-signup, and a link to a page that says "contact us" is a dead end.

**States.** Loading: button to `Signing in…`, both fields read-only, form does not shift. Invalid credentials: one `--red-50` banner above the form, `Email or password is incorrect.` — never which one, and both fields take the error border. Rate-limited (5/15min, existing): `Too many attempts. Try again in 12 minutes.` with a live-counting minute value and the button disabled — the count is the honest version of a lockout. Session expired: an amber banner, `Your session ended. Sign in to continue.` Offline: `Can't reach Prantivo. Check your connection.` with the button held rather than errored.

**Mobile (<900px).** Ink pane drops entirely — not stacked. The form centres with `--s-9` top padding, and the brand mark sits above it on `--bg`. A hero image above a login form on a phone pushes the password field under the keyboard.

**Interaction.** Autofocus email. Enter submits from either field. `autocomplete="email"` / `"current-password"`. Password managers work, which means no JS-intercepted paste. The 300ms constant delay in the existing rate-limit path stays — it reads as deliberate.

**Animation.** The form fades in with a 4px rise over `--dur-2` on first paint, once. Nothing else.

**Accessibility.** `<form>` with a submit button. Error banner `role="alert"`, focus moved to it. The ink pane's Telugu carries `lang="te"`; it is decorative context, so it is `aria-hidden` — the gloss below it is not.

---

### 3.2 Home

*Exists: readiness page. Tier 1. Signature: the readiness ring.*

The owner's answer to two questions: **am I live, and what is left?**

**Layout, top to bottom.**

1. **Greeting row.** `Good morning, Dr Reddy` at `--t-h1`, with the date in `--muted`. Named because the product knows the owner's name and using it is free warmth.
2. **Readiness card** — full width, the one bold element on the screen.
3. **Checks list** — inside the same card, beneath the ring.
4. **Next step card** — a single prescriptive card, appearing only when something is incomplete.
5. **At a glance** — a 3-up stat row. Tier 2; in Tier 1 it is absent, not stubbed with zeros.

**The readiness ring.** 132px, 10px stroke, `--r-full`, `--line-2` track, `--teal-700` progress, round cap. The score numeral sits centred at `--t-display` in tabular figures with the denominator beneath at `--t-help` (`7 of 9`). At 100% the ring turns `--green-700` and a check replaces the numeral.

To its right at `--s-5`: a `--t-h2` state line (`Almost ready` / `Ready to go live` / `Live` / `Paused`), one `--muted` sentence of meaning, and the primary action — `Go live` when eligible, otherwise a secondary link to the first failing check.

Animation: draws 0 → value over `--dur-4` with `--ease-out`, once per session, tracked in `sessionStorage`. Under reduced motion it paints final. This is the product's only orchestrated moment and it is spent here because it is the one screen an owner sees every day.

**Checks list.** One row per check: 20px status icon · friendly label · state word · a right-aligned ghost link to the page that fixes it. Grouped under two `--t-micro` headers, `Needed to go live` and `Handled by Prantivo`. The second group carries the lock badge and no link — the honest presentation of an operator-run check, and it stops the owner hunting for a control that does not exist.

The copy map from portal-v1 §5.1 is binding and unchanged (`kb` → *Add at least 5 FAQs or upload one document*, `numbers/e164` → *Add an escalation phone number*, `turn.scripted` → *Test call — run by Prantivo before go-live*).

**One deliberate correction.** `shell.js:109` currently renders `tenant.legacy_prompt` as `Using the latest instruction format` — affirmative and unconditional, on exactly the tenants where it is warning that the renderer is dormant. Under this spec that check does not appear in the list at all. It surfaces as the **truth strip** (§2.9), because it is not a task the owner can complete and putting it in a checklist implies otherwise. The label is rewritten to state the condition rather than deny it.

**Next step card.** One card, one instruction, one button. `Add your treatment prices` / `Your receptionist can't quote prices until this is filled in. It's the question patients ask most.` / `[Add prices]`. It disappears at 100%.

**Empty state.** A fresh tenant sees the ring at 0 and a full-bleed card instead of the checks list: `Let's set up your receptionist` / `About 40 minutes, and you can stop and come back anytime.` / `[Start setup]` → the wizard. This is the screen that carries the 45-minute acceptance criterion; it must not read as a checklist of failures on day one.

**Loading.** Ring renders as a `--line-2` circle at full stroke; the numeral is a 48×28 skeleton; six check rows skeleton. No spinner.

**Error.** If the validation run fails, the ring renders neutral and the card shows: `Couldn't check your setup` / `Your settings are safe. This is a problem on our side.` / `[Try again]`. The state never guesses — a false green here is worse than an error.

**Mobile.** Ring 104px, centred, state line and action stacked beneath. Check rows keep their fix links as full-row taps. `--s-4` padding.

**Accessibility.** The ring is `role="img"` with `aria-label="7 of 9 checks complete"`. The score is a `status` live region so a screen-reader user hears it update after a save. Each check row states its state in text; the icon is `aria-hidden`.

---

### 3.3 Clinic profile · Hours & holidays · Pricing · Doctors · Booking rules

*"Tenant Settings". All five exist. Tier 1. Verbatim panel present on all five.*

These share a chassis: page header, one or more cards, each card independently saved, Verbatim panel right. Only their distinctive parts are specified.

#### Shared

- No autosave, no optimistic UI. The existing discipline — `Save changes` → `Saving…` → `Saved · v{N}`, with the server's returned value refilled into the form so the owner sees what persisted rather than what they typed — is better than the spec required and is preserved exactly (audit, Preserve-As-Is #5).
- Navigating away from a dirty card opens a 3-button sheet: `Save and leave` / `Leave without saving` / `Stay`.
- Each save refreshes the readiness deltas; a check that just went green flashes its row `--green-50` for 600ms. The only celebratory moment in the product, and it is 600ms of tint.

#### Clinic profile → `identity.*`

Two cards. **Clinic details:** name · address (textarea) · landmark (its own field, with help text `Patients describe your location this way — the receptionist will too`) · website. **Contact & languages:** phone numbers as a repeatable row list with the `+91` prefix input and a `Remove` ghost per row; timezone as a read-only field showing `Asia/Kolkata` with a lock icon and the reason (`India only for now`).

Languages are three toggle rows, not checkboxes — each has a consequence line: `Telugu · Your receptionist speaks and understands Telugu`. Turning off the last enabled language is prevented, with the reason inline rather than a modal.

*Empty:* never — this page is created with the tenant. *Mobile:* single column; phone rows stack the prefix above the number below 360px.

#### Hours & holidays → `hours.*`

**Weekly hours card.** Seven rows: day name (fixed 96px) · closed toggle · open time · en-dash · close time. A closed day dims its time fields to read-only rather than hiding them, so the row heights never jump. A `Copy Monday to all weekdays` ghost button sits above the rows — the single highest-value affordance on this page, because entering fourteen times on a phone is where the 45-minute target dies.

Validation is inline and immediate on blur: `Closing time must be after opening time.`

**Holidays card.** A table: date (tabular) · label · remove. Sorted ascending, past dates dimmed with a `Past` badge and never auto-deleted. `Add a holiday` opens an inline row, not a modal. Duplicate dates are rejected on the field.

*Empty (holidays):* calendar icon · `No holidays added` · `Add the days you're closed so the receptionist doesn't book appointments then.` · `[Add a holiday]`.
*Mobile:* each day becomes a two-line block — day name and toggle on line one, the time pair on line two at full width. Holidays become cards.
*Verbatim:* shows today's hours and the after-hours message in the selected language.

#### Pricing → `pricing.*`

The page whose accuracy the product's promise rests on.

**Standard fees card.** Three fee inputs with the `₹` prefix, integer-only, tabular, right-aligned. Payment methods as checkbox rows. Insurance stance as a select with a conditional note field.

**Treatments table.** Name · price · `starts at` toggle · duration · notes · actions. Right-aligned tabular price column. Cap 50 with a counter appearing at 40. Inline row editing — click a cell, edit in place, Escape reverts, Enter commits to the dirty state; the card's single Save persists all of it. A modal per treatment would make entering twenty treatments unbearable.

**Archive, never delete** (referenced by history). The row action is `Archive`; archived rows collapse under a `Show 4 archived` disclosure at the table foot, dimmed with an `Archived` badge and an `Unarchive` action.

**A permanent inset card at the page foot** — read-only, `--bg`, lock icon:
> **How your receptionist quotes prices.** It reads these prices out exactly as written. For anything not listed here it says "I'll check and get back to you" rather than guessing. It never negotiates or offers a discount.

This is a platform invariant presented as a trust feature (portal-v1 §5.10's pattern applied to pricing), and it is the single most reassuring paragraph in the product for a clinic owner deciding whether to let software quote their fees.

*Empty (treatments):* rupee icon · `No treatments listed` · `Add the treatments patients ask about most. The receptionist quotes these prices exactly.` · `[Add a treatment]`.
*Mobile:* the table becomes cards — treatment name at `--t-h3`, price at `--t-h2` right-aligned, duration and `starts at` as meta. Editing opens a bottom sheet, because inline cell editing on a phone is not viable.
*Verbatim:* the fee list, live, with a warning for any treatment missing a price.

> **Deviation, deliberate, recorded at D5b (`bfdce87`). Pricing keeps INLINE editing on mobile — no bottom sheet.**
>
> The card form ships as specified above: name at `--t-h3`, price at `--t-h2` right-aligned and tabular, duration and *starts at* as `--muted` meta. **Only the bottom sheet was not built**, and the sheet's own rationale is why.
>
> "Inline cell editing on a phone is not viable" describes **click-a-cell-in-a-grid** — the interaction the *Treatments table* paragraph above specifies for desktop, where a cell is a small target inside a wide row and editing in place on a 360px screen would be genuinely unusable. **This page never shipped that interaction.** `PORTAL-P2-S6` built full-width stacked inputs on purpose and wrote the reason at the top of `pricing.css` (`pricing.css:9-11`); the deviation is therefore against a premise this spec assumed, not against a decision the page made.
>
> The consequence is that the sheet would contain the same five stacked inputs the card already shows — a chrome change around an identical interaction, for which the owner pays an extra tap to open and an extra tap to dismiss. It also carried the only real risk in D5b's mobile pass: moving those inputs into a sheet is the one way that session could have disturbed the card's dirty mechanism, which was a STOP condition.
>
> **This does not reverse the spec's rule for grids.** Any future Tier-1 page that ships a genuine cell grid on mobile takes the sheet. Full findings at `docs/specs/portal-v2-batch1.md` §3 (D5b).

#### Doctors

Card-grid rather than a table: one card per doctor, 2-up on desktop, 1-up below 900px. Avatar initial in a `--teal-50` circle · name `--t-h3` · specialisation `--muted` · language chips · a compact weekly availability strip (seven 24px cells, `--teal-100` where available, `--line-2` where not, day initial beneath) · leave dates as a count with a disclosure · `Edit` and `Remove` ghost actions.

The availability strip is what makes this page scannable: a five-doctor clinic sees its whole week at once.

Editing opens a full-page sub-view (not a modal — the weekly grid is too large): name, specialisation, languages, a 7-row schedule grid with the same `Copy to all weekdays` affordance, and leave dates.

Deleting a doctor with future appointments requires typing the doctor's name, and the modal names the count: `4 upcoming appointments are booked with Dr Sharma. Removing them here doesn't cancel those appointments.`

*Empty:* `No doctors added` · `Patients can't book until at least one doctor has weekly hours set.` · `[Add a doctor]`.
*Mobile:* full-width cards; the availability strip stays, at 7×20px.

#### Booking rules → `booking.*`

**Do not ship this page before F-006 lands.** The audit found `advance_days`, `buffer_minutes`, `allow_same_day` and hours/holidays are editable and validated but **not enforced** in booking. A settings page that does not change behaviour is the same defect class as F-F001 and it is the exact thing this redesign exists to eliminate. If F-006 has not landed when this page is scheduled, it ships behind the `receptionist.html:99` gap-notice pattern, stating plainly which controls are not yet connected.

**Slot rules card:** slot length as a 4-option segmented control · advance days as a number input with a live consequence line (`Patients can book up to 30 days ahead — until 27 August`) · same-day toggle · buffer minutes.

**Policies card:** three textareas — cancellation, reschedule, walk-in — each with the same help text: `The receptionist reads this out when asked. Write it as you'd say it.` These are facts stated, not logic, and the copy must make that unambiguous.

*Verbatim:* shows the policy texts in the selected language, which is where an owner discovers their cancellation policy sounds wrong when spoken.

---

### 3.4 Receptionist · Safety & handoff

*"AI Settings". Both exist. Tier 1. The Verbatim panel matters most here.*

#### Receptionist → `persona.*`, `voice.*`

**How it introduces itself card.** Display name, with help text that names the constraint precisely: `Used only when the receptionist introduces itself — it never uses this to address patients.`

**Greeting card.** One field per enabled language, each in the vernacular type scale with a native-script placeholder, `lang` set, and a live 3-line English gloss beneath the Telugu and Hindi fields. Editing any greeting updates the Verbatim panel instantly.

**Manner card.** Tone as a 2-option segmented control with a consequence line under each. Response length as a segmented control. Speaking pace as a slider, 0.8–1.2, with `Slower` / `Normal` / `Faster` anchors and the numeric value in tabular figures — a bare slider from 0.8 to 1.2 means nothing to a clinic owner.

**Voice card.** The bounded Sarvam bulbul:v3 speaker list as radio rows: name, a one-word character descriptor, a `▸ Hear` ghost button. No provider selection — that is an architecture invariant, not a setting, and it is not shown as a disabled control either, because a disabled control implies it will one day be enabled.

**The gap notice stays.** `receptionist.html:99`'s existing copy — *"These settings are saved to your account, but Prantivo hasn't finished connecting them to live phone calls yet…"* — is preserved verbatim, restyled as the standard amber inset. The audit marks it Preserve-As-Is #4 and it is the voice this whole product should use about its own limits.

#### Safety & handoff → `escalation.*`, `handoff.*`

**Escalation numbers card.** Repeatable `+91` rows with a role label per row (`Reception`, `Dr Reddy`, `Emergency`). Ordered, with drag handles — the order is the order they are tried, and that must be visible.

**When to hand off card.** Three toggle rows, each with a consequence line, plus a bounded number stepper for `unsure after N turns`.

**Emergency guidance card.** Textarea, per enabled language, with the strongest help text in the product: `Read out when a patient describes an emergency. Keep it to one or two sentences.`

**Built-in protections card.** Read-only inset, always visible, four rows with check icons:
> Never invents a price · Never invents a patient's name · Says "I'll check and get back to you" when it isn't sure · Answers only from information you've approved

Presented as trust features, never configurable (INV-3). This is the highest-conversion block in the whole portal and it should be the last thing on the page, where the owner leaves the section on it.

*Empty (escalation):* `No escalation number yet` · `When the receptionist can't help, it needs somewhere to transfer the call.` · `[Add a number]`. This is a material check, so the empty state is amber-tinted rather than neutral.
*Errors:* a phone number failing `normalizePhone` shows inline: `That doesn't look like an Indian mobile number. Try 10 digits, or +91 followed by 10 digits.` — names the fix (INV-6, never silently rewritten).
*Mobile:* drag handles become up/down arrow buttons; drag ordering on a phone inside a scrolling page is unreliable.

---

### 3.5 FAQs · Documents

*"Knowledge Base". Both exist. Tier 1.*

#### FAQs → `knowledge_chunks (source:'faq')`

Not a table — a stacked list of collapsible Q/A rows. Collapsed: question at `--t-body` weight 500, a language chip, a `--muted` truncated answer preview, and hover actions. Expanded: the answer as an editable textarea, a language select, `Save changes` and `Delete`.

One row is expanded at a time. Adding opens a new expanded row at the top, focused on the question field.

A `--muted` line above the list: `Your receptionist answers from these. Keep answers short and factual.` Counter `12 of 100` in tabular figures at the list foot, turning amber at 90.

Search appears above 15 FAQs. Filter by language appears when more than one is in use.

**Editing re-embeds.** The save state reads `Saved · updating what it knows…` for the embedding window, then `Saved`. Hiding a real latency behind an instant success message is the same lie as F-F001 at smaller scale.

*Empty:* book icon · `No FAQs yet` · `Add at least 5 so your receptionist can answer common questions. Start with what patients ask on every call.` · `[Add your first FAQ]` · and beneath, four suggested starter questions as one-tap chips (*Do you take walk-ins? · Where do I park? · Do you accept insurance? · Is the first consultation free?*). A cold-start suggestion is the difference between five FAQs and zero.

#### Documents → `knowledge_chunks (source:'document')`

A drop zone (`--bg`, dashed `--line`, `--r-md`, `--s-8` padding) above a table: filename with a type icon · size · pages · uploaded date · status badge · remove.

**Status is a real state machine, shown honestly:** `Uploading` (determinate bar) → `Reading` (indeterminate, `--muted`) → `Ready` (green) → `Couldn't read` (red, with the reason: `This PDF is a scan. The receptionist can only read PDFs with selectable text.`).

The placement guidance from portal-v1 §5.8 sits as a permanent inset: `Exact facts — prices, hours, doctors — belong in their own pages. Documents are for everything else: care instructions, policies, procedure information.`

*Empty:* the drop zone is the empty state. `Drop a PDF here, or browse` · `Up to 10 MB. Care instructions, policies, procedure guides.`
*Errors:* oversize and wrong-type rejected before upload with the limit named. Extraction failure keeps the row so the owner can retry or remove.
*Mobile:* the drop zone becomes a `Choose a file` button; the table becomes cards.

**If PDF extraction is deferred** (portal-v1 §5.8 allows shipping FAQ-only), this page is not shown as an empty shell. The nav item carries `Soon`, and the FAQs page carries one line: `Uploading documents is coming soon. For now, add anything patients ask about as an FAQ.`

---

### 3.6 Test

*Exists. Tier 1. The most persuasive screen in the product.*

**Layout.** Two columns on ≥1024px: a chat column at 560px and the Verbatim panel. The chat column uses the ink ground — this is the second and last place `--field` appears, and it is the same surface as the panel, so the two read as one continuous idea.

**Chat.** Owner messages right-aligned in a `--teal-800` bubble; receptionist messages left in `--field-2`. Vernacular in the vernacular scale with `lang`, and an English gloss beneath every non-English reply. Typing indicator: three 4px dots at 1.2s. Composer fixed at the bottom with a language selector.

**Provenance line.** Beneath each receptionist reply, `--t-help` in `--field-muted`, collapsed to one line and expandable:

> `v12 · looked up availability · used 2 FAQs · 1.4s`

Expanded, it names the FAQs used and the tools called. This line is the product proving it did what it claims — and it is a straight lift from `turn_traces` that portal-v1 §5.11 already specifies. No other product in this category shows an owner why the answer was what it was.

**Rate limit.** `18 of 20 test messages left today` in `--muted` above the composer, amber at 3, and at 0 the composer is replaced by: `You've used today's test messages. They reset at midnight.` — never silent failure.

*Empty:* the ink column with the greeting already rendered as the receptionist's first message, and three tappable starter prompts drawn from the clinic's own data (`What does a cleaning cost?` · `Are you open on Sunday?` · `Can I see Dr Reddy tomorrow?`). The owner's first test should require zero typing.

*Blocked state:* if config has never been saved, the composer is disabled with the reason adjacent: `Save your clinic details first — the test uses your real settings.` and a link to Clinic profile. This replaces `test.js:68`'s `'No saved config yet'`, the one string the audit flagged as describing emptiness without inviting the fix.

*Errors:* a failed turn renders as a receptionist-side `--red` bubble: `Couldn't get a reply. Your settings are unchanged.` with `Try again`. On a free-tier Gemini quota error, the honest message: `Prantivo's testing limit was reached. This doesn't affect your live receptionist.`

*Mobile:* chat full-height, composer fixed above the keyboard, Verbatim panel as a sheet. Provenance collapsed by default.

**Accessibility.** `role="log"` with `aria-live="polite"` on the transcript. `lang` on every vernacular bubble. The provenance line is a real `<details>`.

---

### 3.7 History

*Exists. Tier 1. No Verbatim panel.*

A table: timestamp (tabular, relative under 24h) · section · changed by · version (`--mono`) · `View`. Grouped under sticky date headers (`Today`, `Yesterday`, `12 Aug 2026`).

Clicking opens a **snapshot view** — a full-page sub-view, not a modal, showing the section's values at that version as read-only fields in the same layout as the live page, so the owner is reading a form they recognise rather than JSON. A diff toggle marks changed fields with a `--amber-200` left bar and the previous value beneath in `--muted` strikethrough.

> **UNRESOLVED DIVERGENCE — spec vs product (recorded at D2).**
>
> | | |
> |---|---|
> | **This spec describes** | a full-page sub-view, explicitly *"not a modal"* |
> | **The product ships** | a **modal** (`PORTAL-P6-S17`, the first user of the shared `.modal` component in `tokens.css`) |
>
> Neither has been chosen yet, and **D2 did not resolve it** — D2 was presentation-only and touched no routes. The divergence has one consequence beyond History itself: the breadcrumb slot in §3.0 stays empty for exactly as long as this stays a modal, because a modal has no route to be nested under.
>
> **Deferred to D5 or later.** Whoever picks it up decides one of:
> 1. Move the product to a full-page sub-view, which needs a route and activates the breadcrumb; or
> 2. Amend this spec to accept the modal, and record the breadcrumb slot as reserved for something else.
>
> Do not treat the modal as a defect until that choice is made.

**Restore** is a primary button in the snapshot view, confirmed in a modal: `Restore this version?` / `This creates a new version with these values. Nothing is deleted — you can undo it the same way.` History is never rewritten (portal-v1 §5.12) and the copy must make the owner confident of that before they press it.

*Empty:* `No changes yet` · `Every edit you make is recorded here, and you can go back to any earlier version.` — reassurance, not a task.
*Mobile:* rows become cards, `View` as a full-row tap.

---

### 3.8 Onboarding wizard and Go live

*Exists (P6-S16). Tier 1. Carries the 45-minute acceptance criterion.*

The wizard embeds each page's card in an iframe with its own chrome — a mechanism already built and working (`shell.js` detects `window.self !== window.top`). The redesign changes only the chrome.

**Chrome.** Full-bleed, no sidebar. Top: a segmented progress bar of 8 steps, completed segments `--teal-700`, current `--teal-100`, remaining `--line-2`, with `Step 3 of 8` in `--t-micro`. A stepper dot rail is unreadable at 380px; a segmented bar is not.

Each step: `--t-h1` title · one `--muted` sentence of purpose · the embedded card · a footer with `Back` ghost, `Skip for now` ghost (only where not material), and `Continue` primary.

**Exit is always available** and always safe: `Save and finish later` in the top right, with the state persisted to `meta.onboarding_step`. An owner who cannot leave a wizard abandons the product rather than the wizard.

**Review step.** The readiness ring at full size, the checks list, and a `Go live` primary — the only place the ring appears outside Home.

**Go live modal.** `Go live?` / `Your receptionist starts answering calls and WhatsApp messages straight away. You can pause it at any time.` / `[Go live]` primary, `[Not yet]` ghost.

**On success** — the one moment the product is allowed to be pleased: the ring completes to green, the badge transitions to `Live` with its pulsing dot, and a single card appears: `You're live.` / `Call your clinic number to hear it answer.` / `[Done]`. No confetti. A clinic owner has just handed patient calls to software; the correct register is confidence, not celebration.

**Pause.** Danger-styled, confirmed: `Pause the receptionist?` / `Calls and messages won't be answered until you resume.` The badge goes amber and the truth strip appears.

*Mobile:* identical, single column, `Continue` in the sticky bar. This is the primary target for this flow.

---

### 3.9 Conversations · Appointments · Patients

*Tier 2 — after G-PROOF. Specified at layout depth so the IA reserves room. Not scheduled.*

These three become real only when production traffic exists. Designed against fixtures they will be designed wrong, and the DEMO-01 unified-thread surface already establishes the correct pattern.

#### Conversations

Two panes: a 320px list and a thread. **Channel-unified, patient-keyed** — one patient, one thread, voice and WhatsApp interleaved in time. That unification is the product's structural advantage and it must be the layout, not a filter.

List rows: patient name (or `+91 98••• ••234` when unknown) · channel icon · last-message preview · relative time · unread dot. Filters: All / Calls / WhatsApp / Needs attention.

Thread: call turns as transcript blocks with a duration and a play control; WhatsApp as bubbles; **a pinned outcome card at the top** when an appointment was booked. Vernacular with `lang` and an English gloss throughout. A right rail carries patient details, past appointments, and a `Take over` handoff control.

*Empty:* `No conversations yet` · `They'll appear here as soon as your receptionist takes its first call.`
*Mobile:* list and thread as separate views with a back affordance.

#### Appointments

Default to **Day**, with Week and List. A day column per doctor, 15-minute rows, appointment blocks in `--teal-100` with a `--teal-700` left bar, patient name and treatment. Now-line in `--red-500`. Status by border, not fill: confirmed solid, tentative dashed, cancelled struck and dimmed.

*Empty:* the grid drawn with its hour labels, and one centred line — the shape of the answer is legible before the answer exists.
*Mobile:* Day only, single doctor with a selector, vertical list.

#### Patients

Not a CRM. A patient list with search: name · phone · last visit · appointment count · last channel. Detail view: contact, timeline of every conversation and appointment, notes.

**Explicitly excluded:** lead stages, pipelines, deal values, custom fields, tags, segments, bulk email. Those belong to the shelved platform framing. A clinic owner needs to find a patient and see their history — nothing else. The `crm_*` tables support more; the portal exposes this.

---

### 3.10 Activity · Connections · Plan & billing · People

*Tier 3 — after G-PAY. Layout depth only.*

#### Activity ("Analytics")

Explicitly excluded from portal v1 (§9) and correctly so. Four numbers an owner actually acts on, not a dashboard:

`Calls answered` · `Appointments booked` · `Transferred to you` · `Missed`, each a stat card with a period-over-period delta and a 60px sparkline. Beneath: one bar chart of calls by hour of day (which is the number that changes staffing decisions), and one list of the ten most-asked questions with no good answer — the only analytic in the product that generates a task, since each row links to creating an FAQ.

Period selector: 7 / 30 / 90 days. No custom ranges, no cohorts, no funnels, no exports until asked for by name.

*Empty:* axes drawn, `No calls yet this week`.

#### Connections ("Integrations")

**Not a marketplace. A status page.** Three rows — Phone, WhatsApp, Calendar (`Soon`) — each with a status badge, the connected identifier, and either a detail link or the honest operator line: `Prantivo sets this up for you. We'll email when it's connected.`

Self-serve connection is gated on G-PAY and on the Meta Tech-Provider path, neither of which exists. An integrations directory before either is fiction.

#### Plan & billing

G-PAY gated: no clinic has paid, so every element here is designed against an imagined transaction. Shape when it exists: current plan card with the included usage · usage bars for calls and messages against the plan limit · payment method · invoice table with download. Indian requirements are non-negotiable and must be designed in from the first version, not retrofitted: GSTIN on the invoice, INR only, UPI as a first-class payment method rather than a fallback.

#### People ("User Management")

Explicitly excluded from portal v1 (§9) — single owner role. When staff roles arrive: a member table (name, email, role, last active), an invite flow, and **two roles only**, `Owner` and `Staff`, with a plain-language capability list rather than a permission matrix. A permission matrix for a five-person clinic is enterprise cosplay.

---

### 3.11 Workflow Builder — refused

Not designed. A visual rules engine — *when X happens, do Y* — converts the AI Receptionist into an automation platform, which is the retired "AI Operating System for Businesses" framing under a different noun. `ZYON_V2_SPEC.md` §3 defines `workflows` as a backend module; that is where it stays.

It also fails on its own terms. A clinic owner who cannot reliably enter fourteen opening times on a phone will not author conditional logic, and every workflow they do author becomes a support liability with patient-facing consequences.

**What to build instead, when asked.** The three automations a clinic actually wants — appointment reminders, a no-show follow-up, a post-visit message — are three toggles with a timing input and an editable message template, on the Booking rules page. Each is one card. If three separate clinics ask for the same fourth automation, it becomes a fourth card. That is the standing rule: configuration for one clinic is configuration, not a platform feature, until three clinics ask for the same thing.

---

## 4. Cross-cutting rules

### 4.1 Voice and copy

The copy rules in portal-v1 §4 are binding and unchanged. Restated as design constraints because copy is the material that most determines whether this reads as premium:

- **Active voice. Sentence case. No filler.** `Save changes`, not `Submit`. `Add a doctor`, not `Create new doctor record`.
- **An action keeps its name through the flow.** `Save changes` → `Saving…` → `Saved`. The audit verified this holds across all ten writing pages; it is preserved.
- **Name things by what the owner controls, never how the system is built.** `Escalation phone number added`, not `numbers.e164`. `shell.js:85-109` already does this correctly for every check and is the model.
- **Errors name the fix and do not apologise.** `Closing time must be after opening time.` Not `Sorry, invalid input.`
- **Empty states invite an action and name the consequence of not acting.** `Patients can't book until at least one doctor has weekly hours set.`
- **Consequence over mechanism in help text.** `Patients hear this before anything else`, not `Maximum 200 characters`.
- **The product is the AI Receptionist.** "AI Employee" and "AI Operating System" appear nowhere. The audit confirms both are currently absent from every surface; nothing here reintroduces them.
- **Never claim a capability that is not connected.** The `receptionist.html:99` gap notice is the template for every unfinished seam.

### 4.2 Numbers, dates, and the vernacular

Restated because these are where an interface either reads as built-for-India or as translated-into-India:

- `₹` with no space, integers, Indian digit grouping (`₹1,50,000`).
- Tabular figures in every column of numbers.
- 12-hour time, lowercase meridiem, en-dash ranges.
- Telugu and Devanagari always at the vernacular type scale with `lang` set, never at Latin's optical size.
- A vernacular field never carries an English placeholder.
- Every vernacular string shown to the owner carries an English gloss where the owner may not read that script.

### 4.3 What may not be touched

Carried from the audit's Preserve As-Is list. Any session executing this spec that finds itself editing one of these has left scope:

1. `public/{demo,portal}/fonts/fonts.css` and the six `.woff2` faces — generated, `unicode-range`-scoped, self-hosted, zero external requests. Do not move to a CDN. Do not deduplicate the two copies in a way that reintroduces a build step.
2. The `lang="te"` pattern at `public/demo/app.js:105`.
3. `tokens.css` as a real single shared stylesheet loaded by all 14 pages.
4. The `receptionist.html:99` gap-notice copy.
5. The `Save changes` → `Saving…` → `Saved` discipline, including refilling the server's returned value into the form.
6. The four-layer error ladder (401-redirect / field errors / server message / generic fallback).
7. The unknown-validation-check default at `shell.js:111-117`.
8. Zero fixed widths ≥380px across every surface. This redesign must not introduce the first one.

---

## 5. Sequencing

Under the OS's one-issue-per-session rule, with `tests N / fail 0` plus a screenshot as the only valid completion evidence for a UI session.

### Tier 1 — 5 sessions, no backend work

| # | Session | Scope | Done when |
|---|---|---|---|
| D1 | **Tokens and type** | Self-host Noto Sans Latin through the existing font pipeline; complete the teal ramp; add `--field*`; retune radius and elevation; global reduced-motion block. Token values only — no markup. | Suite green. Screenshots of 3 pages before/after at 1440 and 380. **Closes F-F008.** |
| D2 | **Chrome** | Sidebar grouping, top bar, lifecycle control, page header, command palette. | Every page's nav renders grouped; `⌘K` opens and navigates; screenshots. |
| D3 | **Truth strip and states** | The truth strip component wired to the four conditions including `tenant.legacy_prompt`; the empty/loading/error sweep across all 14 pages. | **Closes F-F001.** A tenant with a legacy prompt set shows the amber strip — screenshot proof required. |
| D4 | **Verbatim panel** | The signature. Docked, rail, and sheet forms over the existing prompt-preview endpoint. `Hear it` ships disabled with its reason. | Telugu renders at the display scale with the English gloss, on a real tenant, at 1440 / 1024 / 380. |
| D5 | **Component sweep** | Buttons, inputs, cards, tables, badges, toasts, modals to spec across all pages; the table→card mobile pass. | Screenshots of all 14 pages at 1440 and 380. Zero horizontal scroll at 320px. |

**Prerequisite for D3:** the `shell.js:109` label rewrite is a copy change and lands in the same session as the strip. Do not lift the `material: false` suppression without the strip in place, or the ring gains a check the owner cannot action.

### Tier 2 — after G-PROOF, 6–8 sessions

Conversations, Appointments, Patients. Designed against production traffic, not fixtures. The first of these is worth building the week after the first live call, not before.

### Tier 3 — after G-PAY, 4–5 sessions

Activity, Connections, Plan & billing, People.

### The honest recommendation

**Fund D1 and D3. Hold D2, D4, D5 until a demo shows they are needed.**

D1 is 4 hours, closes a filed finding, fixes a stated untruth in the typography, and is most of the perceived quality gain. D3 closes an S1 defect where the product tells an owner something false. Both are defensible as correctness work, which is the only category of portal work that survives the G-PROOF gate cleanly.

D2, D4 and D5 are the actual redesign, and they are H5. They are also cheap, and the Verbatim panel is genuinely the thing that would make a clinic owner in a demo say *it speaks Telugu* rather than *it looks like software*. But that value is only realised in front of a prospect, and prospects require a working phone number, which requires the clocks. The order that maximises the chance this work matters is: **clocks → D1 → D3 → first live call → D4 → the rest.**

---

## 6. Decisions this document needs from the founder

Five. Each blocks a session.

1. **The brand accent.** §2.2 decides teal, as one ramp with a light-ground step (`--teal-700`) and an ink-ground step (`--teal-500`). This is the founder call F-F008 explicitly excluded from its own estimate. Confirm or overrule; either way it needs a line in `decisions.md`.
2. **The typeface.** §2.3 chooses Noto Sans across all three scripts over self-hosting Inter. It costs one pipeline invocation and about 90KB. The alternative is dropping the false `'Inter'` declaration and owning `system-ui` honestly, which is free and worse. Choose.
3. **The Verbatim panel.** The one part of this spec that needs new markup rather than new token values, and the one bold element. It is a session on its own. Approve or cut — a half-built version is worse than none.
4. **Workflow Builder.** §3.11 refuses it. If it is being reinstated, that is a positioning change and needs an override with a prediction, not a design session.
5. **Whether any of this is scheduled at all.** The displacement check returns *closes no gate, advances no clock*. Tier 1 needs an override in `docs/os/decisions.md` with a review date and a falsifiable prediction. The only honest prediction available: *the next three clinic owners shown the portal do not ask whether the product is finished.*

---

## 7. What would make this specification wrong

Stated so it can be checked rather than assumed.

- **If the first ten clinic owners never open the portal.** The distribution model is channel-based, through dental supply distributors, with manual onboarding of customer #1 and supervised monitoring. If the realistic path is that Prantivo configures every clinic for the first year, the portal is an internal tool with one user, and every hour of this document is misspent. **Cheapest test:** at the first three clinic conversations, ask whether they want to change their own prices or have someone do it. Two of three saying "you do it" kills Tier 1 down to D1 and D3.
- **If Telugu renders badly on the owner's actual device.** The audit is explicit that real glyph rendering cannot be verified from source and is owed to a session with a running render on a real device after Issue 20. The Verbatim panel makes vernacular rendering the most prominent element in the product, which is an asset if the faces are right and a liability if they are not. **Test before D4, not after.**
- **If owners configure on desktop, not mobile.** The 45-minute-on-a-phone criterion drives the sticky save bar, the table→card conversions, and the sheet form of the panel. If clinic owners in fact sit at a reception computer, that effort is misallocated. Observable at the first onboarding.
- **If the product's centre of gravity moves from configuration to monitoring.** Tier 2's Conversations page would then be the real product and the config pages become setup. The IA reserves the `TODAY` group for exactly this, so the correction costs a nav change rather than a rewrite.

---

## Appendix — token summary

| Group | Tokens |
|---|---|
| Ground / ink | `--bg` `--card` `--ink` `--ink-2` `--muted` `--faint` `--line` `--line-2` |
| Ink field *(new)* | `--field` `--field-2` `--field-line` `--field-ink` `--field-muted` |
| Accent | `--teal-50`…`--teal-900` · `--accent` · `--accent-on-field` *(new steps)* |
| Semantic | `--green-50/200/700` `--amber-50/200/700` `--red-50/200/500/700` |
| Type | `--sans` `--te` `--hi` `--mono` · `--t-display` `--t-h1` `--t-h2` `--t-h3` `--t-body` `--t-body-sm` `--t-label` `--t-help` `--t-micro` |
| Space | `--s-1`…`--s-9` *(7 and 8 new)* |
| Radius | `--r-xs` `--r-sm` `--r-md` `--r-lg` `--r-full` *(aliased from existing names)* |
| Elevation | `--shadow-sm` `--shadow-md` `--shadow-lg` `--shadow-field` |
| Motion | `--dur-1`…`--dur-4` · `--ease-out` `--ease-in-out` `--ease-linear` |
| Layout | `--sidebar-w` 232 · `--content-max` 760 · `--panel-w` 360 *(new)* |

Nothing is renamed. Every existing custom property either keeps its value or is aliased to a new one, so no existing declaration in any of the 15 portal stylesheets breaks.

Per the audit's proposed remedy, these values belong in `docs/design/brand-values.md` with a `tests/design/tokenDrift.test.js` asserting them across the four stylesheets. That test is what stops this document decaying into a fifth source of truth — which is the failure mode it exists to fix.
