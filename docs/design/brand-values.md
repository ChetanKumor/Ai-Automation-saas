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

| Token | Canonical value | Surfaces |
|---|---|---|
| `--accent` | `#0f766e` | portal, web |
| `--amber` | `#b45309` | portal, demo/shared |
| `--amber-050` | `#fffbeb` | portal, demo/shared |
| `--amber-100` | `#fef3c7` | portal, demo/shared |
| `--amber-200` | `#fde68a` | portal, demo/shared |
| `--bg` | `#f6f8fa` | portal, demo/shared, demo/styles |
| `--card` | `#ffffff` | portal, demo/shared, demo/styles |
| `--ease-out` | `cubic-bezier(.16, 1, .3, 1)` | portal, web |
| `--green` | `#16a34a` | portal, demo/shared, demo/styles |
| `--green-050` | `#f0fdf4` | portal, demo/shared, demo/styles |
| `--green-100` | `#dcfce7` | portal, demo/shared, demo/styles |
| `--green-700` | `#15803d` | portal, demo/shared, demo/styles |
| `--hi` | `'Noto Sans Devanagari', 'Noto Sans', system-ui, sans-serif` | portal, demo/shared, demo/styles |
| `--ink` | `#0f172a` | portal, demo/shared, demo/styles |
| `--ink-2` | `#334155` | portal, demo/shared, demo/styles |
| `--line` | `#e2e8f0` | portal, demo/shared, demo/styles |
| `--muted` | `#64748b` | portal, demo/shared, demo/styles |
| `--r-lg` | `14px` | portal, web |
| `--r-md` | `10px` | portal, web |
| `--r-sm` | `6px` | portal, web |
| `--radius` | `10px` | portal, demo/shared, demo/styles |
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
| `--bg` | demo/shared | `#eef2f6` | The portal's ground is a hair lighter so its white sidebar and cards read as calm rather than boxed-in. Documented at `tokens.css:19-20` since PORTAL-P1-S2. |
| `--bg` | demo/styles | `#eef2f6` | Same as above — the demo pair share a ground. |
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
| `--r-sm` | web | `4px` | `web/` has its own radius scale predating the v2 spec (4/8/12 against the portal's 6/10/14). The names collide; the values are each correct for their surface. Phase 1b adds a parallel `--rad-sm`/`--rad-md`/`--rad-lg` (2/6/10) dormant beside this scale rather than repointing it, precisely so that no existing consumer moves; the collision resolves at **Phase 2**, when `web/`'s components move onto the new scale and these three rows retire. |
| `--r-md` | web | `8px` | Same reason as `--r-sm`: `web/`'s radius scale is 4/8/12 and predates the v2 spec. Superseded by the dormant `--rad-md` (6px) at **Phase 2**. |
| `--r-lg` | web | `12px` | Same reason as `--r-sm`: `web/`'s radius scale is 4/8/12 and predates the v2 spec. Superseded by the dormant `--rad-lg` (10px) at **Phase 2**. |

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
