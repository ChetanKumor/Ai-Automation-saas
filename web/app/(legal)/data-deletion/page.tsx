import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/lib/siteConfig";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Data Deletion",
  description:
    "How to request deletion of your data from Prantivo, for businesses and end-customers.",
  alternates: {
    canonical: "/data-deletion",
  },
  openGraph: {
    title: "Data Deletion — Prantivo",
    description:
      "How to request deletion of your data from Prantivo, for businesses and end-customers.",
    url: "/data-deletion",
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
    title: "Data Deletion — Prantivo",
    description:
      "How to request deletion of your data from Prantivo, for businesses and end-customers.",
    images: [siteConfig.ogImage],
  },
};

export default function DataDeletionPage() {
  return (
    <>
      <div className={styles.container}>
        <header className={styles.docHead}>
          <span className={styles.eyebrow}>Legal</span>
          <h1>Data Deletion</h1>
          <div className={styles.metaLine}>
            Last updated: <span className={styles.ph}>[DATE]</span>
          </div>
          <p className={styles.docIntro}>
            You can request deletion of your personal data from Prantivo at any
            time. This page explains how, both for businesses that use Prantivo and
            for people who have messaged a business that uses Prantivo.
          </p>
        </header>
      </div>

      <div className={styles.container}>
        <main className={styles.contentSingle}>
          <h2>If you are a Prantivo business customer</h2>
          <p>
            You can request deletion of your account and its associated data at
            any time.
          </p>
          <div className={styles.stepsCard}>
            <h3>How to request</h3>
            <ol>
              <li>
                Email us at{" "}
                <span className={styles.ph}>[privacy@yourdomain.com]</span> from
                the email address on your account, with the subject line
                &ldquo;Data Deletion Request&rdquo;.
              </li>
              <li>
                Tell us your business name and the WhatsApp number connected to
                your account.
              </li>
              <li>
                We will verify the request and confirm once deletion is complete.
              </li>
            </ol>
          </div>
          <h3>What is deleted</h3>
          <p>
            Your account, configuration, contacts, conversation records, and CRM
            data held by Prantivo for your business are deleted. Once deleted, this
            data cannot be recovered.
          </p>
          <h3>What may be retained</h3>
          <p>
            We may keep limited records, such as basic billing and transaction
            records, where we are legally required to do so. These are kept only
            for as long as the law requires and are not used for any other
            purpose.
          </p>

          <h2>If you messaged a business that uses Prantivo</h2>
          <p>
            If you are a customer who messaged a business on WhatsApp and that
            business uses Prantivo, your conversation data belongs to that business.
            The business is the controller of your data, and Prantivo processes it
            only on the business&rsquo;s behalf.
          </p>
          <p>You have two options:</p>
          <ul>
            <li>
              <strong>Contact the business directly</strong> and ask them to
              delete your data. This is usually the fastest route, as they
              control your records.
            </li>
            <li>
              <strong>Contact us</strong> at{" "}
              <span className={styles.ph}>[privacy@yourdomain.com]</span> with
              the business&rsquo;s name and the phone number you messaged from.
              We will pass your request to the relevant business and assist with
              deletion where we are able to.
            </li>
          </ul>

          <h2>How long it takes</h2>
          <p>
            We aim to action verified deletion requests within{" "}
            <span className={styles.ph}>[30]</span> days. If a request will take
            longer, we will let you know.
          </p>

          <h2>Questions</h2>
          <p>
            For anything related to data deletion or your privacy, contact us at{" "}
            <span className={styles.ph}>[privacy@yourdomain.com]</span>. You can
            also read our full <Link href="/privacy">Privacy Policy</Link>.
          </p>
        </main>
      </div>
    </>
  );
}
