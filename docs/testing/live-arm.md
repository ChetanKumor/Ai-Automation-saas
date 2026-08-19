# The live arm — running the suite against real Gemini

The test suite has two arms. They run the same tests over the same code; they
differ in one thing, whether an embedding call reaches Google.

| | command | external calls | who runs it |
|---|---|---|---|
| **default** | `npm test` | **zero** | `os:check`, every gate, CI, you |
| **live** | `LIVE_GEMINI=1 npm test` | ~12 embeddings | deliberately, by a human |

The switch is `tests/_support/embedTransport.js`, loaded as a `--require`
preload by the `test` script (the same seam `testEnv.js` uses for the database).
It replaces `GenerativeModel.prototype.embedContent` — the SDK's wire call — and
nothing above it. Everything in `knowledgeService.embed()` still runs in both
arms: the budget class, the `AbortController`, the deadline timer, the `signal`
relay, the `result.embedding.values` unwrap.

## Running one file directly

`node --test tests/portal/portalFaqs.integration.test.js` does **not** load the
`--require` preload — npm's `test` script is what sets it up. That is the exact
workflow an attribution session lives on (the predecessor ran one file 60 times),
so the three files that embed require the transport themselves:

```js
require('../_support/embedTransport');
```

Requiring it *is* the install — the module patches the SDK prototype at load, and
`require` caches, so the line is a no-op under `npm test`. Verified: those three
files run directly, with `net-census.js` attached and the preload deliberately
omitted, report `0 of them EXTERNAL`.

A new test that embeds needs that line too, or it opts itself back into live
calls without saying so. The census is how you find out.

## Why the live arm exists at all

Because the default arm cannot see Fault A.

On 2026-08-18, run 20 of 50, one embedding call **stalled**: it did not answer,
and the 10,000 ms `interactive` deadline (`knowledgeService.js:66`) is the only
reason a number was ever recorded for it — `{"ok":false,"ms":10085.7,"err":"…Request
aborted…"}`. One call in 334. Against a measured p99 of 1571 ms and a
next-slowest of 1903 ms, that is not the tail of the healthy distribution but a
separate mode with **no upper bound**, which is why no finite deadline escapes
it and why raising the deadline would only lengthen the red.

It was caught because the call was live. Stubbing every embedding call buys
determinism by making that stall permanently unobservable, and the next
occurrence goes back to being a ghost. So the live arm stays runnable, and stays
instrumented.

## What it costs

12 embedding requests per full run, in three files:

```
5  tests/portal/portalFaqs.integration.test.js             (the retrieval test)
5  tests/portal/portalOnboarding.integration.test.js       (5x faqService.createFaq)
2  tests/portal/portalKnowledgeSummary.integration.test.js (a `before` hook)
```

Measured, not estimated — see **Verifying the census** below. Latency measured
over 334 calls on 2026-08-18: p50 482 ms, p99 1571 ms, range 424–1903 ms,
regardless of whether Google answered with a result or a rejection.

Needs a working `GEMINI_API_KEY` and network. To inventory the live call sites
without spending a single request, run with a deliberately invalid key — every
live call fails fast and names itself, and nothing is charged:

```bash
GEMINI_API_KEY='<bogus>' LIVE_GEMINI=1 npm test
```

## Reading the instrumentation

Both arms record every embedding call as `{ ok, ms, live, err? }`. The retrieval
test in `portalFaqs` embeds that record in its own assertion message, so a
failure reports which arm ran, what each call cost, and why it failed — instead
of the bare `500 !== 200` that made three earlier sightings unattributable
(`routes.js:1988` collapses every cause into one string, and the file's
`LOG_LEVEL = 'silent'` suppresses the only line that carries it).

```
POST /portal/api/faqs → HTTP 500, expected 200. body={"error":"Failed to add this FAQ"}
  arm=LIVE embedCalls=[{"ok":true,"ms":612.4,"live":true},{"ok":false,"ms":10085.7,"live":true,"err":"…Request aborted…"}]
```

A record with `ok:false` and an `ms` at or just above a deadline value
(3,000 / 10,000 / 30,000 — `EMBED_BUDGETS` in `knowledgeService.js`) is another
Fault A sighting. Add it to `docs/os/state.md`; do not raise the deadline.

## Fault A's shape without the network

The default arm cannot *observe* Fault A in the wild, but it can *reproduce* its
shape on demand, which is what keeps the handling under test:

```js
embedTransport.stallNext();   // the call never answers; only the deadline ends it
embedTransport.failNext();    // the call rejects like an SDK transport error
```

Both are exercised in `portalFaqs.integration.test.js` (`an embedding that never
answers is ended by the interactive deadline`, and `an embedding transport
failure is a 500`). They are not a substitute for the live arm — a reproduction
proves the handling, only a live run can tell you the rate.

## Verifying the census

The "zero external calls" claim in the table above is a measurement, and it is
re-measurable. `scripts/net-census.js` records every outbound request the suite
makes, at the `fetch` / `http` / socket layers:

```bash
CENSUS_OUT="$PWD/census.jsonl" node --test \
  --require ./tests/_support/testEnv.js \
  --require ./tests/_support/embedTransport.js \
  --require ./scripts/net-census.js \
  "tests/**/*.test.js"

node scripts/net-census.js census.jsonl
```

(`node --test` directly rather than `npm test` because npm's Windows launcher
rejects `NODE_OPTIONS`; the arguments are the ones the `test` script uses.)

The default arm must report `0 of them EXTERNAL`. Adding `LIVE_GEMINI=1` to the
same command is the positive control — it must report 12 fetches to
`generativelanguage.googleapis.com`, plus the TLS connects they shared.

The census never records headers, bodies or query strings: the API key rides on
exactly these requests, and a census artifact that leaks one is worse than no
census.
