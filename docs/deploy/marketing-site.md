# Deploying the marketing site (`web/`)

**What this puts up:** a private, un-indexable address serving the Prantivo
marketing site. Not a launch. Nobody outside the people you send the link to
should be able to find it, and this document's job is to make that true and
provable rather than hoped for.

**Read the STOP section first.** It is short and it is the only part where
getting it wrong is expensive.

Written for someone doing this at 11pm. Every command is copy-pasteable and
every check tells you what a wrong answer looks like, not just a right one.

Measured against `web/` at commit `0d74c85` with Next `15.5.19`, Node
`v22.17.1`, npm `10.9.2`.

---

## STOP — read before you deploy

**The four legal pages still contain 24 bracketed placeholders.** They say
`[REGISTERED ENTITY NAME]`, `[REGISTERED ADDRESS]`, `[DATE]`,
`[privacy@yourdomain.com]`, `[GRIEVANCE OFFICER NAME]` and so on — in a Privacy
Policy and a Terms of Service, which are the two documents on the site that are
statements of legal fact. The full list is in the appendix at the bottom of this
file.

Until entity registration completes (external clock **C-1**), this site goes up
with `NEXT_PUBLIC_ALLOW_INDEXING` **unset**, which serves `noindex` on every
route. That is the whole reason the flag exists.

**Do not set `NEXT_PUBLIC_ALLOW_INDEXING=true` until every placeholder in the
appendix is filled.** A public page carrying `[REGISTERED ADDRESS]` in a privacy
policy is worse than no page: it is an unfinished legal document with your name
on it, and once Google has it, taking the site down does not take it out of the
index for weeks.

---

## What you are deploying

A Next.js 15 App Router site. Nine routes, **all nine prerendered as static
HTML at build time**:

```
/  /privacy  /terms  /data-deletion  /acceptable-use
/specimen  /robots.txt  /sitemap.xml  /_not-found
```

There are **no API routes, no route handlers, no middleware, no server
actions, and no `fetch` anywhere in the source**. Verified by measurement, not
by reading: a network census over the running server recorded zero outbound
attempts across all nine routes, and a browser-side census recorded 166
requests across those routes, all of them to the site's own origin.

**This site does not talk to the backend.** It does not read the database, it
does not call the AI, it does not know the backend's address. It can be
deployed, redeployed and torn down with the backend down, and nothing about it
changes.

### Prerendered is not the same as "a static site"

Every page is static HTML, but `web/next.config.js` has no `output: "export"`,
so `next build` produces a **`.next` directory for a Node server**, not a folder
of files. Two consequences, and the second one matters:

1. Your host must run Node, or must understand Next.js natively (Vercel,
   Netlify, Cloudflare Pages with the Next adapter, Railway, Render, a plain VPS).
2. The `X-Robots-Tag` header comes from `next.config.js`, which is a **server**
   feature. If you ever switch to a true static export and drop the files on a
   dumb file host, that header silently stops being sent. The `<meta
   name="robots">` tag in the HTML still works, so you are not naked — but you
   are down from two protections to one, and `/robots.txt`, `/sitemap.xml` and
   `og-image.png` have no `<head>` to carry a tag. Do not switch hosts without
   re-running the verification in *Step 5*.

---

## Prerequisites

- **Node 18.18+ / 20+ / 22+.** Next 15.5.19 declares
  `^18.18.0 || ^19.8.0 || >= 20.0.0`. Verified on v22.17.1.
- **A working internet connection at build time.** This surprises people: the
  build is offline *at runtime* but is **not** offline while building.
  `next/font/google` downloads Geist, Geist Mono and Noto Sans Telugu from
  `fonts.googleapis.com` and `fonts.gstatic.com` and self-hosts them into the
  bundle. A build on a machine that cannot reach Google Fonts fails or ships
  without the Telugu face, and Telugu without its face renders as empty boxes on
  the homepage — which looks like a content bug, not a build bug.
- **A host account.** `web/vercel.json` exists, so Vercel is the path of least
  resistance; any Node host works.
- **Nothing else.** No database, no environment secrets, no backend.

---

## Step 1 — the environment variables

There are five, all `NEXT_PUBLIC_*`, all read at **build time**. Setting one on
a running host does nothing until you rebuild.

