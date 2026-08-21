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

/**
 * The REGISTERED legal entity name — not the trading name, which is `BRAND`.
 *
 * `null` because the entity does not exist yet: external clock C-1, business
 * entity registration, `docs/os/clocks.md`. Not environment-varying and so not
 * an env var — there is one registered name, in every environment, and it is
 * simply unknown.
 *
 * NULL RATHER THAN "[REGISTERED ENTITY NAME]", and that difference is the whole
 * point of this constant existing. The bracketed string shipped as `legalName`
 * in the Organization JSON-LD on every route — machine-readable structured
 * data, the field a crawler reads as the company's registered name — while the
 * build reported success, because it was the one field the guard below did not
 * check. An absent field is honest; a bracketed one is a claim.
 *
 * Every render site guards on null and omits the field entirely, exactly as the
 * social URLs above do. When C-1 clears, this becomes the real name and the
 * guard below content-checks it like everything else — no exemption to remove,
 * because there is no longer one.
 */
const legalEntityName: string | null = null;

export const siteConfig = {
  siteUrl: resolveSiteUrl(),
  siteName: BRAND,
  // `null` until C-1 clears; every render site omits the field. See above.
  legalEntityName,
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
//
// EXHAUSTIVE BY CONSTRUCTION, AND THAT IS THE POINT.
//
// The field list is DERIVED by walking `siteConfig` and `waMessages`, not typed
// out beside them. The previous version was a hand-written array, and it had a
// hole in exactly the field that mattered: `legalEntityName` was left out of it
// deliberately, with a comment explaining why, and so "[REGISTERED ENTITY NAME]"
// shipped as `legalName` in the Organization JSON-LD of every route — the
// machine-readable field a crawler reads as the company's registered name —
// while `next build` reported success. A guard with a carve-out for the one
// field nobody looks at by eye is worse than no guard: it manufactures
// confidence. There is no carve-out now, and no way to add a field to either
// object without it being checked.
//
// `waMessages` is swept too. Its strings are not decoration — they are inlined
// into the `wa.me?text=` href of every CTA on the site, so a placeholder there
// reaches the browser exactly as one in `siteConfig` does.
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /yourdomain\.com/i,
  /yourhandle/i,
  /yourcompany/i,
  /\[[^\]]+\]/,
];

/**
 * Fields that must be NON-EMPTY in a production build. Anything not named here
 * may legitimately be absent — a social account nobody owns, a legal entity
 * that is not registered yet — and is still content-checked when present, so a
 * plausible-looking invented value fails exactly as an unset required one does.
 *
 * Absence from this list is a statement that the field is OPTIONAL, never that
 * it is unchecked. Nothing is unchecked.
 */
const REQUIRED_IN_PRODUCTION: readonly string[] = [
  "siteUrl",
  "contactEmail",
  "siteName",
  "defaultTitle",
  "defaultDescription",
];

/** What to DO about each field, quoted back in the failure message. An operator
 *  reading a failed deploy log needs the remedy, not a restatement of the fault.
 *  A field not listed here is authored in this file and is told so — which is
 *  every field the walk finds and nobody thought to name, and is therefore the
 *  branch that must still produce a sentence someone can act on. */
const BRAND_CONSTANT = "Fix the BRAND constant in web/lib/siteConfig.ts";
const FIELD_REMEDY: Readonly<Record<string, string>> = {
  siteUrl: "Set NEXT_PUBLIC_SITE_URL in the deploy environment — see web/.env.example",
  contactEmail:
    "Set NEXT_PUBLIC_CONTACT_EMAIL in the deploy environment — see web/.env.example",
  "socialUrls.twitter":
    "Set NEXT_PUBLIC_X_URL to a real profile, or leave it unset — see web/.env.example",
  "socialUrls.linkedin":
    "Set NEXT_PUBLIC_LINKEDIN_URL to a real profile, or leave it unset — see web/.env.example",
  siteName: BRAND_CONSTANT,
  defaultTitle: BRAND_CONSTANT,
  defaultDescription: BRAND_CONSTANT,
};
const AUTHORED_HERE = "This value is authored in web/lib/siteConfig.ts";

/**
 * Every string-or-null leaf of an object, as dotted paths. Nested objects are
 * walked (`socialUrls.twitter`); anything neither string, null nor object — a
 * number, a function — carries no prose and is skipped rather than coerced into
 * a string the patterns would then match by accident.
 */
function stringLeaves(
  obj: Record<string, unknown>,
  prefix = ""
): [string, string | null][] {
  const out: [string, string | null][] = [];
  for (const [key, value] of Object.entries(obj)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (value === null || typeof value === "string") out.push([field, value]);
    else if (typeof value === "object") {
      out.push(...stringLeaves(value as Record<string, unknown>, field));
    }
  }
  return out;
}

if (isProduction && typeof window === "undefined") {
  const guarded: [string, string | null][] = [
    ...stringLeaves(siteConfig),
    ...stringLeaves(waMessages, "waMessages"),
  ];

  for (const [field, value] of guarded) {
    const remedy = FIELD_REMEDY[field] ?? AUTHORED_HERE;
    const reject = (why: string): never => {
      throw new Error(
        `siteConfig: ${field} ${why}. ${remedy}. ` +
          `Production builds refuse to ship placeholders.`
      );
    };

    if (value === null || value === "") {
      if (REQUIRED_IN_PRODUCTION.includes(field)) reject("is empty");
      continue;
    }

    const matched = PLACEHOLDER_PATTERNS.find((pattern) => pattern.test(value));
    if (matched) reject(`still holds a placeholder (matched ${matched})`);
  }
}
