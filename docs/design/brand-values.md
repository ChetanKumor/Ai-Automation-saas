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
| `--ink` | `#0f172a` | portal, demo/shared, demo/styles |
| `--ink-2` | `#334155` | portal, demo/shared, demo/styles |
| `--line` | `rgba(23, 21, 15, .08)` | portal, demo/shared, demo/styles |
| `--muted` | `#64748b` | portal, demo/shared, demo/styles |
| `--r-lg` | `12px` | portal, web |
| `--r-md` | `8px` | portal, web |
| `--r-sm` | `6px` | portal, web |
| `--radius` | `8px` | portal, demo/shared, demo/styles |
| `--radius-sm` | `6px` | portal, demo/shared, demo/styles |
| `--sans` | `'Noto Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | portal, demo/shared, demo/styles |
| `--shadow` | `0 2px 4px rgba(15, 23, 42, .05), 0 8px 20px rgba(15, 23, 42, .08)` | portal, demo/shared, demo/styles |
| `--shadow-sm` | `0 1px 2px rgba(15, 23, 42, .06)` | portal, demo/shared, demo/styles |
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
| `--shadow` | demo/shared | `0 1px 2px rgba(15, 23, 42, .04), 0 6px 16px rgba(15, 23, 42, .06)` | v2 restructured elevation into sm/md/lg and removed the card shadow (spec §2.5); the demo keeps the pre-v2 float. |
| `--shadow` | demo/styles | `0 1px 2px rgba(15, 23, 42, .04), 0 6px 16px rgba(15, 23, 42, .06)` | Same reason as `demo/shared`: the demo keeps the pre-v2 float and its cards still cast. |
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
| control fill | `.btn`, `.input`, `.in-wrap` | `#fbfcfe` | `#fdfcfa` | 0.45 | +0.0012 |
| sunk control panel | `.in-prefix`, `.chip` | `#f3f6f9` | `#f8f5f1` | 1.39 | −0.0019 |
| nav hover | `.nav__item:hover` | `#f0f4f8` | `#f6f3ee` | 1.70 | −0.0014 |

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

**Still cool, and out of S3b's scope by decision:** `--field` / `--field-2` /
`--field-line` (the Verbatim ink ground — S3c), the semantic tint fills
(`--teal/green/amber/red-50/100/200`, state tints rather than ground steps), and
the `--shadow-*` scale, which is still slate `rgba(15, 23, 42, …)` cast onto warm
paper. The shadows are the loudest survivor and are not a backdrop, so they were
reported rather than moved.

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
