# Motion — reference

## 1. Why this file exists

This is a **reference, not a token file.** Nothing here is imported, parsed, or
tested. `docs/design/brand-values.md` is the binding record of values that ship;
this file is the record of the *reasoning* those values come from, and of a body
of constants that the repository could not otherwise reconstruct.

That last point is the reason it was written. The motion guidance this design
program has been working from lives in a Claude session skill (`apple-design`),
which exists in the session environment and **not in this repository**. Every
spring constant below — the damping ratios, the response times, the deceleration
rate in the projection function — was, until this file, unreconstructable from a
checkout. Someone picking up the work with the repo alone would have had the
outputs and none of the inputs.

So: no value in this file is authoritative over `brand-values.md`. If the two
ever disagree, `brand-values.md` is right and this file is stale. What this file
owns is the *why*.

A second, blunter reason to write it down: §11 records that `web/` today does
almost none of what the rest of this document describes. Recording the gap is
worth more than pretending it isn't there.

## 2. Source

Distilled from Apple's WWDC design talks, then translated onto the web platform
(CSS, Pointer Events, `requestAnimationFrame`, spring libraries):

- **Designing Fluid Interfaces** (WWDC 2018) — the springs, the velocity
  handoff, the projection function, interruptibility. The bulk of §§3–8.
- **The Details of UI Typography** (WWDC 2020) — §10, type as motion's sibling.
- **Principles of Great Design** (WWDC 2026) — the eight principles that the
  motion rules serve; the framing in §1 and §12.

The through-line across all three: **an interface feels alive when motion starts
from the current on-screen value, inherits the user's velocity, projects
momentum forward, and can be grabbed and reversed at any instant.**

## 3. Damping and response — why two parameters, not three

The physics of a damped harmonic oscillator take three parameters: mass,
stiffness, damping. Apple deliberately does not expose them. A designer asked to
tune a drawer by adjusting *mass* is being asked to solve a differential
equation in their head, and the three are not independent — changing stiffness
changes the settle time, so every adjustment requires re-tuning the other two.

The two parameters that replaced them are each independently meaningful:

- **Damping ratio** — controls *overshoot*, and nothing else. `1.0` is
  critically damped: it settles as fast as possible without ever crossing the
  target. Below `1.0` it overshoots and oscillates; lower is bouncier.
- **Response** — how quickly the value reaches the target, in seconds. Lower is
  snappier.

**Response is not duration.** A spring has no duration. It is a continuous
function that never formally arrives; the settle time *emerges* from the
parameters, and implementations stop it at some epsilon. This distinction is
the whole reason a spring can be interrupted and a keyframe cannot: there is no
timeline position to be at, only a current value and a velocity.

That is also why a spring is the right tool for anything the user can touch.
New input does not restart an animation — it changes the target. Position and
velocity carry through unchanged, so the motion stays continuous across the
interruption. A fixed-duration animation has to cut, and a cut is visible.

## 4. The constants

| Interaction | Damping | Response |
| --- | --- | --- |
| Move / reposition (e.g. picture-in-picture) | `1.0` | `0.4` |
| Rotation | `0.8` | `0.4` |
| Drawer / sheet | `0.8` | `0.3` |

**Default to damping `1.0`.** Critically damped is graceful and
non-distracting, and it is correct for the large majority of UI.

**Use `0.8` only when the gesture itself carried momentum** — a flick, a throw,
a drag release. This is a rule about *causality*, not taste. Overshoot is the
interface showing you the momentum you gave it. On a menu that simply faded in,
there was no momentum, so the bounce is a lie about physics that did not happen
and reads as fidgeting. On a card you flicked, the same bounce reads as the card
having been thrown.

Note that rotation and drawer both sit at `0.8` because both are typically
gesture-driven; move sits at `1.0` because a reposition is usually commanded,
not thrown.

## 5. Velocity handoff

When a gesture ends, the animation must continue at **the finger's exact
velocity at release**. This is the seam between dragging and animating, and it
is the single detail that most separates "fluid" from merely "fine". If the
spring starts from zero velocity, the element visibly stalls at the moment the
finger lifts — the user feels the software take over.

This requires tracking a short position/timestamp history across the last few
`pointermove` events, not just the current point: instantaneous velocity from a
single frame is noisy.

Some spring APIs want velocity **normalized** by the remaining distance:

```
relativeVelocity = gestureVelocity / (targetValue − currentValue)
```

An element at `y = 50` heading for `y = 150` (100px to go) with the finger
moving at 50px/s hands off `50 / 100 = 0.5`. Motion / Framer Motion take
absolute px/s directly via the `velocity` option, so there you pass the raw
number.

Related, and easy to get wrong: **decide reverse-vs-commit from the velocity
sign, not from position.** A sheet dragged only 10% down but flicked hard
downward should dismiss. Position asks "how far did they get"; velocity asks
"where were they going", and the second is the question.

