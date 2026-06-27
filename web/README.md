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
│   ├── siteConfig.ts           # Central config: URLs, names, social links
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

Key token groups:
- `--ink-*` / `--surface-*` — background scale (near-black)
- `--text-primary` / `--text-secondary` / `--text-tertiary` — text hierarchy
- `--accent` / `--accent-hover` / `--accent-glow` — functional blue (links, focus rings, live dots)
- `--border` / `--border-strong` — hairline separators
- `--wa-*` — WhatsApp-authentic palette (hero chat mockup only)
- `--r-*` — border radii
- `--ease-*` / `--dur-*` — motion

All animations respect `prefers-reduced-motion: reduce` — a global rule in `globals.css` kills all durations, and component-level overrides ensure immediate-show fallbacks.

## Pre-launch checklist

Complete these before going live, in priority order:

### Identity and domain (do first)
1. Replace `siteUrl` in `lib/siteConfig.ts` with the real production domain
2. Replace `[REGISTERED ENTITY NAME]` with the exact registered legal entity name (must match Meta submission)
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
12. Update placeholder social URLs in Footer and `siteConfig.ts`
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
3. No environment variables required for the marketing site itself
4. Security headers are configured in `vercel.json` (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy)
5. HTTP-to-HTTPS redirect is handled automatically by Vercel — no config needed
6. The backend deploys independently (Railway) — this Vercel project has no `/api` routes and must not proxy to the backend

## Backend isolation rule

- Never install frontend dependencies at the repo root
- Never modify files outside `web/`
- The backend (`server.js`, `src/`, `package.json` at root) is production code and is deployed separately on Railway
- This marketing site has zero runtime connection to the backend

## Post-launch

- **Google Search Console**: Submit `https://yourdomain.com/sitemap.xml` and verify ownership
- **Rich Results Test**: Validate the three JSON-LD blocks (Organization, SoftwareApplication, FAQPage) at https://search.google.com/test/rich-results
- **Meta verification**: If Meta requires a verification URL for Tech Provider status, add it to `web/public/` as a static file
