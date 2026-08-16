# Zyon Marketing Website

A standalone Next.js marketing site for Zyon — the AI WhatsApp receptionist and automation platform. Lives inside the main repo at `web/` but is **completely isolated** from the backend. No shared dependencies, no shared routes, no shared build.

## Stack

- **Next.js 15** (App Router, static export)
- **TypeScript** (strict mode)
- **Plain CSS + CSS Modules** (no Tailwind, no Sass)
- **next/font** for Geist Sans and Geist Mono
- Zero runtime dependencies beyond React and Next.js

## Local development

```bash
cd web
npm install
npm run dev
```

Runs on **port 3100** (`next dev --port 3100`). The backend runs on port 3000 — no conflict.

## Production build

```bash
npm run build    # static generation, all routes prerendered
npm run start    # serves the production build on port 3100
```

All routes are statically generated at build time (no SSR, no API routes).

## Environment variables

`lib/siteConfig.ts` resolves everything that varies per deploy from the
environment **at build time**. There is no production fallback in the
repository: a production build with a required value missing, or with any value
still holding a placeholder, **fails** with an error naming the field.

Copy `.env.example` to `.env.local` for local work and set the same variables in
the deploy environment. The file is the authority; this table mirrors it.

| Variable | Required | Feeds |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | **Yes** (production) | `metadataBase`, canonical link, both OG image URLs, `robots.txt` sitemap pointer, all five `sitemap.xml` entries |
| `NEXT_PUBLIC_CONTACT_EMAIL` | **Yes** (production) | Organization JSON-LD `contactPoint.email` |
| `NEXT_PUBLIC_X_URL` | No | Organization JSON-LD `sameAs` |
| `NEXT_PUBLIC_LINKEDIN_URL` | No | Organization JSON-LD `sameAs` |

Notes:

- **The brand name is not an environment variable.** It is the `BRAND` constant
  in `lib/siteConfig.ts` — identical in every environment, so one edit renames
  the site. `BRAND` is the trading name, never the registered legal entity.
- **Socials are optional and nullable.** Unset means the account does not exist
  and no link is rendered anywhere. Do not substitute a plausible-looking
  handle — the guard rejects the common placeholder forms, and a link to a 404
  is a false statement about the company either way.
- **On Vercel**, `NEXT_PUBLIC_SITE_URL` may be left unset: the platform-supplied
  `VERCEL_PROJECT_PRODUCTION_URL` is used as a fallback and prefixed `https://`.
  Setting it explicitly is safer and is required on any other host.
- **In development** nothing is required. The origin falls back to
  `http://localhost:3100` and the guard does not run.
- `legalEntityName` is deliberately **exempt** from the guard while it reads
  `[REGISTERED ENTITY NAME]`. It is blocked on C-1 (business entity
  registration, `docs/os/clocks.md`) and tracked as F-F003. The exemption is
  removed in the same commit that fills the legal pages.

## Folder structure

```
web/
├── app/
│   ├── layout.tsx              # Root layout: fonts, metadata, Organization JSON-LD
│   ├── globals.css             # Design system tokens (single source of truth)
│   ├── sitemap.ts              # /sitemap.xml (5 URLs)
│   ├── robots.ts               # /robots.txt
│   ├── (marketing)/
│   │   ├── layout.tsx          # Nav + Footer wrapper
│   │   └── page.tsx            # Homepage: 12 sections + JSON-LD
│   └── (legal)/
│       ├── layout.tsx          # Legal chrome: topbar + legal footer
│       ├── legal.module.css    # Shared legal page styles
│       ├── privacy/page.tsx    # Privacy Policy (TOC + content)
│       ├── terms/page.tsx      # Terms of Service (TOC + content)
│       ├── data-deletion/page.tsx    # Data Deletion (single column)
│       └── acceptable-use/page.tsx   # Acceptable Use (single column)
├── components/
│   ├── Nav.tsx                 # Fixed nav with scroll blur + mobile menu
│   ├── Footer.tsx              # 5-column footer with legal links
│   ├── ui/
│   │   ├── Button.tsx          # Primary / secondary / ghost / large variants
│   │   ├── Eyebrow.tsx         # Section label (dot or bar variant)
│   │   └── Reveal.tsx          # Scroll-reveal wrapper (IntersectionObserver)
│   └── sections/               # One component per homepage section
│       ├── Hero.tsx + HeroChat.tsx
│       ├── Proof.tsx
│       ├── Problem.tsx
│       ├── HowItWorks.tsx
│       ├── Platform.tsx
│       ├── Solutions.tsx
│       ├── Why.tsx
│       ├── Trust.tsx
│       ├── Pricing.tsx
│       ├── Faq.tsx + faqData.ts
│       └── FinalCta.tsx
├── lib/
│   ├── siteConfig.ts           # Central config + build-time placeholder guard
│   └── useScrollReveal.ts      # Scroll-reveal hook (respects reduced-motion)
├── public/
│   └── favicon.svg             # SVG favicon
├── design-reference/           # Static HTML design mockups (not deployed)
├── vercel.json                 # Security headers for Vercel deployment
├── package.json
└── tsconfig.json
```

## Design system

All design tokens live in `app/globals.css` — colors, spacing, radii, motion curves, type scales. To change a token, edit it there; every component references these variables via `var(--token-name)`.

The site renders on **Warm Paper** as of Phase 2 S2. The tokens below are the
dark scale the site was built on; every one of them is now an *alias* pointing
at a paper token declared lower in the same `:root`, so the component
stylesheets did not have to move. Phase 3 S3 deletes the alias layer and renames
the consumers.