## 6. Momentum projection

Do not snap to the boundary nearest the *release point*. Use velocity to project
where the gesture was **going**, then snap to the target nearest that projected
point. This is what makes a flick feel like it throws the element — a small
input producing a large, intended output.

Apple's projection function, from the *Designing Fluid Interfaces* sample code:

```js
// decelerationRate ≈ 0.998 for normal scroll feel; 0.99 is snappier.
function project(initialVelocity /* px/s */, decelerationRate = 0.998) {
  return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
}

const projectedEndpoint = currentPosition + project(releaseVelocity);
const target = nearestSnapPoint(projectedEndpoint);
animateSpringTo(target, { velocity: releaseVelocity });  // then hand off (§5)
```

**The textbook `v² / (2·deceleration)` is NOT what ships.** That form is the
constant-deceleration result — it assumes friction removes a fixed amount of
speed per unit time until the object stops. Real scroll deceleration is
exponential decay: the velocity is multiplied by the deceleration rate each
millisecond, so it falls fast at first and trails off. The exponential form
above is what iOS scroll views, and every bottom-sheet or carousel that feels
right (Vaul, Embla), actually use. Substituting the textbook version produces
throws that overshoot at high velocity and undershoot at low, and the error is
largest exactly where users notice most.

Note `d = 0.998` is per-millisecond, which is why the function divides velocity
by 1000 first.

## 7. Rubber-banding

At a boundary, resist **progressively** rather than stopping dead. A hard stop
reads as "the interface froze"; continuous resistance reads as "still
responding, but there is nothing more here." The two are the same information
and only one of them is reassuring.