| Variable | Private-preview value | What it feeds |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | the exact origin you are deploying to, scheme included, **no trailing slash** — e.g. `https://prantivo-preview.vercel.app` | `metadataBase`, the canonical link, both Open Graph image URLs, `robots.txt`'s sitemap pointer, all five `sitemap.xml` entries |
| `NEXT_PUBLIC_CONTACT_EMAIL` | a real address someone reads | the Organization JSON-LD `contactPoint.email` |
| `NEXT_PUBLIC_ALLOW_INDEXING` | **leave unset** | the noindex on every route — see STOP above |
| `NEXT_PUBLIC_X_URL` | leave unset | Organization JSON-LD `sameAs` |
| `NEXT_PUBLIC_LINKEDIN_URL` | leave unset | Organization JSON-LD `sameAs` |

Three things that will bite you:

- **`NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_CONTACT_EMAIL` are required and the
  build enforces it.** There is no fallback in the repository. Omit one and the
  build stops with, verbatim:

  ```
  Error: siteConfig: contactEmail is empty. Set NEXT_PUBLIC_CONTACT_EMAIL in the
  deploy environment — see web/.env.example. Production builds refuse to ship
  placeholders.
  > Build error occurred
  [Error: Failed to collect page data for /sitemap.xml]
  ```

  It names the field. Read the first line, not the second — "Failed to collect
  page data for /sitemap.xml" is where the guard happened to fire, not the
  problem.

- **Do not invent a social handle.** The same guard rejects `yourdomain.com`,
  `yourhandle`, `yourcompany` and anything in `[square brackets]`. Unset means
  "this account does not exist" and renders no link at all, which is the
  truthful answer.

- **On Vercel only**, `NEXT_PUBLIC_SITE_URL` may be left unset — the platform's
  `VERCEL_PROJECT_PRODUCTION_URL` is used and prefixed with `https://`. Set it
  explicitly anyway. It costs nothing and it is one fewer thing that behaves
  differently on the next host.

Optional but recommended: set `NEXT_TELEMETRY_DISABLED=1`. `next build` posts
anonymous usage data to `telemetry.nextjs.org` — a build-time census recorded 8
such requests. It is Vercel's, it is documented, and it carries nothing of
yours; turn it off anyway so that "the build makes no calls I did not ask for"
stays a statement you can check.

---

## Step 2 — deploy

### Vercel (recommended — `vercel.json` already exists)

1. New Project → import this repository.
2. **Root Directory: `web`.** This is the one setting people miss. Get it wrong
   and Vercel tries to build the backend, which needs a database and will fail
   in a way that has nothing to do with the marketing site.
3. Framework Preset: **Next.js** (auto-detected).
4. Build Command: leave as the default (`next build`).
5. Output Directory: leave **blank**. Vercel handles `.next` itself. Do not type
   `out` — there is no `out` directory; see *Prerendered is not the same as "a
   static site"* above.
6. Environment Variables: add the two required ones from Step 1. **Leave
   `NEXT_PUBLIC_ALLOW_INDEXING` out entirely** — do not add it set to `false`,
   just do not add it.
7. Deploy.

`web/vercel.json` adds `X-Content-Type-Options`, `X-Frame-Options`,
`X-XSS-Protection`, `Referrer-Policy` and `Permissions-Policy`. It does **not**
carry the robots header — that lives in `next.config.js` on purpose, so it
survives leaving Vercel.

If you want the address itself to be unguessable rather than merely
un-indexable, turn on Vercel's **Deployment Protection**. That is a Vercel
feature and it does not travel; the `noindex` is the part that does.

### Any other Node host (Railway, Render, Fly, a VPS)

```bash
cd web
npm ci                 # not `npm install` — ci installs exactly the lockfile
npm run build          # with the Step 1 variables set in the environment
npm run start          # serves on port 3100
```

`npm run start` is `next start --port 3100`. Put a reverse proxy in front for
TLS. Port 3100 is deliberate — **3000 is the backend**, and the two must not
collide on a box that runs both.

The environment variables must be present **for `npm run build`**, not for
`npm run start`. Setting them only at start time produces a build with an empty
`metadataBase` and a `sitemap.xml` full of relative URLs, and no error anywhere.

---

## Step 3 — verify the noindex is live

**Do this every time, on the real address.** It takes thirty seconds and it is
the only step that checks the thing you actually care about.

```bash
SITE=https://your-preview-address.example    # no trailing slash

for r in / /privacy /terms /data-deletion /acceptable-use /specimen \
         /robots.txt /sitemap.xml /this-route-does-not-exist; do
  printf '%-28s ' "$r"
  curl -sI "$SITE$r" | tr -d '\r' | grep -i '^x-robots-tag:' || echo '*** NO HEADER ***'
done
```

