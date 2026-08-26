# Filed — `shootD5b` §E, characterised: a harness race, not a product race

The intermittent red on `scripts/portal/shootD5b.js` section E (`pricing.html`,
380×820):

```
✗ after scroll: header pinned, title visible, description gone:
  [false,76,true,true] (expected [true,56,true,false])
```

Polish 2 called it environmental. Polish 4 proved its own diff could not cause it
but left the flake unexplained and unfiled (`docs/os/state.md`, *"still
unexplained and unfiled"*). This is the characterisation, and the fix that
follows from it.

**Verdict: HARNESS race.** The sticky header is not defective. No user is
affected. `shell.js:795` behaved correctly on every observation, including every
red one.

---

## The central question, and the measurement that settles it

`is-stuck` toggles on `window.scrollY > 4` (`shell.js:795`). A red means the
class was absent at the read. Either the harness read before the page scrolled
(a test defect) or the product failed to apply the class to a scroll that did
happen (a user-facing sticky-header bug). Those two have to be told apart before
anything is changed, because a longer wait applied to a product race hides a real
defect.

They are told apart by one quantity: **was there a scroll event at all.** A
capture-phase `scroll` counter was installed at document start, via
`Page.addScriptToEvaluateOnNewDocument`, before any page script parses — so it
sees every scroll event the shell's own listener could see.

| | greens (66 observations) | reds (26 observations) |
|---|---|---|
| `document.scrollHeight` at the scroll | 2569–2713 | **820, always** |
| `window.innerHeight` | 820 | 820 |
| max scrollable extent | 1749–1893 | **0** |
| `.tr` rows rendered | 5 | **0** |
| `window.scrollY` after `scrollTo(0,600)` | 600 | **0** |
| **scroll events dispatched** | **≥ 1** | **0, always** |
| `.page-head.is-stuck` | present at the **first sample, t+25ms — 66/66** | absent |

Every red has `scrollHeight === innerHeight`: the document is exactly one
viewport tall, there is nothing to scroll, `window.scrollTo(0, 600)` is a no-op,
**no scroll event is dispatched at all**, and `scrollY` stays 0. `is-stuck` being
absent at `scrollY === 0` is `shell.js:795` doing precisely what it says.

**Across 92 instrumented observations there were ZERO product-race observations** — not one
case of `scrollY > 4` at the read with `is-stuck` absent. The separation is total:
every green had `scrollHeight >= 2569`, every red had `scrollHeight === 820`, with
no overlap. And the product never once lagged: in all 66 greens the class was
already present at the **first sample after the scroll, 25ms** — 16× inside the
400ms the assertion allowed. The 400ms was never the marginal quantity.

`76` is simply `.page-head`'s natural unscrolled `top` while the page is still
loading. (Once the readiness strip lands above it, the same unscrolled header
reads `220` — the other red signature seen this session, and in the run under a
slowed pricing API below. Both mean "never scrolled".)

## Mechanism

1. §E gates the page on `waitFor: ready`, where `ready` is
   `document.querySelector('.card')` (`shootD5b.js:586`).
2. On `pricing.html` the first `.card` is **`#loadCard`, the loading skeleton** —
   present in the static HTML at first paint (`public/portal/pricing.html:53`),
   and never removed, only `hidden = true`d once the fetch lands
   (`public/portal/pricing.js:347`).
3. **The gate is therefore vacuous.** It is satisfied before any data exists.
4. `probe()` then sleeps its default 600ms and reads. If
   `GET /portal/api/me` → `GET /portal/api/config/pricing` has not completed
   inside that window, the document is still skeleton-height: `scrollHeight`
   exactly 820.
5. `scrollTo(0, 600)` no-ops. 400ms later the assertion reads a page that never
   moved.

**Waiting longer after the scroll cannot fix this.** `scrollTo` is
fire-and-forget: once it has no-opped there is nothing left in flight to arrive.
This is the reason the fix had to be a gate *before* the scroll rather than a
larger timeout after it — and the reason "just bump the 400" would have been a
false gate rather than a fix.

## Reproduction

Deterministic lever: a document-start `fetch` shim that stalls every
`/portal/api/` response by a fixed amount, sweeping that amount.

| injected latency | result |
|---|---|
| 100 / 150 / 200ms (×3 each) | 9/9 green, `max` 1749–1893 |
| 250ms (×3) | **2/3 red**, reds at `max = 0` |
| 300 / 350 / 400ms (×3 each) | **9/9 red** |
| 400 … 3000ms | **11/11 red**, every one `[false,76,true,true]` |

It is a **cliff, not a distribution**: the document is either scrollable
(`max = 1893`, always green) or exactly viewport-height (`max = 0`, always red).
Nothing in between was ever observed. The margin is roughly 500–600ms of extra
round-trip latency — small enough that ordinary machine load crosses it, which is
what "environmental" was pointing at.

Confirmed end-to-end on the **byte-unmodified** `scripts/portal/shootD5b.js`,
with the server slowed instead of the test edited
(`NODE_OPTIONS=--require` shim delaying one route by 900ms): §E red,
`[false,220,true,true]`.

And reproduced **naturally**, no lever at all, on a baseline run at HEAD on a
clean slate: `[false,76,true,true]` — the brief's exact signature.

## Rate

Natural §E reads this session, no injected latency: **2 red / 42 = 4.8%,
Wilson 95% CI [1.3%, 15.8%]**. Pooled with Polish 4's recorded tallies (1 red in
4 with its diff, 0 in 5 at HEAD, since shown unreachable): **3/51 = 5.9%,
CI [2.0%, 15.9%]**.

