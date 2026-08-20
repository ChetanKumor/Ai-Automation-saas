import type { MetadataRoute } from "next";
import { indexingAllowed, siteConfig } from "@/lib/siteConfig";

/**
 * /robots.txt, in agreement with the X-Robots-Tag header (web/next.config.js)
 * and the meta robots tag (web/app/layout.tsx). All three follow
 * NEXT_PUBLIC_ALLOW_INDEXING; see web/lib/siteConfig.ts.
 *
 * When indexing is off this serves `Disallow: /` and NO sitemap pointer.
 * Advertising a sitemap of routes the headers are hiding is the exact
 * contradiction a crawler resolves in the direction you did not want.
 *
 * Note what Disallow does and does not do: it stops a well-behaved crawler
 * FETCHING the page, which means it also stops it seeing the noindex. The
 * header and the meta tag are what actually remove the page; this line is the
 * outer fence, not the mechanism.
 */
export default function robots(): MetadataRoute.Robots {
  if (!indexingAllowed) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/",
      },
    };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: siteConfig.siteUrl + "/sitemap.xml",
  };
}