Key token groups:
- `--ground` / `--ground-sunk` / `--ground-raised` — the paper scale (`#FAF8F5` / `#F2EEE8` / `#FFFFFF`)
- `--ink-strong` / `--ink-soft` / `--ink-faint` — the ink scale. `--ink-faint` is **NON-TEXT ONLY** (2.41:1); it may never paint a glyph
- `--rule` / `--rule-strong` — paper hairlines
- `--ink-900` / `--surface-*` — **aliases** onto the paper scale, mapped by role (a raised card goes up to `--ground-raised`, a recess goes down)
- `--text-primary` / `--text-secondary` / `--text-tertiary` — **aliases** onto the ink scale. Note `--text-tertiary` collapses onto `--ink-soft`: it failed AA on the old ground and does not get a paper counterpart
- `--border` / `--border-strong` — **aliases** onto `--rule` / `--rule-strong`
- `--accent` / `--accent-glow` — functional teal `#0f766e`, the portal's value (links, focus colour, live dots). `--accent-glow` is that colour at 0.35 alpha and is decorative only
- `--accent-on-ground` / `--answered` — functional colour on paper, consumed by the legal group and `/specimen`
- `--wa-*` — WhatsApp-authentic palette, deliberately still dark (hero chat + micro-visual mockups only)
- `--r-*` — border radii, the pre-v2 4/8/12 scale. `--rad-*` (2/6/10) is the v2 scale; the legal group and `/specimen` use it, marketing has not migrated yet
- `--elev-2` — the one shadow; re-derived for paper at `rgba(23, 21, 15, 0.06)`
- `--ease-*` / `--dur-*` — motion

`docs/design/brand-values.md` records which of these are shared with the portal
and the demo surfaces, and `tests/design/tokenDrift.test.js` makes that record
binding.

All animations respect `prefers-reduced-motion: reduce` — a global rule in `globals.css` kills all durations, and component-level overrides ensure immediate-show fallbacks.

## Pre-launch checklist

Complete these before going live, in priority order:

### Identity and domain (do first)
1. ~~Replace `siteUrl` in `lib/siteConfig.ts`~~ — **done.** The origin is now
   `NEXT_PUBLIC_SITE_URL`, set in the deploy environment; see *Environment
   variables* above. A production build without it fails rather than shipping a
   placeholder, so this item can no longer be silently skipped.
2. Replace `[REGISTERED ENTITY NAME]` with the exact registered legal entity name (must match Meta submission), and delete the guard exemption in `lib/siteConfig.ts` in the same commit. Blocked on C-1; tracked as F-F003
3. Update `[REGISTERED ADDRESS]` on legal pages
4. Update contact email placeholders (`privacy@`, `legal@`, `abuse@`) with real addresses
5. Update `[CITY]` in Terms governing-law clause
6. Update `[GRIEVANCE OFFICER NAME]` in Privacy Policy

### Legal dates
7. Update `[DATE]` / effective date on all legal pages (fill on launch day)
8. Update `[30]` day deletion timeframe if your actual SLA differs

### Assets
9. Export `design-reference/zyon-og-image.html` to `web/public/og-image.png` (1200x630)
10. Generate `favicon.ico` (32x32) from `favicon.svg`
11. Generate `apple-touch-icon.png` (180x180) — Zyon mark on ink tile — place in `web/public/`

### Placeholders and CTAs
12. ~~Update placeholder social URLs in Footer and `siteConfig.ts`~~ — **done, and
    the item was wrong.** `Footer.tsx` has never contained social links; the only
    render site is the `sameAs` array in `app/layout.tsx`. Socials are now
    `NEXT_PUBLIC_X_URL` / `NEXT_PUBLIC_LINKEDIN_URL`, optional, and omitted from
    the JSON-LD entirely when unset. Set them **only** if the accounts exist
13. Wire "Book a demo" and "Talk to us" CTAs to a real booking URL or contact form
14. Add real nav link hrefs (currently `#` placeholders)
15. Swap "Lakeview Dental" in hero chat + final CTA with a real clinic name once a client is onboarded (or keep as illustrative example)

### Post-launch
16. Submit sitemap to Google Search Console
17. Validate JSON-LD with Google Rich Results Test
18. Get Privacy Policy, Terms, and Acceptable Use reviewed by a lawyer (flagged in the Terms liability clause)
19. Add "Meta Tech Provider" / "Meta Partner" badge to Proof bar ONLY after Tech Provider status is approved
20. Replace "Zyon" placeholder name in footer copyright line with registered entity name once finalized

## Vercel deployment

1. In the Vercel dashboard, set **Root Directory** to `web/`
2. Framework: **Next.js** (auto-detected)
3. Set the environment variables listed under **Environment variables** above.
   `NEXT_PUBLIC_CONTACT_EMAIL` is mandatory; `NEXT_PUBLIC_SITE_URL` may be left
   to Vercel's `VERCEL_PROJECT_PRODUCTION_URL` fallback but is better set
   explicitly. A production build fails if a required value is missing
4. Security headers are configured in `vercel.json` (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy)
5. HTTP-to-HTTPS redirect is handled automatically by Vercel — no config needed
6. The backend deploys independently (Railway) — this Vercel project has no `/api` routes and must not proxy to the backend

## Backend isolation rule

- Never install frontend dependencies at the repo root
- Never modify files outside `web/`
- The backend (`server.js`, `src/`, `package.json` at root) is production code and is deployed separately on Railway
- This marketing site has zero runtime connection to the backend

## Post-launch

- **Google Search Console**: Submit `$NEXT_PUBLIC_SITE_URL/sitemap.xml` and verify ownership
- **Rich Results Test**: Validate the three JSON-LD blocks (Organization, SoftwareApplication, FAQPage) at https://search.google.com/test/rich-results
- **Meta verification**: If Meta requires a verification URL for Tech Provider status, add it to `web/public/` as a static file
