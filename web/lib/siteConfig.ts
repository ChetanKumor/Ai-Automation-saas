// Site configuration, split by what actually varies.
//
// The brand name is a plain constant: it is the same string in every
// environment, so routing it through an environment variable would only add a
// way to get it wrong. Everything that genuinely differs per deploy is read
// from the environment at build time, with **no production fallback baked into
// this repository** — a production build missing a value fails loudly via the
// guard at the bottom of this file rather than shipping a placeholder.
//
// Next.js inlines `process.env.NEXT_PUBLIC_*` textually at build time, so every
// variable must be referenced by its full literal name. Dynamic lookup
// (`process.env[name]`) silently yields undefined in the client bundle.
//
// Set these in the deploy environment — see `web/.env.example`.

const isProduction = process.env.NODE_ENV === "production";

/**
 * Trading name. A rename is a change to this line plus display copy — never a
 * code change. This is NOT the registered legal entity; see `legalEntityName`.
 */
const BRAND = "Prantivo";

/** Treat an unset, empty, or whitespace-only variable as absent. */
function envOrNull(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

const stripTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

/**
 * Whether this deploy may be indexed by search engines.
 *
 * OFF unless `NEXT_PUBLIC_ALLOW_INDEXING` is exactly the string "true". Unset,
 * empty, "false", "1", "yes" and a typo all mean NOT indexable — the safe
 * direction is the default, because the failure mode of the other default is a
 * private preview appearing in Google and staying there after it is taken down.
 *
 * This is a property of the repository, not of a host. Vercel's own
 * "Deployment Protection" and preview-URL noindex behaviour do the same job on
 * Vercel and nowhere else; moving this site to Netlify, Cloudflare Pages or a
 * plain box would silently drop it. The flag drives four things that must all
 * agree, and each is checked by G4/G6 of the deploy-prep session:
 *
 *   1. the `X-Robots-Tag` response header  (web/next.config.js)
 *   2. the `<meta name="robots">` tag      (web/app/layout.tsx)
 *   3. /robots.txt                         (web/app/robots.ts)
 *   4. /sitemap.xml                        (web/app/sitemap.ts)
 *
 * It is `NEXT_PUBLIC_` prefixed deliberately: `next.config.js` reads it on the
 * server and the metadata is inlined at build time, so a non-public name would
 * work today, but the prefix keeps one name for one concept and survives the
 * value being needed in a client component later.
 *
 * NOTE the build-time nature. Next inlines this at `next build`. Changing the
 * variable on a running host does nothing until the site is rebuilt.
 */
export const indexingAllowed: boolean =
  envOrNull(process.env.NEXT_PUBLIC_ALLOW_INDEXING) === "true";

/**
 * Canonical origin, in resolution order:
 *   1. NEXT_PUBLIC_SITE_URL          — explicit; correct on any host.
 *   2. VERCEL_PROJECT_PRODUCTION_URL — host-supplied by Vercel, no scheme.
 *   3. http://localhost:3100         — DEVELOPMENT ONLY.
 *
 * Step 3 deliberately does not apply in production: returning "" there hands
 * the failure to the guard, which names the field. The dev port matches
 * `package.json` ("next dev --port 3100") — 3000 is the backend, not this app.
 */
function resolveSiteUrl(): string {
  const explicit = envOrNull(process.env.NEXT_PUBLIC_SITE_URL);
  if (explicit) return stripTrailingSlashes(explicit);

  const vercelHost = envOrNull(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (vercelHost) return `https://${stripTrailingSlashes(vercelHost)}`;

  return isProduction ? "" : "http://localhost:3100";
}

/**
 * Social accounts are `string | null` because they may not exist. An absent
 * account renders no link at all — substituting a plausible-looking handle for
 * an account nobody owns is the same false statement in better clothing, and a
 * link to a 404 is still a link to a 404. Every render site guards on null.
 */
const twitterUrl = envOrNull(process.env.NEXT_PUBLIC_X_URL);
const linkedinUrl = envOrNull(process.env.NEXT_PUBLIC_LINKEDIN_URL);

export const siteConfig = {
  siteUrl: resolveSiteUrl(),
  siteName: BRAND,
  // Unknown, pending C-1 (business entity registration, docs/os/clocks.md).
  // Not environment-varying: there is one registered entity name, it simply
  // does not exist yet. Exempted from the guard below — see the note there.
  legalEntityName: "[REGISTERED ENTITY NAME]",
  defaultTitle: `${BRAND} — the AI receptionist for clinics, on WhatsApp`,
  defaultDescription: `${BRAND} is the AI receptionist for clinics — it answers patients in Telugu, Hindi or English, quotes your prices, and books the appointment on your clinic's own WhatsApp number.`,
  ogImage: "/og-image.png",
  // Founder's WhatsApp number in E.164 without the leading '+', used for the demo CTAs.
  demoWhatsApp: "918309177158",
  socialUrls: {
    twitter: twitterUrl,
    linkedin: linkedinUrl,
  },
  contactEmail: envOrNull(process.env.NEXT_PUBLIC_CONTACT_EMAIL) ?? "",
} as const;

// Prefilled one-tap messages for the WhatsApp click-to-chat CTAs.
export const waMessages = {
  demo: `Hi, I'd like to see ${BRAND} book an appointment in Telugu for my clinic.`,
  talk: `Hi, I have a question about ${BRAND} for my clinic.`,
} as const;

// Build a wa.me click-to-chat link with a prefilled message.
export function waLink(text: string): string {
  return `https://wa.me/${siteConfig.demoWhatsApp}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------
// Build-time placeholder guard
//
// Module scope, so `layout.tsx`'s import executes it during `next build`. A
// production build cannot complete while a required field is empty or any
// field still carries a placeholder. It never throws in development — local
// work must not require the full set.
//
// Server/build only. This module reaches the client bundle through `Nav.tsx`
// and `Faq.tsx` (both "use client"), and a guard has no business running in a
// visitor's browser: `VERCEL_PROJECT_PRODUCTION_URL` is not `NEXT_PUBLIC_`-
// prefixed and so is absent there, which would throw on a perfectly good build.
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /yourdomain\.com/i,
  /yourhandle/i,
  /yourcompany/i,
  /\[[^\]]+\]/,
];

type GuardedField = {
  field: string;
  value: string | null;
  /** false = may legitimately be absent; still content-checked when present. */
  requiredInProduction: boolean;
  /** Where the value comes from, quoted back in the failure message. */
  source: string;
};

const GUARDED: readonly GuardedField[] = [
  {
    field: "siteUrl",
    value: siteConfig.siteUrl,
    requiredInProduction: true,
    source: "NEXT_PUBLIC_SITE_URL",
  },
  {
    field: "contactEmail",
    value: siteConfig.contactEmail,
    requiredInProduction: true,
    source: "NEXT_PUBLIC_CONTACT_EMAIL",
  },
  {
    field: "siteName",
    value: siteConfig.siteName,
    requiredInProduction: true,
    source: "the BRAND constant in web/lib/siteConfig.ts",
  },
  {
    field: "defaultTitle",
    value: siteConfig.defaultTitle,
    requiredInProduction: true,
    source: "the BRAND constant in web/lib/siteConfig.ts",
  },
  {
    field: "defaultDescription",
    value: siteConfig.defaultDescription,
    requiredInProduction: true,
    source: "the BRAND constant in web/lib/siteConfig.ts",
  },
  // Socials are not required — an account that does not exist renders no link.
  // They are still content-checked, so a plausible-looking invented handle
  // fails the build exactly as an unset-but-required field would.
  {
    field: "socialUrls.twitter",
    value: siteConfig.socialUrls.twitter,
    requiredInProduction: false,
    source: "NEXT_PUBLIC_X_URL",
  },
  {
    field: "socialUrls.linkedin",
    value: siteConfig.socialUrls.linkedin,
    requiredInProduction: false,
    source: "NEXT_PUBLIC_LINKEDIN_URL",
  },

  // EXEMPT — legalEntityName is blocked on C-1 (business entity registration,
  // docs/os/clocks.md). Tracked as F-F003 in docs/audit/2026-07-frontend.md.
  // Remove this exemption in the same commit that fills the legal pages.
  // While this line exists, an unfiled external clock is holding a production
  // build open on a knowingly false statement.
];

if (isProduction && typeof window === "undefined") {
  for (const { field, value, requiredInProduction, source } of GUARDED) {
    const reject = (why: string): never => {
      throw new Error(
        `siteConfig: ${field} ${why}. Set ${source} in the deploy environment — ` +
          `see web/.env.example. Production builds refuse to ship placeholders.`
      );
    };

    if (value === null || value === "") {
      if (requiredInProduction) reject("is empty");
      continue;
    }

    const matched = PLACEHOLDER_PATTERNS.find((pattern) => pattern.test(value));
    if (matched) reject(`still holds a placeholder (matched ${matched})`);
  }
}
