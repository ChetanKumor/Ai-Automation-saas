# Brand values — the canonical token table

**Guarded by** `tests/design/tokenDrift.test.js`. That test parses this file and
the four stylesheets below and fails if they disagree. Editing a value in one
stylesheet without editing this table is a failing test, not a silent drift.

Four surfaces declare their own `:root`. None imports another's — that is
deliberate (`tokens.css:4-9`), and it is also exactly how a fifth source of
truth appears without anyone noticing. This table is the record that says which
shared values are the *same on purpose* and which differ *on purpose*.

| Key | File |
|---|---|
| `portal` | `public/portal/tokens.css` |
| `demo/shared` | `public/demo/shared.css` |
| `demo/styles` | `public/demo/styles.css` |
| `web` | `web/app/globals.css` |

The canonical value is the portal's. The portal is where the v2 design system
(`docs/design/portal-v2-spec.md`) is implemented first; the other three follow
or record why they do not.

Comparison is on normalised values — case-folded, whitespace-collapsed, and
`0.5` treated as `.5` — so `cubic-bezier(0.16, 1, 0.3, 1)` and
`cubic-bezier(.16, 1, .3, 1)` are the same value, not a divergence.

---

## Canonical values

Every custom property declared by more than one surface. A property on exactly
one surface is that surface's private business and is not listed.

The portal's value is the one the **browser** resolves. That used to be a
warning rather than a truism. `public/portal/tokens.css` declared `:root` three
times — a base block, a five-token override pass 160 lines below it (`--bg`,
`--line`, `--line-2`, `--r-md`, `--r-lg`), and `--save-bar-h` alone near the
bottom — and at equal specificity the last declaration wins, so five rows in
this table recorded the **shadowed** value for as long as the guard's parser
could see only the first block. The document and the parser shared one blind
spot, so they agreed with each other and neither agreed with the browser.

The values were corrected on 2026-08-29 and the blocks were collapsed into one
on 2026-08-30, so a token now reads in that file as what it resolves to. The
collapse moved no value: every token kept the value the browser was already
using, which is why not one number in the tables below changed with it.
`tests/design/tokenDrift.test.js` pins the block count at 1 in every surface,
so the shadowing cannot come back without reddening the suite.

| Token | Canonical value | Surfaces |
|---|---|---|
| `--accent` | `#0f766e` | portal, web |
| `--amber` | `#b45309` | portal, demo/shared |
| `--amber-050` | `#fffbeb` | portal, demo/shared |
| `--amber-100` | `#fef3c7` | portal, demo/shared |
| `--amber-200` | `#fde68a` | portal, demo/shared |
| `--bg` | `#faf8f5` | portal, demo/shared, demo/styles |
| `--card` | `#ffffff` | portal, demo/shared, demo/styles |
| `--ease-out` | `cubic-bezier(.16, 1, .3, 1)` | portal, web |
| `--green` | `#16a34a` | portal, demo/shared, demo/styles |
| `--green-050` | `#f0fdf4` | portal, demo/shared, demo/styles |
| `--green-100` | `#dcfce7` | portal, demo/shared, demo/styles |
| `--green-700` | `#15803d` | portal, demo/shared, demo/styles |
| `--hi` | `'Noto Sans Devanagari', 'Noto Sans', system-ui, sans-serif` | portal, demo/shared, demo/styles |
| `--ink` | `#17150F` | portal, demo/shared, demo/styles |
| `--ink-2` | `#57524A` | portal, demo/shared, demo/styles |
| `--line` | `rgba(23, 21, 15, .08)` | portal, demo/shared, demo/styles |
| `--muted` | `#57524A` | portal, demo/shared, demo/styles |
| `--r-lg` | `12px` | portal, web |
| `--r-md` | `8px` | portal, web |
| `--r-sm` | `6px` | portal, web |
| `--radius` | `8px` | portal, demo/shared, demo/styles |
| `--radius-sm` | `6px` | portal, demo/shared, demo/styles |
| `--sans` | `'Noto Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | portal, demo/shared, demo/styles |
| `--shadow` | `0 2px 4px rgba(23, 21, 15, .05), 0 8px 20px rgba(23, 21, 15, .08)` | portal, demo/shared, demo/styles |
| `--shadow-sm` | `0 1px 2px rgba(23, 21, 15, .06)` | portal, demo/shared, demo/styles |
| `--te` | `'Noto Sans Telugu', 'Noto Sans', system-ui, sans-serif` | portal, demo/shared, demo/styles |
| `--teal` | `#0f766e` | portal, demo/shared, demo/styles |
| `--teal-050` | `#f0fdfa` | portal, demo/shared, demo/styles |
| `--teal-100` | `#ccfbf1` | portal, demo/shared, demo/styles |
| `--teal-700` | `#0f766e` | portal, demo/shared |

