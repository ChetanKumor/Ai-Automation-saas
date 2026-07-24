import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { siteConfig } from "@/lib/siteConfig";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#0B0C0E",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.siteUrl),
  title: {
    default: siteConfig.defaultTitle,
    template: "%s — Prantivo",
  },
  description: siteConfig.defaultDescription,
  openGraph: {
    type: "website",
    siteName: siteConfig.siteName,
    title: siteConfig.defaultTitle,
    description:
      "The AI receptionist for dental clinics — answers enquiries and books appointments on WhatsApp, 24/7, in Telugu, Hindi, and English.",
    url: "/",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Prantivo — the AI receptionist for dental clinics, on WhatsApp",
      },
    ],
    locale: "en_IN",
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.defaultTitle,
    description:
      "The AI receptionist for dental clinics — answers enquiries and books appointments on WhatsApp, 24/7.",
    images: [siteConfig.ogImage],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: "/apple-touch-icon.png",
  },
  robots: {
    index: true,
    follow: true,
  },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: siteConfig.siteName,
  legalName: siteConfig.legalEntityName,
  url: siteConfig.siteUrl,
  logo: siteConfig.siteUrl + "/favicon.svg",
  description:
    "The AI receptionist for dental clinics — it answers enquiries, books appointments, and hands off to staff on WhatsApp, in Telugu, Hindi, and English.",
  sameAs: [siteConfig.socialUrls.twitter, siteConfig.socialUrls.linkedin],
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: siteConfig.contactEmail,
    areaServed: "IN",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(organizationJsonLd).replace(/</g, "\\u003c"),
          }}
        />
        {children}
      </body>
    </html>
  );
}
