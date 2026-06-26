# Zyon — SEO Layer Reference

Everything the build needs to make the site search- and share-ready. Values are copy-paste ready; the Claude Code step wires them into Next.js (`metadata` exports, route handlers, `/public` assets).

Replace these placeholders everywhere before launch:
- `https://yourdomain.com` → your real domain
- `[REGISTERED ENTITY NAME]` → your registered legal business name
- Social URLs and contact emails

---

## 1. Per-page metadata

| Route | `<title>` | `<meta name="description">` |
|---|---|---|
| `/` | `Zyon — AI WhatsApp Receptionist & Automation for Business` | `Zyon answers enquiries, qualifies leads, and books appointments on WhatsApp, 24/7 — on your own number, via the official WhatsApp Business Platform. Book a demo.` |
| `/privacy` | `Privacy Policy — Zyon` | `How Zyon collects, uses, stores, and protects personal data across its WhatsApp automation platform.` |
| `/terms` | `Terms of Service — Zyon` | `The terms governing use of the Zyon WhatsApp automation platform.` |
| `/data-deletion` | `Data Deletion — Zyon` | `How to request deletion of your data from Zyon, for businesses and end-customers.` |
| `/acceptable-use` | `Acceptable Use Policy — Zyon` | `The rules for using Zyon responsibly and in line with WhatsApp's policies.` |

Keep titles ≤ 60 characters and descriptions ≤ 160 where possible. Each page has exactly one `<h1>` (already true in the built sections).

---

## 2. Shared `<head>` tags

Set per-page `og:title`, `og:description`, `og:url` from the table above. The rest are site-wide defaults.

```html
<!-- Canonical (per page) -->
<link rel="canonical" href="https://yourdomain.com/" />

<!-- Open Graph -->
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Zyon" />
<meta property="og:title" content="Zyon — AI WhatsApp Receptionist & Automation for Business" />
<meta property="og:description" content="Answers enquiries, qualifies leads, and books appointments on WhatsApp, 24/7 — on your own number." />
<meta property="og:url" content="https://yourdomain.com/" />
<meta property="og:image" content="https://yourdomain.com/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Zyon — AI infrastructure for businesses that run on WhatsApp" />
<meta property="og:locale" content="en_IN" />

<!-- Twitter / X -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Zyon — AI WhatsApp Receptionist & Automation for Business" />
<meta name="twitter:description" content="Answers enquiries, qualifies leads, and books appointments on WhatsApp, 24/7." />
<meta name="twitter:image" content="https://yourdomain.com/og-image.png" />

<!-- Theme + icons -->
<meta name="theme-color" content="#0B0C0E" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico" sizes="32x32" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />

<!-- Robots (indexable pages) -->
<meta name="robots" content="index, follow" />
```

> `<html lang="en">` is set. The viewport tag and font preconnects are already in the built files.

---

## 3. Structured data (JSON-LD)

Search engines read these. Place each in a `<script type="application/ld+json">`.

### 3a. Organization — site-wide (in the root layout)

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Zyon",
  "legalName": "[REGISTERED ENTITY NAME]",
  "url": "https://yourdomain.com",
  "logo": "https://yourdomain.com/favicon.svg",
  "description": "AI infrastructure for businesses that run on WhatsApp — an AI receptionist, workflow automation, AI agents, a CRM, and appointment management.",
  "sameAs": [
    "https://x.com/yourhandle",
    "https://www.linkedin.com/company/yourcompany"
  ],
  "contactPoint": {
    "@type": "ContactPoint",
    "contactType": "customer support",
    "email": "support@yourdomain.com",
    "areaServed": "IN"
  }
}
```

### 3b. SoftwareApplication — on the homepage

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Zyon",
  "applicationCategory": "BusinessApplication",
  "operatingSystem": "Web",
  "description": "An AI WhatsApp receptionist, workflow automation, AI agents, CRM, and appointment management on the official WhatsApp Business Platform. Built for clinics, real estate, finance, and any business that books appointments or fields enquiries.",
  "offers": {
    "@type": "Offer",
    "priceCurrency": "INR",
    "description": "One-time setup fee plus a monthly subscription. Book a demo for a tailored quote."
  },
  "publisher": { "@type": "Organization", "name": "Zyon" }
}
```
> No fixed `price` — matches the strategy of quoting in the demo. Schema allows an `Offer` with a description and no price.