---

## Recorded divergences

A surface listed here deliberately does not carry the canonical value. Each row
is a decision. The test asserts the *recorded* value too, so a stale note fails
just as loudly as an undocumented change.

| Token | Surface | Value | Why |
|---|---|---|---|
| `--bg` | demo/shared | `#eef2f6` | The divergence is now a different one, and larger. It used to be a lightness argument on a shared cool axis — the portal a hair lighter than the demo so its white sidebar and cards read as calm rather than boxed-in (PORTAL-P1-S2's `#f6f8fa`, carried to `#f7f8fb` by the enterprise polish pass). S3b moved the portal off that axis entirely: `#faf8f5` is warm paper, the same value as `web/`'s `--ground`, per D-016. The demo is a frozen sales surface and stays cool. The two grounds are no longer steps of one scale; they are two scales, and only the portal's is the product's. |
| `--bg` | demo/styles | `#eef2f6` | Same as above — the demo pair share a ground, and stay cool while the portal flips to warm paper. |
| `--ink` | demo/shared | `#0f172a` | S3c-1 re-derived the portal's ink for the paper ground and took `web/`'s values verbatim (`--ink-strong`, `globals.css:263`) rather than mixing a new warm near-black — a fourth source of truth is the defect this table exists to prevent. Slate on warm paper was the last cool thing left after S3b flipped the ground and S3b-2 re-hued the shadows. The demo pair are a frozen cool sales surface and were not migrated. |
| `--ink` | demo/styles | `#0f172a` | Same reason as `demo/shared`: the demo pair share one ink scale and stay on the cool axis the portal left at S3b. |
| `--ink-2` | demo/shared | `#334155` | The portal's secondary is now `web/`'s `--ink-soft` (`globals.css:264`) and carries a load it did not before: S3c-1 collapsed four text steps to two, so `--ink-2` is the ONLY quiet glyph colour on the light ground. It is measured at 7.31:1 on `--bg` and 6.22:1 at its worst backdrop. The demo keeps the cool slate secondary of a three-step scale it still has. |
| `--ink-2` | demo/styles | `#334155` | Same reason as `demo/shared`: the demo pair keep the pre-collapse cool scale. |
| `--muted` | demo/shared | `#64748b` | Not a hue divergence — a STRUCTURAL one. On the portal `--muted` is no longer a step at all; it is a deprecated alias resolving to `--ink-2`, because `#64748b` measured 4.49:1 on `--bg` and 4.23:1 on `--line-2` and so failed AA on the app's own ground. The same collapse `web/` made at D-016 (`--text-secondary` and `--text-tertiary` both alias `--ink-soft`, `globals.css:99-100`). The demo still declares it as a real third step. |
| `--muted` | demo/styles | `#64748b` | Same reason as `demo/shared`: the demo pair still carry `--muted` as a real step rather than an alias. |
| `--line` | demo/shared | `#e2e8f0` | The demo keeps an opaque cool hairline. The portal's is no longer opaque at all: S3b took `web/`'s `--rule`, `rgba(23, 21, 15, .08)`, so one composite serves all five of the portal's light grounds instead of one hex tuned to a single ground. That costs weight — `#dbe3eb` was 1.296:1 on `--card` and the composite is 1.178:1 — and the cost was accepted to keep the value shared rather than merely similar. The demo is a frozen sales surface and was not migrated. |
| `--line` | demo/styles | `#e2e8f0` | Same reason as `demo/shared`: the demo pair share one opaque cool hairline and were not carried onto the portal's alpha rule. |
| `--teal-700` | demo/shared | `#0f5f59` | The demo still uses the pre-v2 convention where `--teal-600`/`--teal-700` are darker steps *below* the base `--teal`. The portal adopted the standard 50–900 ramp in D1, where `--teal-700` **is** the base (spec §2.1, plan §0.1). Same name, two conventions — which is exactly why the portal's consumers were migrated to `--teal-hover`/`--teal-press` rather than being left to resolve differently. |
| `--sans` | demo/shared | `system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` | The portal self-hosts Noto Sans Latin (D1) so Latin, Telugu and Devanagari are one family on one baseline grid. The demo has no Latin face and correctly falls through to the system stack rather than declaring a font it does not ship — which is the untruth D1 removed from the portal. |
| `--sans` | demo/styles | `system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` | Same reason as `demo/shared`: the demo pair share one type stack and ship no Latin face, so they fall through to the system stack. |
| `--te` | demo/shared | `'Noto Sans Telugu', system-ui, sans-serif` | The portal inserts `'Noto Sans'` after the Telugu face because the Telugu face is `unicode-range`-scoped away from Latin — without it, Latin digits inside a `lang="te"` string resolve to a different family from the sentence around them. The demo has no Latin face to insert. |
| `--te` | demo/styles | `'Noto Sans Telugu', system-ui, sans-serif` | Same reason as `demo/shared`: no Latin face exists on the demo to insert into the fallback chain. |
| `--hi` | demo/shared | `'Noto Sans Devanagari', system-ui, sans-serif` | Same reasoning as `--te`: the Devanagari face is `unicode-range`-scoped away from Latin, so the portal inserts `'Noto Sans'` behind it to keep a mixed-script string in one family. The demo has no Latin face to insert. |
| `--hi` | demo/styles | `'Noto Sans Devanagari', system-ui, sans-serif` | Same reason as `demo/shared`: no Latin face exists on the demo to insert into the fallback chain. |
| `--radius` | demo/shared | `14px` | v2 tightened the radius scale (spec §2.4); the demo is a frozen sales surface and was not migrated. |
| `--radius` | demo/styles | `14px` | Same reason as `demo/shared`: the demo pair are a frozen sales surface and were not migrated to the v2 radius scale. |
| `--radius-sm` | demo/shared | `10px` | Same reason as `--radius`: the v2 control radius tightened to 6px and the demo was not migrated. |
| `--radius-sm` | demo/styles | `10px` | Same reason as `--radius`: the v2 control radius tightened to 6px and the demo was not migrated. |
| `--shadow` | demo/shared | `0 1px 2px rgba(15, 23, 42, .04), 0 6px 16px rgba(15, 23, 42, .06)` | v2 restructured elevation into sm/md/lg and removed the card shadow (spec §2.5); the demo keeps the pre-v2 float. S3b-2 widened the divergence from geometry alone to hue as well: the portal casts warm ink `rgb(23, 21, 15)` and the demo is still slate. |
| `--shadow` | demo/styles | `0 1px 2px rgba(15, 23, 42, .04), 0 6px 16px rgba(15, 23, 42, .06)` | Same reason as `demo/shared`: the demo keeps the pre-v2 float and its cards still cast, in the slate the portal left behind at S3b-2. |
| `--shadow-sm` | demo/shared | `0 1px 2px rgba(15, 23, 42, .06)` | New at S3b-2, and a hue divergence rather than a geometry one. The portal's shadow scale was re-hued from slate `rgb(15, 23, 42)` to warm ink `rgb(23, 21, 15)` so it stops casting a cool shadow onto warm paper; every alpha, offset, blur and spread is unchanged. The demo pair are a frozen cool sales surface and keep the slate cast. |
| `--shadow-sm` | demo/styles | `0 1px 2px rgba(15, 23, 42, .06)` | Same reason as `demo/shared`: the demo pair stay on the cool ground, so their contact shadow keeps the slate tint the portal no longer uses. |
| `--r-sm` | web | `4px` | `web/` has its own radius scale predating the v2 spec (4/8/12 against the portal's 6/10/14). It is the **last** of the three radius names still divergent: the enterprise polish pass moved the portal's `--r-md`/`--r-lg` onto `8px`/`12px`, which are `web/`'s own two values, so those two rows are gone. `--r-sm` did not move — portal `6px` against web `4px`. Phase 1b parked a dormant `--rad-sm`/`--rad-md`/`--rad-lg` (2/6/10) beside this scale rather than repointing it, precisely so that no existing consumer moves; this last collision resolves at **Phase 2**, when `web/`'s components take the new scale. |

**Two rows retired on 2026-08-29: zero divergence, not a smaller one.** `--r-md`
(web `8px`) and `--r-lg` (web `12px`) recorded a deliberate difference from a
portal value that no longer exists. The enterprise polish pass moved the portal
to `8px`/`12px` — the same two values — so portal and `web/` now agree on both
and there is nothing left to record. The rows were not
rewritten with new numbers; they were removed, because a divergence table that
lists agreements is the same defect pointing the other way.

---

## Concept map — portal ↔ web

The two tables above compare tokens **by name**. This one compares them **by
meaning**, which is the only way the portal and `web/` can be compared at all:
they share almost no names. A row here says *these two names denote one concept,
and the value is the same on both surfaces on purpose*. Nothing in this section
is parsed by the guard — the values it quotes are the ones the tables above
already enforce — so a row here is a claim about intent, and it is only as true
as the person who wrote it.

Landed by **S3b** (portal ground flip, D-016). Before it, the portal's grounds
were a cool slate scale and `web/`'s were warm paper; the product had two
grounds and shipped both.

| Concept | Portal (`public/portal/tokens.css`) | Marketing (`web/app/globals.css`) | Shared value |
|---|---|---|---|
| Page ground | `--bg` | `--ground` | `#faf8f5` |
| Raised surface | `--card` | `--ground-raised` | `#ffffff` |
| Hairline rule | `--line` | `--rule` | `rgba(23, 21, 15, .08)` |
| Stronger rule | `--line-3` | `--rule-strong` | `rgba(23, 21, 15, .17)` |

`--card` did not move. It already held `#ffffff`, which is exactly what
`--ground-raised` holds; the row records an agreement that was always true and
had never been written down.

### The warm axis, and the steps only the portal has

`web/` names three grounds. The portal has six light backdrop levels, because it
is a dense application surface and the marketing site is not. The four steps
`web/` does not name are **portal-private** and get no row above — a value on one
surface is that surface's own business, and inventing a marketing counterpart to
justify it would be the fifth source of truth this file exists to prevent.

They are derived rather than picked. `web/`'s two named opaque grounds lie on one
line, **white − s·(5, 7, 10)**: s = 1.00 reproduces `--ground` exactly, and
s ≈ 2.44 gives `#f3eee7` against the real `#f2eee8` — the same axis within
rounding. Each portal-private step is the point on that line with the **same
relative luminance** as the cool value it replaces, which is the method
`globals.css:266-275` already used for `--rule-strong` ("matched on perceptual
weight rather than on alpha"):

| Portal-private step | Site | Was (cool) | Now (warm) | s | Δ luminance |
|---|---|---|---|---|---|
| soft divider / muted fill | `--line-2` | `#edf2f7` | `#f5f1eb` | 2.02 | +0.0010 |
| sidebar ground | `.side` | `#f9fafb` | `#fbfaf7` | 0.76 | +0.0012 |
| control fill | `.btn`, `.input`, `.in-wrap`, `.phone-row__remove`, `.lang-toggle`, `.holiday__remove` | `#fbfcfe` | `#fdfcfa` | 0.45 | +0.0012 |
| sunk control panel | `.in-prefix`, `.chip` | `#f3f6f9` | `#f8f5f1` | 1.39 | −0.0019 |
| nav hover | `.nav__item:hover`, `.day__toggle:hover` | `#f0f4f8` | `#f6f3ee` | 1.70 | −0.0014 |

Every one holds luminance to ±0.002. **The flip is a hue change, not a lightness
change** — which is why it moved every backdrop in the contrast signature and
almost none of the ratios.

`--line-2` stays **opaque** while `--line` and `--line-3` became alphas, and the
asymmetry is the point: `--line-2` is a *fill* in seven of its uses (badges,
`.btn:active`, ghost hover, the readiness ring's track) and only a divider in the
rest. An alpha rule painted as a fill is a category error, and `web/` has no third
rule step to borrow. Ordering was checked rather than assumed — `--line-2` stays
lighter than `--line` stays lighter than `--line-3` on all three grounds. That
check exists because `globals.css:409` records the pair inverting once already.

**`--ground-sunk` has no portal counterpart, deliberately.** `web/`'s sunk is a
page-section step at s = 2.44; the portal's deepest light backdrop is a
control-internal one at s = 1.39. Mapping them would more than double the step
inside a phone-number input in order to make a table look complete. When the
portal grows a page-section sunk, that is the row to add.

### The second non-text step, and why it had to be free (S3c-2)

`--faint-strong` **`#857F79`** joins `tokens.css`. It is **not a new colour**: it
is `web/`'s own `--ink-faint` under `@media (prefers-contrast: more)`
(`globals.css:446`), taken verbatim for the same reason S3c-1 took `--ink-strong`
and `--ink-soft` verbatim — a freshly-mixed warm grey here would be another
source of truth, which is what this document exists to prevent.

**The split it creates is SC 1.4.11, not taste.** `--faint` is decoration —
rules, dividers, undrawn states, a scrollbar thumb — at 2.41:1 on `--bg` and
2.55:1 on `--card`, comfortably under the 3:1 floor and therefore unable to
carry meaning. `--faint-strong` is 3.73:1 / 3.96:1: **non-text that means
something.** Four declarations moved onto it, all of them state:

| Site | Was | Now | On |
|---|---|---|---|
| `.switch__track` (off) | `--faint` 2.55:1 | `--faint-strong` 3.96:1 | `--card` |
| `.banner__dot`, incl. `--draft` | `--faint` 2.55:1 | `--faint-strong` 3.96:1 | `--card` |
| `.lang-toggle__check` border | `--faint` 2.55:1 | `--faint-strong` 3.96:1 | control fill |
| `.pay-toggle__check` border | `--faint` 2.55:1 | `--faint-strong` 3.96:1 | control fill |

The switch failed on **either** reading of 1.4.11: its track against the card
and its `#fff` knob against its own track are the same 2.55:1, because the knob
is white and the comparison is symmetric. Off is now *lighter* than on
(`--teal-700`, 5.47:1) — an off toggle that outweighs an on toggle would have
traded one defect for a worse one. The scrollbar thumb and `.think-dot` stay on
`--faint`: genuinely decorative, no state in either.

**`#857F79` stops short of 4.5:1 deliberately, and the ceiling is the point.**
`globals.css:432-438` derived it that way: a high-contrast non-text token that
passed AA for text would invite the first glyph, and the NON-TEXT ONLY contract
would become a comment. `portalContrast.test.js` now enforces both values with
one static net, so the ceiling is a fact rather than a note.

**It cost zero lines, and that was a constraint rather than a flourish.** The
freeze this document records two sections above is real and was measured:
**eight comments in five files cite `tokens.css` by line number, and three of
them are in `scripts/portal/shoot.js`**, which S3c-2's file set did not include.
A token that cannot be added without invalidating three citations nobody in that
session could fix is a token that gets added anyway and leaves three wrong line
numbers behind it. So the `--faint` comment above it gave up a line to pay for
the declaration, and every cited anchor — 111, 177, 227, 276, 995, 1008, 1014,
1694 — was verified byte-identical against HEAD afterwards. **This is the fix
that section called for and could not take: the naming is no longer blocked, it
is merely expensive, and the price is one comment line per token.**

**The instruments cannot see any of it, and both are blind for different
reasons.** The contrast sweep measures glyphs and SVG paint; a `background-color`
on an empty `<span>` is invisible to it, so the portal signature is
byte-identical across this change — 10 lines either way. The 54-shot corpus is
blind too, and not for the same reason: **zero pixels of `#A8A199` appear in any
of the 54 shots before the change, and zero pixels of `#857F79` in any of them
after**, because the seeded tenant is validated and its protections are on, so
no shot ever renders an off toggle or a draft dot. Neither the signature's
silence nor the corpus's silence is evidence here. What *is* evidence: a
`getComputedStyle` read-back in a real Chrome against the real stylesheets
returns `rgb(133, 127, 121)` for all four selectors, and a pixel census of that
render counts 368 painted pixels of it and 0 of `#A8A199`.

---

**Still cool, and out of scope by decision:** `--field` / `--field-2` /
`--field-line` (the Verbatim ink ground) and the semantic tint fills
(`--teal/green/amber/red-50/100/200`, state tints rather than ground steps).

**S3c-2 closed the ink ground's TEXT scale without touching its GROUND, and the
distinction is the whole of what is left here.** That panel carried four
hardcoded greys the scale never named — `#6E7784` (three sites) at 4.08:1 and
`#5A6472` at 3.08:1, both BELOW the secondary and both failing AA, plus
`#B4BCC7` at 9.64:1 sitting BETWEEN the two named steps and passing. All four
are `var(--field-muted)` now, which took the portal's threshold failures to
**zero on both grounds**. `#B4BCC7` is worth its own clause: it PASSED, so it
was never in a failure count, and a step no instrument can fail is exactly the
step that survives the session sent to remove the others. The grounds themselves
(`#0c1420` / `#141c2a`) are still cool and still out of scope: they are a
deliberate dark surface, not a light backdrop step that missed the flip, and
nothing measured argues for moving them. `--field-ink` 15.69:1 and
`--field-muted` 7.21:1 already mirror `--ink` 17.22 and `--ink-2` 7.31 to within
a step, so the ink ground needed no scale of its own — it needed its literals
pointed at the scale it already had.

**The stale-slate sweep is one line shorter, and three lines from done.**
S3b-2's flip of `--shadow-*` missed `.page-head.is-stuck`
(`tokens.css:1888`), which held `0 4px 8px rgba(15, 23, 42, .06)` — the
pre-flip triple at the post-flip geometry, so one shadow painted in two hues.
It takes `var(--shadow-sm)` now, and NOT `--shadow-lg`: the literal matched
that token's first layer exactly, but `--shadow-lg` is two layers and
`tokens.css:1597-1599` reserves it for the tier that floats furthest (modal,
⌘K, mobile drawer). A sticky sub-header does not belong in it. **Three slate
literals remain**, all of them SCRIMS rather than shadows —
`rgba(15, 23, 42, .45)` at `tokens.css:1587` and `:1653`, and
`rgba(15, 23, 42, .4)` at `:1858`. A scrim is a different argument from a
shadow (it darkens a whole viewport rather than tinting an edge) and is left
open deliberately rather than swept in behind a shadow fix.

**S3b-2 moved the `--shadow-*` scale**, which S3b had reported as the loudest
survivor and deliberately left alone. Slate `rgb(15, 23, 42)` became warm ink
`rgb(23, 21, 15)` — the triple `--line` and `--line-3` already carry — across all
five layers of `--shadow-sm` / `--shadow-md` / `--shadow-lg`. **Hue only:** every
alpha (.06, .05/.08, .06/.14) and every offset, blur and spread is exactly what
it was. Shadow *geometry* is a separate argument — the design direction prefers
depth from fill and hairline over a resting shadow — and is deliberately not
settled here.

**S3b-2 also closed the five backdrop literals S3b could not reach.** All five
live outside `tokens.css`, which is why a flip of the token layer missed them.
`.phone-row__remove` and `.lang-toggle` (`clinic-profile.css:24,46`) and
`.holiday__remove` (`hours.css:121`) held the control-fill step as a raw
`#fbfcfe`; `.day__toggle:hover` (`hours.css:50`) held the nav-hover step as a raw
`#f0f4f8`. Neither value matched a *token's* pre-flip value — both are steps the
token layer never named — so each took the warm value already derived for its
step in the table above, and that table's Site column now lists them. The fifth,
`.vp`'s `border-left` (`verbatim.css:69`), is not a ground step at all: it was
`--ink` at 12% alpha, the seam where warm paper meets the ink panel, and it took
the warm-ink triple at the same alpha.

**Why none of the five became a `var()`, which is the fix that would stop this
recurring.** A literal that escapes the token system escapes the *next* flip too
— that is exactly how these five survived S3b. But none of the three steps
involved (control fill, nav hover, the paper/ink seam) has a name in `tokens.css`
to point at, and that file is line-count-frozen: eight comments in five other
files cite it by line number, so a declaration cannot simply be added. Naming
them is an S3c decision. Recording them here, and in a comment at each site, is
what stops the next flip from missing them again.

**The contrast instrument cannot see four of the five**, which is worth writing
down because it makes the sweep look reassuring when it is merely blind.
Measured at S3b-2: **zero** of the 47 colour/backdrop pairs sit on `#fbfcfe` or
`#f0f4f8`. `core.js`'s `sweepPage` records direct text children only, so the two
remove buttons (an `<svg>` and nothing else) are invisible to it, `.lang-toggle`'s
label is not a direct text child, and `.day__toggle:hover` is a hover state the
sweep never enters. Those four declarations cannot move a pair, a failure or a
ring, and the signature would have stayed green whether or not they were fixed.

---

## Not compared

~~`--teal-hover` (`#0d6b63`) and `--teal-press` (`#0f5f59`)~~ — **REMOVED in D5a.**

They existed only on `portal` and were transitional: they carried the values
`--teal-600`/`--teal-700` held before the v2 ramp landed, so that renaming those
two steps repainted nothing.

D5a resolved all seventeen consumers and deleted both declarations. The
prediction recorded here — "their consumers move onto `--teal-800`/`--teal-900`"
— **was wrong, and the way it was wrong is the useful part.** Only ONE of the
seventeen was a button-fill hover (`.btn--primary:hover` → `--teal-800`) and two
more were text-colour hovers (also `--teal-800`). The other fourteen were resting
or *selected*-state text colours — uppercase labels, selected pills, chips, a
version number — that the word "press" described only by accident of which value
D1 happened to park them on. Those took `--teal-700`, the accent on the light
ground; sending them to `--teal-900` because of a token's name would have
darkened six selected-pill treatments that were never a press state. One more
(`.segmented__btn--active`) left the ramp entirely: the foundations sheet draws a
selected segment as a raised `--card` tile, and spec §2.1 rations the accent to
the primary action, the current nav position, links, focus and the live
indicator — a chosen tone is none of those.

**Lesson for the next transitional rename:** a token parked by a mechanical
migration records where a value *was*, not what it *means*. The rename is only
half the work; the other half is reading each site.

Still not compared, and still portal-only: `--amber-50` / `--green-50` /
`--red-50`. D5a made the unpadded names canonical to match `--teal-50`, and left
the zero-padded `--amber-050` / `--green-050` / `--red-050` as aliases — those
three ARE shared with the demo surfaces and keep their rows in the tables above,
which they still satisfy because an alias resolves.

---

## Sign-in surfaces (S4)

**Both** login pages — `public/portal/login.html` and `public/admin/login.html` —
take the portal's token layer. This section records that, and records what the
admin panel keeps for itself, because the second half is the part that a future
reader would otherwise mistake for drift.

### The record

| Surface | Token source | Notes |
|---|---|---|
| Portal sign-in | `public/portal/tokens.css` | Was already on it. `public/portal/login.css` (S4) holds this page's layout only, declares **no** custom property, and every control on the page is a tokens.css component. |
| Admin sign-in | `public/portal/tokens.css`, via `<link href="/portal/tokens.css">` | S4. Reachable because `server.js:90` serves `public/` at the root. The page no longer links `/admin/style.css`. |
| The other 8 admin pages | `public/admin/style.css` | **Unmoved.** Zero custom properties, and none of the values below changed. |

This adds no row to the tables above: the sign-in pages consume portal tokens,
they do not declare any, and the parser in `tests/design/tokenDrift.test.js`
reads declarations rather than consumers. `SURFACES` is still four files.

### Why two files and not one shared stylesheet

The two sign-in pages share **no class name at all** — before S4 or after it —
so there is no overlap to preserve and the question is only what the structure
should say. It says: two files, each importing the token layer.

The warrant is a **product** one, and it is worth being exact about that because
the obvious-sounding security warrant is wrong. **INV-1 is not the reason.**
INV-1 (`src/portal/auth.js:15-17`) says a portal route's `tenant_id` derives only
from the session's user row; `portal.sid` and `connect.sid` are held apart by two
cookie names, two session middlewares and two code paths. A stylesheet carries no
session and cannot weaken any of that — if it could, `express.static('public')`
already serving `/portal/tokens.css` to an admin page would be the breach, and it
is not. Citing INV-1 here would hand the next session a warrant that does not
hold, and they would inherit it.

The reason that does hold is that these are two products:

1. The portal sign-in is customer-facing, is the far end of the marketing seam,
   and is one of fourteen pages on the v2 design system.
2. The admin sign-in is one operator behind one shared `ADMIN_PASSWORD` — no
   tenant, no brand obligation — on a surface of nine pages that no session has
   migrated.
3. A shared stylesheet would therefore either drag all nine admin pages onto
   portal tokens sight-unseen, or hold the customer-facing portal to admin's
   blue. Both are worse than two files.

### The seam, measured

The portal, `web/` and the sign-in pages already agree on everything structural.
Ratios below are computed with `core.contrastRatio` — the contrast engine's own
function — not read off a rendering.

| | `web/` | portal + both sign-ins |
|---|---|---|
| Ground | `--ground: #FAF8F5` | `--bg: #faf8f5` |
| Raised | `--ground-raised: #FFFFFF` | `--card: #ffffff` |
| Primary ink | `--ink-strong: #17150F` | `--ink: #17150F` |
| Secondary ink | `--ink-soft: #57524A` | `--ink-2: #57524A` |
| Accent | `--accent: #0f766e` | `--teal-700: #0f766e` |
| Type | Geist / Inter | **Noto Sans** — a deliberate divergence, already recorded above: Noto carries Telugu and Devanagari and Geist does not. |

S4 closed the seam's one real break. `public/portal/login.html` used to declare
its own `.field input`, the only text input in the product that was not `.input`,
and its focus was a soft `0 0 0 3px var(--teal-100)` halo instead of the portal's
shared ring. It was also the sole consumer of that glow anywhere, which is why it
owned a line of its own in `tests/design/contrast/portal.signature.txt` —
deleted, not replaced, when the field became `.input`.

### The notice colours, and where they are NOT measured

Both sign-in pages carry a two-armed notice. `--error` is a server verdict;
`--wait` is a condition that clears on its own (a rate limit, a network). Body
text is `--ink-2`; `--red` / `--amber` are reserved for the icon and the title.

| Pair | Ratio | Role |
|---|---|---|
| `--red` on `--red-050` | 5.91:1 | notice icon + title |
| `--ink-2` on `--red-050` | 7.08:1 | notice body |
| `--amber` on `--amber-050` | 4.84:1 | notice icon + title |
| `--ink-2` on `--amber-050` | 7.47:1 | notice body |
| `--teal-700` on `--red-050` | 5.00:1 | the recovery link inside the 401 notice |

Every one of those is **computed offline, not instrument-measured.** The notice is
`hidden` at rest, the contrast sweep visits `login.html` at rest, and a hidden
element emits no row — so none of these pairs is in the live baseline. That is
S3d's lesson exactly (a declaration guarding a state nothing renders is certified
green on absence), and closing it needs a `login[error]` entry in
`CONTRAST_PAGES`, which is a sweep change and not a shot. Filed, not done.

### What the admin panel keeps, and its contrast liability

`public/admin/style.css` now dresses **seven** pages, not nine: S4 moved
`login.html` onto the portal tokens and S5 moved `tenants.html` and
`tenant-new.html`. The remaining seven are `conversations`, `appointments`,
`leads`, `collections`, `notifications`, `workflow` and `tenant-detail` (S6).
Its values are the admin panel's private business, are **not** canonical, and
must not be reconciled into the tables above:

| Value | Where | Read-from-source note |
|---|---|---|
| `#4361ee` | `.btn-primary` fill | White label on it measures **5.02:1** — clears 4.5:1, so the 14px/500 text it carries is **not** a failure. Corrected in S5: the 4.31:1 recorded here before was wrong. |
| `#e63946` | `.error` text, `.btn-danger` fill | `#e63946` on `#fff` measures **4.17:1** at 13px — under AA body. Corrected in S5: the **3.76:1** recorded here is `#e63946` on **`#f5f5f5`** (3.82:1), the page GROUND — the error was a **wrong backdrop**, not a wrong arithmetic. `.error` renders inside a `.card`, so `#fff` is the backdrop that applies, and the verdict (under AA) survives either way. |
| `#f5f5f5` | page ground | Cool grey, not the warm `#faf8f5` every other surface uses. |
| `#1a1a2e` | `nav` | — |
| system font stack | `body` | Not Noto Sans; carries no Telugu or Devanagari. |

**Both ratios are READ FROM SOURCE and computed, NOT instrument-measured** — and that is exactly how both of them came to be wrong. S5 recomputed them with `tests/design/contrast/core.js`'s own `contrastRatio()`, the function the live sweep judges with, so the corrected figures are at least derived from the instrument's arithmetic even though no instrument has looked at the pixels. The lesson is the second row's: an offline figure carries its backdrop as an
*assumption*, where a sweep would have carried it as a *measurement*.

No instrument in this repo has ever looked at an admin page: `scripts/portal/shoot.js`
builds every `CONTRAST_PAGES` URL onto a single `/portal` base, so the sweep is
portal-only by construction. The three admin shots in the corpus
(`admin-login-desktop`, `admin-login-mobile`, `admin-login-error`) are captures,
not measurements. **The admin session owns these values**; they are recorded here
so that a future reader does not read them as portal drift.

**`.error` now has no writer at all.** S5's dead-class scan, re-run after the
migration, reports `.error` and `.btn-danger` as the two rules in
`public/admin/style.css` that no remaining page writes: `tenant-new.html` was
`.error`'s last consumer and it moved onto tokens. The 4.17:1 liability is
therefore **latent, not live** — it is a declaration guarding a state nothing
renders, which is precisely the shape S3d warned about, and it should be deleted
rather than fixed. Left standing in S5 because the ruling's dead-class list was
the four names Phase A enumerated, and these two became dead *during* the
session. S6's business.

⚠️ **Do not "revive" `.btn-danger` by using it.** Phase A recommended exactly
that and it was wrong on the numbers: `tenant-detail.html`'s two destructive
buttons paint `#fff` on an inline `#b00020` at **7.33:1**, and moving them onto
the declared `.btn-danger` (`#e63946`) would take them to **4.17:1** — *under*
AA for the 14px/500 label they carry. The inline value is the better one, and
the declared rule is the defect. `tokens.css` disagrees with both: `.btn--danger`
is deliberately **not a solid red fill** (`--red-700` on `--card`, 6.47:1), on
the grounds that a filled red button is the most attractive target on screen at
the exact moment the operator should hesitate.

**Neither row applies to a migrated page.** `login.html`, `tenants.html` and
`tenant-new.html` take `--teal-700` for their primary button (5.4:1 on `--card`)
and `--red` / `--red-200` / `--red-50` for their error surfaces, all from
`tokens.css`. The two liabilities above are scoped to whatever still links
`/admin/style.css`, and they shrink by one page each time S6 and its successors
move one.
