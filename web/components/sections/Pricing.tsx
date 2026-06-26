import { Eyebrow } from "@/components/ui/Eyebrow";
import { Reveal } from "@/components/ui/Reveal";
import { Button } from "@/components/ui/Button";
import styles from "./Pricing.module.css";

export function Pricing() {
  return (
    <section className={styles.pricing}>
      <div className="wrap">
        <Reveal className={styles.pricingHead}>
          <Eyebrow variant="bar">Pricing</Eyebrow>
          <h2>Simple pricing: a setup fee, then monthly</h2>
          <p>
            A one-time setup fee to configure Zyon for your business, then a flat
            monthly subscription. Meta&apos;s standard WhatsApp messaging charges
            are billed by Meta, separately — so there are no hidden per-message
            markups from us.
          </p>
        </Reveal>

        <div className={styles.anatomy}>
          <Reveal className={styles.part}>
            <div className={styles.partTop}>
              <svg
                className={styles.partIcon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 2l9 5v10l-9 5-9-5V7z" />
                <polyline points="3 7 12 12 21 7" />
                <line x1="12" y1="12" x2="12" y2="22" />
              </svg>
              <span className={styles.partWhen}>One-time</span>
            </div>
            <div className={styles.partName}>Setup</div>
            <p className={styles.partDesc}>
              We configure Zyon to your business — your prompts, workflows, and
              your WhatsApp number connected and live.
            </p>
            <div className={styles.partMeta}>Paid once</div>
          </Reveal>

          <div className={styles.plus} aria-hidden="true">
            +
          </div>

          <Reveal className={styles.part} style={{ transitionDelay: ".08s" }}>
            <div className={styles.partTop}>
              <svg
                className={styles.partIcon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              <span className={styles.partWhen}>Monthly</span>
            </div>
            <div className={styles.partName}>Subscription</div>
            <p className={styles.partDesc}>
              A flat monthly fee for the platform and every product you have
              live. Scales with the size of your business.
            </p>
            <div className={styles.partMeta}>Billed monthly</div>
          </Reveal>

          <div className={styles.plus} aria-hidden="true">
            +
          </div>

          <Reveal
            className={`${styles.part} ${styles.external}`}
            style={{ transitionDelay: ".16s" }}
          >
            <div className={styles.partTop}>
              <svg
                className={styles.partIcon}
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
              </svg>
              <span className={styles.partWhen}>Paid to Meta</span>
            </div>
            <div className={styles.partName}>WhatsApp messaging</div>
            <p className={styles.partDesc}>
              Meta&apos;s standard conversation charges, paid directly to Meta at
              their published rates. Not our fee.
            </p>
            <div className={styles.partMeta}>No markup from us</div>
          </Reveal>
        </div>

        <Reveal className={styles.note} style={{ transitionDelay: ".1s" }}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M9 12l2 2 4-4" />
            <circle cx="12" cy="12" r="9" />
          </svg>
          <span>
            <b>No hidden per-message markup.</b> Meta&apos;s messaging charges go
            straight to Meta — you only pay us for setup and the subscription.
          </span>
        </Reveal>

        <Reveal className={styles.quote} style={{ transitionDelay: ".15s" }}>
          <div className={styles.quoteCopy}>
            <h3>Every business is a little different</h3>
            <p>
              Book a demo and we&apos;ll scope your setup, walk you through the
              platform, and give you a clear quote tailored to your business.
            </p>
          </div>
          <div className={styles.quoteCta}>
            <Button variant="primary">Book a demo</Button>
            <Button variant="secondary">Talk to us</Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
