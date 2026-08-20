const path = require("path");

// Whether this deploy may be indexed. MUST match `indexingAllowed` in
// web/lib/siteConfig.ts — that file carries the reasoning; this is the same
// one-line rule restated because next.config.js is CommonJS, loaded by the
// Next CLI before any TypeScript is compiled, and so cannot import it.
//
// If you change the rule, change it in BOTH places. The header and the meta
// tag disagreeing is the specific failure this duplication can cause, and
// `docs/deploy/marketing-site.md` tells the operator to check both.
const indexingAllowed =
  (process.env.NEXT_PUBLIC_ALLOW_INDEXING ?? "").trim() === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),

  // X-Robots-Tag on every response, including the 404 and the static assets.
  //
  // Belt and braces with the `<meta name="robots">` tag in app/layout.tsx, and
  // neither is redundant: the meta tag is the only one that survives a host
  // that ignores next.config.js headers (a pure static export behind a CDN),
  // and the header is the only one that covers /robots.txt, /sitemap.xml,
  // og-image.png and the JS chunks, which have no <head> to put a tag in.
  //
  // When indexing IS allowed this returns no headers at all rather than
  // `index, follow` — the absence of a directive already means "index", and
  // asserting it adds a byte to every response to say nothing.
  async headers() {
    if (indexingAllowed) return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
