import Link from "next/link";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import styles from "./Trust.module.css";

const ArrowIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <line x1="7" y1="17" x2="17" y2="7" />
    <polyline points="7 7 17 7 17 17" />
  </svg>
);

export function Trust() {
  return (
    <section className={styles.trust}>
      <div className="wrap">
        <Reveal className={styles.trustHead}>
          <Eyebrow variant="bar">Security &amp; trust</Eyebrow>
          <h2>
            <svg
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            Your data stays yours
          </h2>
          <p>
            Conversations run on the official WhatsApp Business Platform. Each
            business&apos;s data is isolated from every other. We don&apos;t sell
            your data or your customers&apos; data. You can request an export or
            deletion at any time.
          </p>
        </Reveal>

        <Reveal style={{ transitionDelay: ".08s" }}>
          <div className={styles.panel}>
            <div className={styles.guarantees}>
              <div className={styles.guar}>
                <svg
                  className={styles.guarIcon}
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  <polyline points="9 12 11 14 15 10" />
                </svg>
                <div className={styles.guarLabel}>Official platform</div>
                <p className={styles.guarDetail}>
                  Messages run on Meta&apos;s official WhatsApp Cloud API.
                </p>
              </div>
              <div className={styles.guar}>
                <svg
                  className={styles.guarIcon}
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <div className={styles.guarLabel}>Isolated per business</div>
                <p className={styles.guarDetail}>
                  Your data is never shared with anyone else on the platform.
                </p>
              </div>
              <div className={styles.guar}>
                <svg
                  className={styles.guarIcon}
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
                <div className={styles.guarLabel}>Never sold</div>
                <p className={styles.guarDetail}>
                  We don&apos;t sell your data or your customers&apos; data. Ever.
                </p>
              </div>
              <div className={styles.guar}>
                <svg
                  className={styles.guarIcon}
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <div className={styles.guarLabel}>Yours to export or delete</div>
                <p className={styles.guarDetail}>
                  Request an export or full deletion at any time.
                </p>
              </div>
            </div>

            <div className={styles.legal}>
              <span className={styles.legalIntro}>Read the details</span>
              <Link href="/privacy" className={styles.legalLink}>
                Privacy Policy <ArrowIcon />
              </Link>
              <Link href="/terms" className={styles.legalLink}>
                Terms of Service <ArrowIcon />
              </Link>
              <Link href="/data-deletion" className={styles.legalLink}>
                Data Deletion <ArrowIcon />
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