Every line must read:

```
X-Robots-Tag: noindex, nofollow, noarchive
```

Then the meta tag, which is the half that survives a host that drops headers:

```bash
curl -s "$SITE/" | grep -o '<meta name="robots"[^>]*>'
# expected: <meta name="robots" content="noindex, nofollow"/>
```

Then the two files that could contradict all of it:

```bash
curl -s "$SITE/robots.txt"
# expected, exactly:
#   User-Agent: *
#   Disallow: /
#   (and NO "Sitemap:" line)

curl -s "$SITE/sitemap.xml"
# expected: an EMPTY <urlset/> — no <url> entries at all
```

**If `robots.txt` says `Allow: /`, or `sitemap.xml` lists five URLs, or any
route is missing the header — you have `NEXT_PUBLIC_ALLOW_INDEXING=true` set
somewhere.** Remove it and **redeploy**. Clearing the variable is not enough on
its own; the value is compiled into the build.

### Two routes that are noindexed in both states — this is correct

- **`/specimen`** sets its own `robots: { index: false, follow: false }` in
  `web/app/(marketing)/specimen/page.tsx`. It is an internal design-token
  reference surface and is never meant to be public, flag or no flag.
- **`/_not-found`** (any 404) is noindexed by Next itself.

Seeing `noindex` on those two after you eventually flip the flag on is not a
bug and does not mean the flip failed. Check `/` and `/privacy`.

---

## Step 4 — sanity-check the pages

Open each of these and confirm it renders rather than erroring. All nine
returned HTTP 200 (404 for the not-found probe) when measured:

| Route | What you should see |
|---|---|
| `/` | homepage; the conversation demo plays; a language selector switches it to Telugu |
| `/privacy` `/terms` `/data-deletion` `/acceptable-use` | legal pages **with visible `[BRACKETED]` placeholders** — expected, see STOP |
| `/specimen` | the design-token reference page |
| `/robots.txt` `/sitemap.xml` | as in Step 3 |
| any nonsense path | the 404 page |

The Telugu is worth ten seconds of attention. If it renders as rows of empty
rectangles, the build could not reach Google Fonts and the Noto Sans Telugu face
is missing. Rebuild on a machine with working DNS.

---

## Step 5 — if you ever change hosts

Re-run **Step 3** in full. The `<meta>` tag travels with the HTML and always
works. The `X-Robots-Tag` header comes from `next.config.js` and only exists on
a host that runs the Next server. A move to a static-file host silently removes
it from every response, including `/robots.txt`, `/sitemap.xml` and
`og-image.png`, which have no HTML head to fall back on.

---

## Tearing it down

**Vercel:** Project Settings → scroll to the bottom → *Delete Project*. Pausing
or disabling it is not enough if the concern is that it was crawled — but note
that nothing here was ever indexable, which is exactly why deletion is a clean
operation rather than a scramble.

**A Node host:** stop the process and remove the deployment. On a VPS,
`web/.next` is the whole artifact; deleting the checkout removes everything.

**If a route ever did get indexed** (only possible if the flag was set to
`true`): deleting the site is the wrong first move. Google will not drop a URL
it cannot fetch, and a deleted site returns nothing for the crawler to read.
Instead, leave it up serving `noindex`, submit the URLs to Google Search
Console's Removals tool, wait for them to drop out, and only then take it down.

---

## What is NOT in scope here

- The backend. It deploys independently (Issue 20, `docs/deploy/prod-readiness.md`).
  Nothing in this document touches it, and nothing in `web/` depends on it.
- A custom domain. A private preview does not need one, and attaching the real
  domain to a placeholder-carrying site is the specific mistake the STOP section
  exists to prevent.
- Google Search Console, sitemap submission, rich-results validation. All of
  those are launch tasks, and this is not a launch.

---

## Appendix — the 24 placeholders blocking a public launch

Enumerated at `0d74c85`. These are the bracketed tokens across the four
`web/app/(legal)/*/page.tsx` files. Each must be filled before
`NEXT_PUBLIC_ALLOW_INDEXING` may be set to `true`.

Most are blocked on external clock **C-1** (business entity registration); the
dates are blocked on nothing but the decision to launch, and the email addresses
are blocked on the domain existing.