```js
// The further past the bound, the less the element follows.
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

The function is asymptotic: as `overshoot` grows the result approaches
`dimension * constant` and never exceeds it, so the element can always be
dragged a little further and never escapes. Resistance rises with distance,
which is what a real elastic does.

## 8. What CSS may and may not do

**CSS may** handle everything that is not gesture-driven, and should:

- state changes with no continuous input — hover, focus, a disclosure opening
- entrances and exits on a timeline
- anything where the start and end are both known in advance and nothing can
  interrupt midway

For these, a `transition` or `@keyframes` with a cubic-bézier is not a
compromise — it is the right tool, it is cheap, and it runs on the compositor.

**CSS may not** handle anything a finger can touch, and this is not a style
preference. A CSS transition:

- cannot start from the current *presentation* value on interrupt without
  reading it back and re-writing the rule, so a grab mid-flight jumps
- cannot accept an initial velocity, so §5 is simply unavailable
- has a fixed duration, so re-targeting mid-motion restarts the clock and
  produces the velocity discontinuity — the "brick wall" — that a reversal is
  supposed to avoid

There is no CSS spelling of "continue from where you are at the speed you were
going." **So anything a finger touches needs a real spring, and a real spring
needs a dependency.**

`web/` does not have one. Its full runtime dependency set is `next`, `react`,
`react-dom` — no Motion, no Framer Motion, no spring implementation of any
kind. This is a statement of fact, not a complaint: `web/` is a marketing site
whose motion is entirely entrance animation on a timeline, which is exactly the
case CSS handles correctly. The constraint only becomes real when a surface
here gains a draggable, and the honest note is that on that day the answer is a
dependency, not a cleverer cubic-bézier.

Two rules that apply to the CSS-only case anyway:

- **Animate only `transform` and `opacity`.** Everything else lands on the main
  thread. (`grid-template-rows`, used by the FAQ accordion, is a deliberate
  exception — it is the only way to animate to intrinsic height, and it is
  paid for.)
- **Mirror the easing on reversible transitions** so the outbound path matches
  the return: inverse cubic-bézier control points for the two directions.

## 9. Spatial consistency

> "If something disappears one way, we expect it to emerge from where it came."

- **Enter and exit along the same path.** A panel that slides in from the right
  dismisses to the right. In-from-right, out-the-bottom reads as two unrelated
  objects.
- **Anchor to the source.** A menu, popover or sheet originates from the element
  that triggered it — set `transform-origin` to the trigger so the relationship
  between button and content is visible rather than inferred.
- **Hint in the direction of the gesture.** People predict a final state from a
  trajectory, so the in-between frames should point at the outcome instead of
  interpolating blindly toward it.

## 10. Type is motion's sibling

Both are the same discipline: a value that must change with its context rather
than being set once. The parallel is exact — a fixed `letter-spacing` across a
type scale is the same category of error as a fixed duration across a motion
system. Both are a single value standing in for a relationship.

- **Tracking is size-specific.** Large display text wants *negative* tracking;
  letters read too far apart as they grow. Small text wants slightly positive.
  A single `letter-spacing` for all sizes is wrong somewhere by construction.
- **Leading tracks size inversely.** Tight on large headings, looser on body.
  Looser again for scripts with tall ascenders and descenders — which is a live
  concern here, not a hypothetical: Telugu stacks matras above and below the
  baseline and gets cramped at a size and leading tuned for Latin.
  `Hero.module.css` and `public/demo/styles.css:269-274` both already make that
  adjustment by hand.
- **Hierarchy is weight + size + leading as a set**, not size alone. Weight adds
  presence without taking more space.
- **Scale layout with the text** — spacing in `rem`/`em`, not fixed px — so a
  user's larger text setting does not break the layout.

The Phase 1b token layer encodes the first two rules directly: `--track-display`
at `-0.02em` against `--track-lede` at `-0.01em` and body at none, and a
`--measure` of `66ch` that is a character count rather than a pixel width for
the same reason.

## 11. Reduced motion

Reduced motion does **not** mean no feedback. It means a gentler, non-vestibular
equivalent. Stripping the feedback entirely removes the confirmation that
something happened, which makes the interface worse for the person who asked for
the accommodation.

- **`prefers-reduced-motion: reduce`** — replace slides, springs and parallax
  with short opacity cross-fades. Drop elastic and overshoot entirely. Keep the
  opacity and colour changes that carry meaning.
- **`prefers-reduced-transparency: reduce`** — raise background opacity and drop
  the blur on translucent surfaces.
- **`prefers-contrast: more`** — near-solid backgrounds with a defined,
  contrasting border.

Also avoid full-viewport moving backgrounds, slow looping oscillations near
0.2 Hz (one cycle per five seconds), and abrupt brightness jumps.

`web/` honours the first signal and does it in two places, which is worth
knowing about because they are easy to mistake for redundancy:
`globals.css` collapses every animation and transition to `0.01ms` and flattens
`.reveal-hidden`, and `useScrollReveal.ts:12-20` *separately* checks the query
in JS and skips the IntersectionObserver path altogether. The CSS alone would
not be enough — the JS is what stops the observer from being the thing that
gates visibility. `HeroChat.tsx:79-83` does the same for the scripted chat,
calling `showAll()` instead of running its timer chain.

## 12. Ledger — what `web/` actually does today

Recorded, not fixed. Phase 1b changes no consumer.

| Fact | Count |
| --- | --- |
| Literal durations in `transition` / `animation` declarations | **44** |
| ...of those that use a `--dur-*` token | **0** |
| `var(--dur-*)` uses anywhere in `web/` | **2**, both on one rule |
| Duration tokens declared | 3 (`--dur-micro`, `--dur-base`, `--dur-enter`) |
| Duration tokens with a consumer | 1 (`--dur-enter`) |
| `--ease-spring` consumers | **1** |

The 44 are spread across thirteen stylesheets, the heaviest being
`Hero.module.css` (8), `legal.module.css` (6) and `Faq.module.css` (6). They are
written as bare literals — `.25s`, `0.2s`, `.42s`, `2s` — and none of them
resolves through a token. The easing beside them *is* tokenised: `var(--ease-out)`
appears throughout. So the system tokenised the curve and not the duration, and
has been consistent about it for long enough that the inconsistency looks
deliberate. It is not.

(A regex over the same declarations returns 46, not 44. The extra two are
`globals.css`'s `animation-duration: 0.01ms !important` and
`transition-duration: 0.01ms !important` inside the `prefers-reduced-motion`
block — accessibility overrides, not design durations. 44 is the design count.)

**The only consumer of a duration token in `web/` is the two-line
`.reveal-visible` rule** in `globals.css`, which spends `--dur-enter` twice:

```css
.reveal-visible {
  transition: opacity var(--dur-enter) var(--ease-out),
              transform var(--dur-enter) var(--ease-out);
}
```

`--dur-micro` and `--dur-base` have **no consumer at all**. They have been
declared, and never once read, since the file was ported.

**`--ease-spring` is `cubic-bezier(0.34, 1.56, 0.64, 1)`** — an overshoot curve;
the `1.56` control point carries the value past its target and back. It has
exactly one consumer, `Hero.module.css:220`:

```css
.bubbleShow { animation: pop .42s var(--ease-spring) forwards; }
```

and that class is added by `window.setTimeout` on a scripted timeline
(`HeroChat.tsx:90-109`), started by an IntersectionObserver when the chat
scrolls into view. **There is no gesture anywhere in the sequence, and therefore
no momentum for the overshoot to represent.** By §4's rule this is exactly the
case that should be critically damped: a bubble that appears on a timer did not
get thrown, and a bounce claims it did.

It is also, being a keyframe animation, uninterruptible — which costs nothing
here, because nothing can interrupt it.

None of this is a defect that breaks anything, and none of it is fixed in Phase
1b. `--dur-emerge` and `--ease-emerge` are added dormant alongside the existing
three durations and two curves, with no consumer but `/specimen`. What the
ledger establishes is the size of the job when a phase does take it on: 44
literal durations to route through tokens, two dead tokens to retire or use, and
one overshoot curve to justify or replace.
