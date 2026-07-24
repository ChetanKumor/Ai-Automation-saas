import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/lib/siteConfig";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Prantivo collects, uses, stores, and protects personal data across its WhatsApp automation platform.",
  alternates: {
    canonical: "/privacy",
  },
  openGraph: {
    title: "Privacy Policy — Prantivo",
    description:
      "How Prantivo collects, uses, stores, and protects personal data across its WhatsApp automation platform.",
    url: "/privacy",
    siteName: siteConfig.siteName,
    type: "website",
    locale: "en_IN",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Prantivo — the AI receptionist for dental clinics, on WhatsApp",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Privacy Policy — Prantivo",
    description:
      "How Prantivo collects, uses, stores, and protects personal data across its WhatsApp automation platform.",
    images: [siteConfig.ogImage],
  },
};

export default function PrivacyPage() {
  return (
    <>
      <div className={styles.container}>
        <header className={styles.docHead}>
          <span className={styles.eyebrow}>Legal</span>
          <h1>Privacy Policy</h1>
          <div className={styles.metaLine}>
            Last updated: <span className={styles.ph}>[DATE]</span> &middot;
            Effective: <span className={styles.ph}>[DATE]</span>
          </div>
          <p className={styles.docIntro}>
            This Privacy Policy explains how Prantivo (&ldquo;Prantivo&rdquo;,
            &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects, uses, stores, shares,
            and protects personal data when you use our WhatsApp automation
            platform and website. Please read it alongside our Terms of Service
            and Acceptable Use Policy.
          </p>
        </header>
      </div>

      <div className={styles.container}>
        <div className={styles.docGrid}>
          <nav className={styles.toc} aria-label="Table of contents">
            <div className={styles.tocTitle}>On this page</div>
            <a href="#who">1. Who we are</a>
            <a href="#roles">2. Our two roles</a>
            <a href="#collect">3. Data we collect</a>
            <a href="#use">4. How we use data</a>
            <a href="#ai">5. AI processing</a>
            <a href="#subprocessors">6. Sub-processors</a>
            <a href="#retention">7. Data retention</a>
            <a href="#security">8. Security</a>
            <a href="#transfers">9. International transfers</a>
            <a href="#rights">10. Your rights</a>
            <a href="#deletion">11. Access &amp; deletion</a>
            <a href="#children">12. Children</a>
            <a href="#website">13. Our website</a>
            <a href="#changes">14. Changes</a>
            <a href="#contact">15. Contact</a>
          </nav>

          <main className={styles.content}>
            <h2 id="who">1. Who we are</h2>
            <p>
              Prantivo is a software platform that connects to a business&rsquo;s
              WhatsApp Business number through Meta&rsquo;s official WhatsApp
              Business Platform (Cloud API) to provide an AI receptionist,
              workflow automation, AI agents, a CRM, and appointment management.
              We are based in India.
            </p>
            <p>
              The legal entity responsible for your data is{" "}
              <span className={styles.ph}>[REGISTERED ENTITY NAME]</span>, with
              its registered address at{" "}
              <span className={styles.ph}>[REGISTERED ADDRESS]</span>. For any
              privacy questions, contact us at{" "}
              <span className={styles.ph}>[privacy@yourdomain.com]</span>.
            </p>

            <h2 id="roles">2. Our two roles</h2>
            <p>
              Because of how the platform works, we handle two different kinds of
              personal data in two different roles:
            </p>
            <h3>As a data controller</h3>
            <p>
              For the personal data of our{" "}
              <strong>business customers</strong> — the people who sign up for
              and administer a Prantivo account — we act as the data controller. We
              decide how this account, billing, and support data is handled.
            </p>
            <h3>As a data processor</h3>
            <p>
              For the personal data contained in{" "}
              <strong>
                conversations between a business and its own end-customers
              </strong>{" "}
              on WhatsApp, the business is the data controller and Prantivo acts as
              the data processor. We process that conversation data only to
              provide the service to that business, on its instructions. Each
              business is responsible for having a lawful basis and the necessary
              consents to communicate with its own customers and to use Prantivo to
              do so.
            </p>

            <h2 id="collect">3. Data we collect</h2>
            <h3>From business customers (we are controller)</h3>
            <ul>
              <li>
                Identity and contact details: name, business name, email address,
                phone number.
              </li>
              <li>
                Account and configuration: your prompts, rules, workflows, and
                settings.
              </li>
              <li>
                WhatsApp connection details: your WhatsApp Business Account
                identifiers, phone number ID, and access credentials needed to
                send and receive messages on your behalf.
              </li>
              <li>
                Billing information needed to process setup fees and
                subscriptions.
              </li>
              <li>Support communications you send to us.</li>
            </ul>
            <h3>
              From end-customers, on behalf of a business (we are processor)
            </h3>
            <ul>
              <li>WhatsApp phone number and profile name.</li>
              <li>
                The content of messages exchanged with the business, including
                anything the customer chooses to share.
              </li>
              <li>Conversation history and timestamps.</li>
              <li>
                Information derived from the conversation, such as appointment
                details, lead information, and contact records stored in the CRM.
              </li>
            </ul>
            <div className={styles.callout}>
              <p>
                We do not ask businesses to collect sensitive personal data
                through Prantivo. If a business chooses to handle sensitive data (for
                example, health information at a clinic), it is responsible for
                doing so lawfully and for obtaining any required consent from its
                customers.
              </p>
            </div>

            <h2 id="use">4. How we use data</h2>
            <p>We use personal data to:</p>
            <ul>
              <li>
                Provide and operate the platform — receiving messages, generating
                replies, booking appointments, updating the CRM, and running the
                workflows a business has configured.
              </li>
              <li>
                Enable the human handoff feature, so a business&rsquo;s staff can
                take over a conversation.
              </li>
              <li>Provide customer support and respond to requests.</li>
              <li>Process payments and manage subscriptions.</li>
              <li>Maintain security, prevent abuse, and debug problems.</li>
              <li>Comply with legal obligations.</li>
            </ul>
            <p>
              <strong>
                We do not sell your data or your customers&rsquo; data, and we do
                not use the content of your conversations to train our own models
                or for advertising.
              </strong>
            </p>

            <h2 id="ai">5. AI processing</h2>
            <p>
              To generate replies, the content of an incoming message and
              relevant context may be sent to a third-party AI provider that we
              use to power the platform. The provider processes the message to
              return a response and does not receive it for the purpose of
              training its models on your data, in line with that
              provider&rsquo;s terms for business API use.
            </p>
            <p>
              AI-generated replies can occasionally be inaccurate. The human
              handoff feature exists so that a person can step in, and businesses
              remain responsible for the messages sent from their number.
            </p>

            <h2 id="subprocessors">6. Sub-processors</h2>
            <p>
              We rely on a small number of trusted service providers to run the
              platform. These currently include:
            </p>
            <ul>
              <li>
                <strong>Meta Platforms</strong> — the WhatsApp Business Platform
                (Cloud API) used to send and receive messages.
              </li>
              <li>
                <strong>Our AI provider</strong> — used to generate message
                responses and related features.
              </li>
              <li>
                <strong>Our cloud hosting and database provider</strong> — used
                to run the application and store data securely.
              </li>
            </ul>
            <p>
              Each sub-processor only receives the data needed to perform its
              function. We update this list as our providers change; the current
              list is available on request at{" "}
              <span className={styles.ph}>[privacy@yourdomain.com]</span>.
            </p>

            <h2 id="retention">7. Data retention</h2>
            <p>
              We keep personal data for as long as a business maintains an active
              Prantivo account and as needed to provide the service. When an account
              is closed, or when a business or end-customer requests deletion, we
              delete the associated personal data within a reasonable period,
              except where we are required to retain limited records (for
              example, basic billing records) to meet legal obligations.
            </p>

            <h2 id="security">8. Security</h2>
            <p>
              We use technical and organisational measures to protect personal
              data, including encryption in transit, access controls, and strict
              isolation between businesses so that one business cannot access
              another&rsquo;s data. No system is perfectly secure, but we work to
              protect data appropriately and to respond to any incident promptly.
            </p>

            <h2 id="transfers">9. International data transfers</h2>
            <p>
              Some of our providers (including Meta and our AI and hosting
              providers) may process data on servers located outside India. Where
              this happens, we rely on appropriate safeguards and the
              providers&rsquo; own compliance frameworks to protect that data.
            </p>

            <h2 id="rights">10. Your rights</h2>
            <p>
              Subject to applicable law, including India&rsquo;s Digital Personal
              Data Protection Act, 2023, you have rights to access, correct, and
              request deletion of your personal data, to withdraw consent, and to
              raise a grievance.
            </p>
            <p>
              If you are an <strong>end-customer</strong> whose data is processed
              by a business through Prantivo, that business is the controller of your
              data. You can contact the business directly, or contact us and we
              will refer your request to the relevant business.
            </p>

            <h2 id="deletion">11. Access &amp; deletion requests</h2>
            <p>
              You can request access to, or deletion of, your personal data at
              any time. Full instructions for both business customers and
              end-customers are on our{" "}
              <Link href="/data-deletion">Data Deletion</Link> page. You can also
              email{" "}
              <span className={styles.ph}>[privacy@yourdomain.com]</span>.
            </p>

            <h2 id="children">12. Children</h2>
            <p>
              Prantivo is intended for use by businesses, not by children. Where a
              business serves customers who may be minors (for example, a
              clinic), the business is responsible for handling any minor&rsquo;s
              data lawfully and for obtaining verifiable parental or guardian
              consent where required.
            </p>

            <h2 id="website">13. Our website</h2>
            <p>
              Our marketing website may use basic cookies or analytics to
              understand how the site is used and to keep it secure. This is
              separate from the conversation data handled by the platform.
            </p>

            <h2 id="changes">14. Changes to this policy</h2>
            <p>
              We may update this Privacy Policy from time to time. When we make
              material changes, we will update the &ldquo;Last updated&rdquo;
              date above and, where appropriate, notify business customers.
            </p>

            <h2 id="contact">15. Contact &amp; grievance officer</h2>
            <p>
              For any privacy question, request, or complaint, contact our
              Grievance Officer:
            </p>
            <p>
              <span className={styles.ph}>[GRIEVANCE OFFICER NAME]</span>
              <br />
              <span className={styles.ph}>[privacy@yourdomain.com]</span>
              <br />
              <span className={styles.ph}>[REGISTERED ADDRESS]</span>
            </p>
            <p>
              We will respond to requests within the timeframes required by
              applicable law.
            </p>
          </main>
        </div>
      </div>
    </>
  );
}