| # | File | Line | Token |
|---|---|---|---|
| 1 | `acceptable-use/page.tsx` | 47 | `[DATE]` |
| 2 | `acceptable-use/page.tsx` | 160 | `[abuse@yourdomain.com]` |
| 3 | `data-deletion/page.tsx` | 47 | `[DATE]` |
| 4 | `data-deletion/page.tsx` | 69 | `[privacy@yourdomain.com]` |
| 5 | `data-deletion/page.tsx` | 112 | `[privacy@yourdomain.com]` |
| 6 | `data-deletion/page.tsx` | 122 | `[30]` |
| 7 | `data-deletion/page.tsx` | 129 | `[privacy@yourdomain.com]` |
| 8 | `privacy/page.tsx` | 47 | `[DATE]` |
| 9 | `privacy/page.tsx` | 48 | `[DATE]` |
| 10 | `privacy/page.tsx` | 92 | `[REGISTERED ENTITY NAME]` |
| 11 | `privacy/page.tsx` | 94 | `[REGISTERED ADDRESS]` |
| 12 | `privacy/page.tsx` | 96 | `[privacy@yourdomain.com]` |
| 13 | `privacy/page.tsx` | 235 | `[privacy@yourdomain.com]` |
| 14 | `privacy/page.tsx` | 286 | `[privacy@yourdomain.com]` |
| 15 | `privacy/page.tsx` | 318 | `[GRIEVANCE OFFICER NAME]` |
| 16 | `privacy/page.tsx` | 320 | `[privacy@yourdomain.com]` |
| 17 | `privacy/page.tsx` | 322 | `[REGISTERED ADDRESS]` |
| 18 | `terms/page.tsx` | 47 | `[DATE]` |
| 19 | `terms/page.tsx` | 48 | `[DATE]` |
| 20 | `terms/page.tsx` | 86 | `[REGISTERED ENTITY NAME]` |
| 21 | `terms/page.tsx` | 258 | `[CITY]` |
| 22 | `terms/page.tsx` | 266 | `[legal@yourdomain.com]` |
| 23 | `terms/page.tsx` | 267 | `[REGISTERED ENTITY NAME]` |
| 24 | `terms/page.tsx` | 268 | `[REGISTERED ADDRESS]` |

**A 25th, outside the legal pages:** `web/lib/siteConfig.ts` sets
`legalEntityName: "[REGISTERED ENTITY NAME]"` and carries an explicit
**exemption** from the build-time placeholder guard so that a build can complete
while it is still unfilled. That string is published in the Organization JSON-LD
on every page. Fill it and **delete the exemption in the same commit** — that is
what turns the guard back into a real backstop. Tracked as F-F003 in
`docs/audit/2026-07-frontend.md`.

To re-derive this list at any later commit:

```bash
git grep -nE "\[[A-Za-z0-9][^]]*\]" -- 'web/app/(legal)/*/page.tsx' \
  | grep -v 'siteConfig.ogImage'
```

The `grep -v` drops four hits of `[siteConfig.ogImage]`, which is a JavaScript
array literal in each page's metadata block and not a placeholder.

---

## How the noindex actually works, if you need to change it

One environment variable drives four independent mechanisms, all of which must
agree. `NEXT_PUBLIC_ALLOW_INDEXING` must be **exactly** the string `true` to
allow indexing; unset, empty, `false`, `1`, `yes` and any typo all mean *not
indexable*. The asymmetry is deliberate — a typo has to fail in the direction
you can recover from.

| # | Mechanism | Where | Covers |
|---|---|---|---|
| 1 | `X-Robots-Tag` response header | `web/next.config.js` | **everything**, including `/robots.txt`, `/sitemap.xml`, images and JS chunks |
| 2 | `<meta name="robots">` | `web/app/layout.tsx` | every HTML route; the only one that survives a host that ignores `next.config.js` |
| 3 | `/robots.txt` → `Disallow: /` | `web/app/robots.ts` | well-behaved crawlers, before they fetch |
| 4 | `/sitemap.xml` → empty `<urlset/>` | `web/app/sitemap.ts` | removes the invitation to crawl |

The rule itself is written twice: `indexingAllowed` in `web/lib/siteConfig.ts`
(which 2, 3 and 4 import) and one line at the top of `web/next.config.js` (for
1). `next.config.js` is CommonJS and is loaded by the Next CLI before any
TypeScript compiles, so it cannot import the TypeScript module. **If you change
the rule, change it in both places** — the failure this duplication can cause is
the header and the meta tag disagreeing, which is exactly what Step 3 checks.

One thing worth knowing about mechanism 3: `Disallow: /` stops a crawler
*fetching* the page, which also stops it *seeing* the noindex. The header and
the meta tag are what actually remove a page from an index. `robots.txt` is the
outer fence, not the mechanism.
