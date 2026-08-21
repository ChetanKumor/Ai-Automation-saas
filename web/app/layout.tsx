import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_Telugu } from "next/font/google";
import { indexingAllowed, siteConfig } from "@/lib/siteConfig";
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

// Telugu. A second family, not a subset flag on an existing one: Geist has no
// Telugu coverage at any subset, so `subsets: ["telugu"]` on it would change
// nothing.
//
// Two lines here are load-bearing and both fail silently if wrong:
//
//   subsets: ["telugu"] — next/font fetches only the subsets named. A family
//     that supports Telugu ships none of its glyphs unless the subset is
//     declared, and the page then renders tofu, which reads as a content bug
//     rather than a font-config bug. Verify with the emitted @font-face
//     `unicode-range`: it must cover U+0C00–U+0C7F.
//
//   display: "swap" — never "optional". "optional" drops the face outright on a
//     slow connection, which is exactly the network a Hyderabad prospect browses
//     from; the Telugu would fall back to a family that has no Telugu.
//
// Latin digits inside a Telugu string (times like "5:30") are not in the telugu
// subset and do not need to be — the browser resolves them per glyph down the
// stack in `--font-te`.
const notoSansTelugu = Noto_Sans_Telugu({
  variable: "--font-telugu",
  subsets: ["telugu"],
  display: "swap",
});

// --ground, matching `body` in globals.css. This paints the mobile browser's
// own chrome, so a stale value here is the most visible single miss available
// on the flip: paper page, near-black address bar.
export const viewport: Viewport = {
  themeColor: "#FAF8F5",
};

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.siteUrl),
  title: {
    default: siteConfig.defaultTitle,
    template: `%s — ${siteConfig.siteName}`,
  },
  description: siteConfig.defaultDescription,
  openGraph: {
    type: "website",
    siteName: siteConfig.siteName,
    title: siteConfig.defaultTitle,
    description:
      "Patients message your clinic at 11 PM, during a procedure, on a Sunday. Prantivo answers in seconds — in Telugu, Hindi or English — quotes your prices, and books the appointment.",
    url: "/",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: `${siteConfig.siteName} — books patient appointments on your clinic's own WhatsApp number, in Telugu, Hindi and English`,
      },
    ],
    locale: "en_IN",
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.defaultTitle,
    description:
      "Patients message. Prantivo answers in seconds, quotes your prices and books the appointment — in Telugu, Hindi or English, on your clinic's own WhatsApp number.",
    images: [siteConfig.ogImage],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: "/apple-touch-icon.png",
  },
  // Inherited by every route that does not set its own `robots`, which is
  // all of them except /specimen (permanently noindex — an internal design
  // surface, not a page that becomes public when the flag flips).
  //
  // NEXT_PUBLIC_ALLOW_INDEXING drives this; see web/lib/siteConfig.ts. While
  // the four (legal)/*/page.tsx still carry bracketed placeholders, the
  // correct value of that flag is unset.
  robots: {
    index: indexingAllowed,
    follow: indexingAllowed,
  },
};

// Social accounts may not exist. List only the ones that do — an invented
// profile URL is a false statement about the company, and search engines read
// `sameAs` as a claim of ownership.
const sameAs = [
  siteConfig.socialUrls.twitter,
  siteConfig.socialUrls.linkedin,
].filter((url): url is string => url !== null);

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: siteConfig.siteName,
  // `legalName` is OMITTED while no entity is registered (external clock C-1).
  // It used to emit "[REGISTERED ENTITY NAME]" unconditionally: a bracketed
  // placeholder in the one field of this document a crawler reads as the
  // company's registered name. Structured data is a machine-readable assertion,
  // and there is no reading of that string under which it was true. An absent
  // field says nothing; a bracketed one says something false. Same rule as
  // `sameAs` and `contactPoint` below, applied to the field that most needed it.
  ...(siteConfig.legalEntityName
    ? { legalName: siteConfig.legalEntityName }
    : {}),
  url: siteConfig.siteUrl,
  logo: siteConfig.siteUrl + "/favicon.svg",
  description:
    "An AI receptionist for clinics — it answers patient enquiries, quotes prices, books appointments, and hands off to staff on WhatsApp, in Telugu, Hindi, and English.",
  // Both keys are omitted entirely rather than emitted empty: an empty
  // `sameAs` array or a blank support address is a claim about nothing.
  ...(sameAs.length > 0 ? { sameAs } : {}),
  ...(siteConfig.contactEmail
    ? {
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: siteConfig.contactEmail,
          areaServed: "IN",
        },
      }
    : {}),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansTelugu.variable}`}
    >
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
