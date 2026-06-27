import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/lib/siteConfig";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description:
    "The rules for using Zyon responsibly and in line with WhatsApp's policies.",
  alternates: {
    canonical: "/acceptable-use",
  },
  openGraph: {
    title: "Acceptable Use Policy — Zyon",
    description:
      "The rules for using Zyon responsibly and in line with WhatsApp's policies.",
    url: "/acceptable-use",
    siteName: siteConfig.siteName,
    type: "website",
    locale: "en_IN",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Zyon — AI infrastructure for businesses that run on WhatsApp",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Acceptable Use Policy — Zyon",
    description:
      "The rules for using Zyon responsibly and in line with WhatsApp's policies.",
    images: [siteConfig.ogImage],
  },
};

export default function AcceptableUsePage() {
  return (
    <>
      <div className={styles.container}>
        <header className={styles.docHead}>
          <span className={styles.eyebrow}>Legal</span>
          <h1>Acceptable Use Policy</h1>
          <div className={styles.metaLine}>
            Last updated: <span className={styles.ph}>[DATE]</span>
          </div>
          <p className={styles.docIntro}>
            This Acceptable Use Policy sets out what is and isn&rsquo;t allowed
            when using Zyon. It applies to every Zyon customer and forms part of
            our Terms of Service. Its purpose is to keep the platform safe,
            lawful, and in good standing with WhatsApp.
          </p>
        </header>
      </div>

      <div className={styles.container}>
        <main className={styles.contentSingle}>
          <h2>Follow WhatsApp&rsquo;s rules</h2>
          <p>
            Because Zyon runs on Meta&rsquo;s WhatsApp Business Platform, you
            must comply with Meta&rsquo;s and WhatsApp&rsquo;s policies,
            including the WhatsApp Business Messaging Policy and the WhatsApp
            Commerce Policy, as updated from time to time. If anything in this
            policy conflicts with WhatsApp&rsquo;s policies, the stricter rule
            applies.
          </p>

          <h2>Consent and messaging</h2>
          <p>
            You must have a valid reason and the necessary opt-in to message a
            person on WhatsApp. You may not:
          </p>
          <ul>
            <li>
              Send spam, bulk unsolicited messages, or message people who have
              not opted in.
            </li>
            <li>
              Continue messaging someone who has asked you to stop or opted out.
            </li>
            <li>
              Use purchased, scraped, or otherwise improperly obtained contact
              lists.
            </li>
          </ul>

          <h2>Prohibited content and conduct</h2>
          <p>You may not use Zyon to create, send, or facilitate:</p>
          <ul>
            <li>Anything illegal, or that promotes illegal activity.</li>
            <li>
              Sale or promotion of goods or services prohibited or restricted by
              the WhatsApp Commerce Policy or applicable law.
            </li>
            <li>
              Fraud, scams, phishing, deceptive, or misleading messages.
            </li>
            <li>
              Harassing, threatening, hateful, defamatory, or abusive content.
            </li>
            <li>
              Sexually explicit content, or content that exploits or endangers
              minors.
            </li>
            <li>
              Impersonation of any person or organisation, or false claims about
              who you are.
            </li>
            <li>
              Malware, links to malicious sites, or attempts to compromise
              security.
            </li>
            <li>
              Unauthorised collection or misuse of any person&rsquo;s personal
              data.
            </li>
          </ul>

          <h2>Protecting the platform</h2>
          <p>
            You may not attempt to disrupt, overload, reverse-engineer, or gain
            unauthorised access to the platform or its infrastructure, or to
            other customers&rsquo; data. You may not resell or provide access to
            Zyon to third parties except as expressly permitted.
          </p>

          <h2>Responsible AI use</h2>
          <p>
            You are responsible for how your AI is configured and for the
            messages your customers receive. Do not configure the AI to deceive
            people about material facts, to provide regulated professional advice
            it is not qualified to give, or to behave in ways that breach this
            policy. Where your customers may reasonably need to know they are
            speaking with an automated assistant, be transparent with them.
          </p>

          <h2>Enforcement</h2>
          <p>
            If we believe you have breached this policy, we may take action to
            protect the platform, other customers, and our relationship with
            Meta. Depending on the severity, this may include warning you,
            restricting features, suspending your account, or terminating your
            access. Where the law or an urgent risk requires it, we may act
            without prior notice.
          </p>
          <div className={styles.callout}>
            <p>
              A single bad actor can put every customer&rsquo;s WhatsApp access
              at risk. We enforce this policy to protect the whole platform — and
              you.
            </p>
          </div>

          <h2>Reporting abuse</h2>
          <p>
            If you believe someone is misusing Zyon, or you have received a
            message that breaches this policy, tell us at{" "}
            <span className={styles.ph}>[abuse@yourdomain.com]</span>.
          </p>

          <h2>Related policies</h2>
          <p>
            This policy works alongside our{" "}
            <Link href="/terms">Terms of Service</Link> and{" "}
            <Link href="/privacy">Privacy Policy</Link>.
          </p>
        </main>
      </div>
    </>
  );
}
