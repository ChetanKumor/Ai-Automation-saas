import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/siteConfig";

export default function sitemap(): MetadataRoute.Sitemap {
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
