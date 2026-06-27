import { Reveal } from "@/components/ui/Reveal";
import { Button } from "@/components/ui/Button";
import styles from "./FinalCta.module.css";

export function FinalCta() {
  return (
    <section className={styles.cta}>
      <div className="wrap">
        <Reveal className={styles.frame}>
          <div className={styles.livePill}>
            <span className={styles.lpAvatar}>L</span>
            <span className={styles.lpName}>Lakeview Dental</span>
            <span className={styles.lpStatus}>
              <span className={styles.lpDot} />
              online
            </span>
          </div>
          <h2 className={styles.ctaH2}>
            See Zyon handle a live conversation
          </h2>
          <p className={styles.ctaSub}>
            Book a demo. We&apos;ll walk you through the AI receptionist, the
            human handoff, and how it books appointments — on a real WhatsApp
            chat.
          </p>
          <div className={styles.ctaActions}>
            <Button
              variant="primary"
              size="large"
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
