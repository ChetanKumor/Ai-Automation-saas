export const siteConfig = {
  siteUrl: "https://yourdomain.com",
  siteName: "Prantivo",
  legalEntityName: "[REGISTERED ENTITY NAME]",
  defaultTitle: "Prantivo — AI Receptionist for Dental Clinics",
  defaultDescription:
    "Prantivo is the AI receptionist for dental clinics — it answers enquiries and books appointments on WhatsApp, 24/7, in Telugu, Hindi, and English.",
  ogImage: "/og-image.png",
  // Founder's WhatsApp number in E.164 without the leading '+', used for the demo CTAs.
  demoWhatsApp: "918309177158",
  socialUrls: {
    twitter: "https://x.com/yourhandle",
    linkedin: "https://www.linkedin.com/company/yourcompany",
  },
  contactEmail: "support@yourdomain.com",
} as const;

// Prefilled one-tap messages for the WhatsApp click-to-chat CTAs.
export const waMessages = {
  demo: "Hi, I'd like to book a demo of the Prantivo AI receptionist for my clinic.",
  talk: "Hi, I have a question about the Prantivo AI receptionist.",
} as const;

// Build a wa.me click-to-chat link with a prefilled message.
export function waLink(text: string): string {
  return `https://wa.me/${siteConfig.demoWhatsApp}?text=${encodeURIComponent(text)}`;
}
