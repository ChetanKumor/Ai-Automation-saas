import type { MetadataRoute } from "next";
import { indexingAllowed, siteConfig } from "@/lib/siteConfig";

/**
 * /sitemap.xml, in agreement with /robots.txt, the X-Robots-Tag header and
 * the meta robots tag. All four follow NEXT_PUBLIC_ALLOW_INDEXING.
 *
 * A noindexed deploy serves an EMPTY but well-formed <urlset/>, not a 404:
 * listing a URL here is a request to crawl it, and it is the one file whose
 * whole purpose is to contradict a noindex. Empty says "nothing to fetch"
 * without also breaking the route for whoever asks.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!indexingAllowed) return [];

  return [
    {
      url: siteConfig.siteUrl + "/",
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: siteConfig.siteUrl + "/privacy",
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: siteConfig.siteUrl + "/terms",
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: siteConfig.siteUrl + "/data-deletion",
      changeFrequency: "yearly",
      priority: 0.4,
    },
    {
      url: siteConfig.siteUrl + "/acceptable-use",
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];
}
