import type { Metadata } from "next";
import { siteConfig } from "@/lib/siteConfig";
import { FAQ_ITEMS } from "@/components/sections/faqData";
import { Hero } from "@/components/sections/Hero";
import { Proof } from "@/components/sections/Proof";
import { Problem } from "@/components/sections/Problem";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Platform } from "@/components/sections/Platform";
import { Why } from "@/components/sections/Why";
import { Trust } from "@/components/sections/Trust";
import { Pricing } from "@/components/sections/Pricing";
import { Faq } from "@/components/sections/Faq";
import { FinalCta } from "@/components/sections/FinalCta";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
};

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: siteConfig.siteName,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description:
    "An AI receptionist for dental clinics. It answers enquiries, books appointments, and hands off to staff on WhatsApp — in Telugu, Hindi, and English — on the official WhatsApp Business Platform.",
  offers: {
    "@type": "Offer",
    priceCurrency: "INR",
    description:
      "One-time setup fee plus a monthly subscription. Book a demo for a tailored quote.",
  },
  publisher: { "@type": "Organization", name: siteConfig.siteName },
};

const faqPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer,
    },
  })),
};

function SafeJsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

export default function HomePage() {
  return (
    <main>
      <SafeJsonLd data={softwareApplicationJsonLd} />
      <SafeJsonLd data={faqPageJsonLd} />
      <Hero />
      <Proof />
      <Problem />
      <HowItWorks />
      <Platform />
      <Why />
      <Trust />
      <Pricing />
      <Faq />
      <FinalCta />
    </main>
  );
}