### 3c. FAQPage — on the homepage (powers FAQ rich results)

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "Does Zyon use my own WhatsApp number?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. Zyon connects to your existing WhatsApp Business number through the official WhatsApp Business Platform. Your customers see the same number they already message." } },
    { "@type": "Question", "name": "What happens when the AI isn't sure?", "acceptedAnswer": { "@type": "Answer", "text": "It hands the conversation to your team instead of guessing. You can also take over any chat manually, and hand it back when you're done." } },
    { "@type": "Question", "name": "Can my staff and the AI both reply?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. The AI and your team share one inbox. When a person takes over, the AI stays silent until the chat is returned to it." } },
    { "@type": "Question", "name": "Who can see my conversations and customer data?", "acceptedAnswer": { "@type": "Answer", "text": "Only you. Each business is fully isolated on the platform. We don't sell your data, and you can export or delete it on request." } },
    { "@type": "Question", "name": "Which languages does it handle?", "acceptedAnswer": { "@type": "Answer", "text": "It replies in clear, natural language and handles the everyday English-and-local-language mix common in customer chats." } },
    { "@type": "Question", "name": "Is this allowed by WhatsApp?", "acceptedAnswer": { "@type": "Answer", "text": "Yes. Zyon is built on Meta's official WhatsApp Business Platform and follows WhatsApp's messaging rules. It does not use unofficial automation that can get a number banned." } },
    { "@type": "Question", "name": "What about AI Voice Calling?", "acceptedAnswer": { "@type": "Answer", "text": "AI Voice Calling is coming soon. The five products above are available today." } }
  ]
}
```

---

## 4. `sitemap.xml`

In Next.js, generate via `app/sitemap.ts`; the output should be:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://yourdomain.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://yourdomain.com/privacy</loc><changefreq>yearly</changefreq><priority>0.4</priority></url>
  <url><loc>https://yourdomain.com/terms</loc><changefreq>yearly</changefreq><priority>0.4</priority></url>
  <url><loc>https://yourdomain.com/data-deletion</loc><changefreq>yearly</changefreq><priority>0.4</priority></url>
  <url><loc>https://yourdomain.com/acceptable-use</loc><changefreq>yearly</changefreq><priority>0.4</priority></url>
</urlset>
```

## 5. `robots.txt`

In Next.js, generate via `app/robots.ts`; the output should be:

```
User-agent: *
Allow: /

Sitemap: https://yourdomain.com/sitemap.xml
```

---

## 6. Assets to produce in `/public`

| File | Size | Source |
|---|---|---|
| `og-image.png` | 1200×630 | Export the `zyon-og-image.html` frame |
| `favicon.svg` | vector | Provided (`favicon.svg`) |
| `favicon.ico` | 32×32 | Convert from `favicon.svg` |
| `apple-touch-icon.png` | 180×180 | Render the mark on the ink tile |

---

## 7. Technical SEO checklist

- **One `<h1>` per page** — done in every section.
- **Real heading hierarchy** (h1 → h2 → h3), not styled divs — done.
- **Crawlable text** — all key copy is live text, never baked into images or canvas — done.
- **`alt` / `aria-label` on visuals** — the chat mockups use `aria-label`; add real `alt` to any photographic images later.
- **Canonical URL** on every page (no duplicate-content splits).
- **`lang="en"`** on `<html>` — done.
- **Mobile-first / responsive** — done across all sections.
- **Fast LCP** — no hero video or heavy 3D; fonts preconnected; keep images optimized (use `next/image`).
- **HTTPS + non-www→www (or reverse) redirect** — set one canonical host at the domain/Vercel level.
- **Submit `sitemap.xml`** in Google Search Console after launch.
- **Validate** the structured data with Google's Rich Results Test before/after deploy.
