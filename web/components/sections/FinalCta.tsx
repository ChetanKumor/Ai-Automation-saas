import { Reveal } from "@/components/ui/Reveal";
import { Button } from "@/components/ui/Button";
import { waLink, waMessages } from "@/lib/siteConfig";
import styles from "./FinalCta.module.css";

export function FinalCta() {
  return (
    <section className={styles.cta}>
      <div className="wrap">
        <Reveal className={styles.frame}>
          <div className={styles.pillGroup}>
            <div className={styles.livePill}>
              <span className={styles.lpAvatar}>L</span>
              <span className={styles.lpName}>Lakeview Dental</span>
              <span className={styles.lpStatus}>
                <span className={styles.lpDot} />
                online
              </span>
            </div>
            <span className={styles.ctaMicro}>An example clinic.</span>
          </div>
          <h2 className={styles.ctaH2}>
            Open your clinic&rsquo;s WhatsApp. Count the unread messages.
          </h2>
          <p className={styles.ctaSub}>
            That&rsquo;s the number this is about. Fifteen minutes and
            we&rsquo;ll show you what happens to it — in Telugu, on your own
            number.
          </p>
          <div className={styles.ctaActions}>
            <Button
              variant="primary"
              size="large"
              href={waLink(waMessages.demo)}
              aria-label="Book a demo on WhatsApp"
              icon={
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              }
            >
              Book a demo
            </Button>
            <span className={styles.ctaMicro}>No commitment.</span>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
