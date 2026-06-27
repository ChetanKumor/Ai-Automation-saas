import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/lib/siteConfig";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms governing use of the Zyon WhatsApp automation platform.",
  alternates: {
    canonical: "/terms",
  },
  openGraph: {
    title: "Terms of Service — Zyon",
    description:
      "The terms governing use of the Zyon WhatsApp automation platform.",
    url: "/terms",
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
    title: "Terms of Service — Zyon",
    description:
      "The terms governing use of the Zyon WhatsApp automation platform.",
    images: [siteConfig.ogImage],
  },
};

export default function TermsPage() {
  return (
    <>
      <div className={styles.container}>
        <header className={styles.docHead}>
          <span className={styles.eyebrow}>Legal</span>
          <h1>Terms of Service</h1>
          <div className={styles.metaLine}>
            Last updated: <span className={styles.ph}>[DATE]</span> &middot;
            Effective: <span className={styles.ph}>[DATE]</span>
          </div>
          <p className={styles.docIntro}>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your access to
            and use of the Zyon platform. By creating an account or using Zyon,
            you agree to these Terms. If you are using Zyon on behalf of a
            business, you confirm you have authority to bind that business.
          </p>
        </header>
      </div>

      <div className={styles.container}>
        <div className={styles.docGrid}>
          <nav className={styles.toc} aria-label="Table of contents">
            <div className={styles.tocTitle}>On this page</div>
            <a href="#agreement">1. Agreement</a>
            <a href="#service">2. The service</a>
            <a href="#accounts">3. Accounts</a>
            <a href="#responsibilities">4. Your responsibilities</a>
            <a href="#fees">5. Fees &amp; payment</a>
            <a href="#thirdparty">6. Third-party services</a>
            <a href="#ip">7. Intellectual property</a>
            <a href="#yourdata">8. Your data</a>
            <a href="#ai">9. AI output</a>
            <a href="#availability">10. Availability</a>
            <a href="#liability">11. Liability</a>
            <a href="#indemnity">12. Indemnification</a>
            <a href="#termination">13. Termination</a>
            <a href="#changes">14. Changes</a>
            <a href="#law">15. Governing law</a>
            <a href="#contact">16. Contact</a>
          </nav>

          <main className={styles.content}>
            <h2 id="agreement">1. Agreement</h2>
            <p>
              These Terms form a binding agreement between you (&ldquo;you&rdquo;,
              &ldquo;Customer&rdquo;) and{" "}
              <span className={styles.ph}>[REGISTERED ENTITY NAME]</span>{" "}
              (&ldquo;Zyon&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). They
              apply together with our{" "}
              <Link href="/privacy">Privacy Policy</Link> and{" "}
              <Link href="/acceptable-use">Acceptable Use Policy</Link>, which
              are incorporated by reference.
            </p>

            <h2 id="service">2. The service</h2>
            <p>
              Zyon provides a software platform that connects to your WhatsApp
              Business number through Meta&rsquo;s WhatsApp Business Platform to
              provide an AI receptionist, workflow automation, AI agents, a CRM,
              and appointment management, along with related features we may add
              or change over time. AI Voice Calling is described as &ldquo;coming
              soon&rdquo; and is not part of the service until we make it
              generally available.
            </p>

            <h2 id="accounts">3. Accounts</h2>
            <p>
              You must provide accurate information when setting up your account
              and keep it up to date. You are responsible for activity that occurs
              under your account and for keeping your credentials secure. Zyon is
              intended for businesses, not for personal or consumer use.
            </p>

            <h2 id="responsibilities">4. Your responsibilities</h2>
            <p>
              You are responsible for how you use Zyon and the messages sent from
              your number. In particular, you agree that:
            </p>
            <ul>
              <li>
                You will comply with our{" "}
                <Link href="/acceptable-use">Acceptable Use Policy</Link>, the
                WhatsApp Business Messaging Policy, the WhatsApp Commerce Policy,
                and all applicable laws.
              </li>
              <li>
                You have obtained any consents required to message your customers
                on WhatsApp and to process their data through Zyon.
              </li>
              <li>
                You are responsible for the content of your prompts,
                configuration, and the messages your customers receive.
              </li>
              <li>
                You will not use Zyon to send spam or unsolicited messages, or
                for any unlawful, harmful, or deceptive purpose.
              </li>
            </ul>
            <div className={styles.callout}>
              <p>
                Misuse of WhatsApp can result in your number, and potentially the
                wider platform, being restricted or banned by Meta. Following
                these responsibilities protects you and every other business on
                Zyon.
              </p>
            </div>

            <h2 id="fees">5. Fees &amp; payment</h2>
            <p>
              Zyon is charged as a one-time setup fee plus a recurring
              subscription, as agreed with you. WhatsApp messaging charges are
              set and billed by Meta directly, separately from our fees, and are
              your responsibility. Unless stated otherwise, fees are exclusive of
              applicable taxes. If payment is overdue, we may suspend the service
              after notice. Setup fees are non-refundable once setup has been
              performed, except where required by law.
            </p>

            <h2 id="thirdparty">6. Third-party services</h2>
            <p>
              Zyon depends on third-party services, including Meta&rsquo;s
              WhatsApp Business Platform and our AI provider. Your use of those
              services is also subject to their terms. We are not responsible for
              the availability, changes, pricing, or actions of third-party
              services, including any decision by Meta to restrict a number or
              account.
            </p>

            <h2 id="ip">7. Intellectual property</h2>
            <p>
              We own all rights in the Zyon platform, software, and brand. We
              grant you a limited, non-exclusive, non-transferable right to use
              the platform during your subscription. You may not copy, resell,
              reverse-engineer, or build a competing product from the platform.
            </p>

            <h2 id="yourdata">8. Your data</h2>
            <p>
              You retain ownership of your data and your customers&rsquo; data.
              You grant us the rights needed to process that data to provide the
              service, as described in our{" "}
              <Link href="/privacy">Privacy Policy</Link>. You are responsible
              for ensuring you have the right to provide that data to us.
            </p>

            <h2 id="ai">9. AI output</h2>
            <p>
              Zyon uses AI to generate replies.{" "}
              <strong>
                AI output can be inaccurate, incomplete, or unsuitable.
              </strong>{" "}
              You are responsible for reviewing and configuring how the AI
              behaves, and the human handoff feature allows your team to take
              over conversations. You must not rely on AI output as professional
              advice (for example, medical, legal, or financial advice), and you
              are responsible for any such guidance given to your customers from
              your number.
            </p>

            <h2 id="availability">10. Availability &amp; warranties</h2>
            <p>
              We work to keep Zyon available and reliable, but the service is
              provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the
              maximum extent permitted by law, we disclaim all warranties,
              express or implied, including fitness for a particular purpose, and
              we do not warrant that the service will be uninterrupted or
              error-free.
            </p>

            <h2 id="liability">11. Limitation of liability</h2>
            <p>
              To the maximum extent permitted by law, Zyon will not be liable for
              any indirect, incidental, special, or consequential damages, or for
              lost profits, revenue, data, or goodwill. Our total liability
              arising out of or relating to the service in any 12-month period
              will not exceed the amount you paid us for the service in that
              period.
            </p>
            <div className={styles.callout}>
              <p>
                <strong>Note for review:</strong> the liability cap and
                exclusions above should be confirmed by a lawyer for
                enforceability under Indian law and your specific risk tolerance.
              </p>
            </div>

            <h2 id="indemnity">12. Indemnification</h2>
            <p>
              You agree to indemnify and hold Zyon harmless from claims, losses,
              and expenses arising from your use of the service, your content and
              configuration, your breach of these Terms or the Acceptable Use
              Policy, or claims by your customers relating to your messages or
              your handling of their data.
            </p>

            <h2 id="termination">13. Suspension &amp; termination</h2>
            <p>
              You may cancel your subscription at any time, effective at the end
              of your current billing period. We may suspend or terminate your
              account if you breach these Terms or the Acceptable Use Policy,
              fail to pay, or if your use creates a risk to the platform, other
              customers, or our relationship with Meta. On termination, your
              right to use the platform ends and your data is handled as
              described in our <Link href="/privacy">Privacy Policy</Link> and{" "}
              <Link href="/data-deletion">Data Deletion</Link> page.
            </p>

            <h2 id="changes">14. Changes to the service and Terms</h2>
            <p>
              We may update the service and these Terms from time to time. When
              we make material changes to the Terms, we will update the &ldquo;Last
              updated&rdquo; date and, where appropriate, notify you. Continued
              use after changes take effect means you accept the updated Terms.
            </p>

            <h2 id="law">15. Governing law &amp; jurisdiction</h2>
            <p>
              These Terms are governed by the laws of India. The courts at{" "}
              <span className={styles.ph}>[CITY]</span>, India, will have
              exclusive jurisdiction over any dispute, subject to any applicable
              law that provides otherwise.
            </p>

            <h2 id="contact">16. Contact</h2>
            <p>
              Questions about these Terms can be sent to{" "}
              <span className={styles.ph}>[legal@yourdomain.com]</span>,{" "}
              <span className={styles.ph}>[REGISTERED ENTITY NAME]</span>,{" "}
              <span className={styles.ph}>[REGISTERED ADDRESS]</span>.
            </p>
          </main>
        </div>
      </div>
    </>
  );
}