Both 20-trial batches of back-to-back warm loads returned 0/20. That arm's own
95% upper bound is **16.1%** — at a ~5% rate, **twenty quiet runs cannot tell a
fixed flake from an unfixed one.** This is the trap `state.md` already names
("the mechanism, not the run count"). The evidence for the fix below is the
lever, not the tally.

## The fix (`shootD5b.js` §E only)

Gate on real scrollable height *before* scrolling, then poll for the class
instead of sleeping a guess:

```js
afterReady: (c, sid) =>
  waitForSelector(c, sid, 'document.documentElement.scrollHeight > window.innerHeight + 500'),
```

Both waits use the harness's own `waitForSelector`: bounded at 60 × 150ms and
throwing the expression it gave up on. Verified loud — at 12s of injected latency
it fails with `selector never appeared: document.documentElement.scrollHeight >
window.innerHeight + 500`, naming the condition, rather than silently reading a
skeleton.

This is **not a new pattern** — and the fact that it is not is only discoverable
on a developer machine, which is itself worth recording. A D2-era harness at
`scripts/portal/shots/shootD2.js` already carries this exact gate, with the same
constant, and its comment already names the same mechanism on `hours.html`:

> The hours grid renders AFTER the config fetch, so the document is not yet tall
> enough to scroll when `#hoursForm` first exists. Scrolling then clamps to 0 and
> the shot silently proves nothing — wait for real scrollable height first.

```js
await waitForSelector(c, sid,
  'document.documentElement.scrollHeight > window.innerHeight + 500');
await c.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 420)' }, sid);
```

⚠️ **That file is NOT IN THE REPOSITORY.** `scripts/portal/shots/` is the
screenshot output directory and is gitignored (`.gitignore:163`), so `shootD2.js`
is untracked and exists only where someone happened to leave it. `git ls-files`
matches nothing for `shootD2`. The lines are quoted above precisely because the
citation cannot be followed from a clone — a harness carrying the one prior
diagnosis of this bug is sitting inside an ignored output directory, where the
next person to hit it will not find it. §E is the same assertion on a different
page, written without the gate, six sessions later; that is what an unreachable
precedent costs.

Result: the exact sweep that was **13/14 red is 0/14 red**, including at 3000ms —
7.5× beyond the old cliff. Fisher exact two-sided **p = 7.5e-7**. The polled read
also returns in 28–158ms instead of a flat 414ms, so the fixed test is faster
than the flaky one.

---

## Found, NOT fixed — the same vacuous gate elsewhere

Out of this session's scope. Enumerated so the next session starts from the
analysis. **The common defect is `waitFor` on a selector that the loading
skeleton already satisfies**, after which a fixed `settle` is the only thing
standing between the read and un-fetched content.

### 1. `shootD5a.js:589-591` — the same family, caught red in this session's own baseline

```
✗ Home: the ring is what says it instead: false (expected true)
```

`waitFor: ready` (`.card`) on `index.html`, then the default 600ms settle, then
`!!document.querySelector('.ring, .ring-sk')`. Red on the first clean-slate
baseline run, green on immediate re-run — same signature as §E, same vacuous
gate. **Not fixed** (out of scope: another shoot script). It should get §E's
treatment: gate on the thing actually asserted, not on `.card`.

### 2. Every `waitFor: ready` site, both scripts

`ready` is `.card` in `shootD4.js`, `shootD5a.js` and `shootD5b.js` alike. The
sites are only safe where the assertion happens to hold on a skeleton too:

- `shootD4.js`: 525, 619, 629, 643, 655, 711, 741, 808, 824, 827, 837, 855
- `shootD5a.js`: 515, 531, 548, 560, **589**, 593, 707, 714, 731, 754, 756, 786, 812, 815
- `shootD5b.js`: 883, 891 (891 is §E, now gated)

`shootD5b.js:320`, `:387`, `:873` gate on `.content`, which is shell chrome and
is even weaker.

### 3. Fixed timeout after a scroll (the specific pattern asked for)

| site | pattern | risk |
|---|---|---|
| `shootD5b.js:895` | `scrollTo(0,600)` + fixed 400ms | **was the flake — fixed** |
| `shootD5b.js:955` | `scrollIntoView` + fixed 300ms | low: page gated on `FORM_READY` (`:263`), which reads `#saveNote` text and so cannot pass on a skeleton |
| `f3.js:510-511` | `scrollIntoView` in an iframe + fixed 300ms | screenshot only, no assertion; a clamped scroll yields a wrong shot, not a red |
| `shots/shootD2.js:418` | `scrollTo(0,420)` + fixed 500ms | **already correct** — gated on real scrollable height first; this is the pattern §E now copies. Untracked/gitignored, see above |
