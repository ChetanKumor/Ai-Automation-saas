import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
import { Reveal } from "@/components/ui/Reveal";
import { waLink, waMessages } from "@/lib/siteConfig";
import styles from "./HowItWorks.module.css";

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.how}>
      <div className="wrap">
        <Reveal className={styles.howHead}>
          <Eyebrow variant="bar">How it works</Eyebrow>
          <h2 className={styles.h2}>From first message to booked appointment</h2>
          <p className={styles.sub}>
            The AI receptionist reads the message, replies in your
            business&rsquo;s voice, and books the slot. When a conversation
            needs a person, your team steps in — in the same chat.
          </p>
        </Reveal>

        <div className={styles.steps}>
          {/* Step 01 */}
          <Reveal className={styles.step}>
            <div className={styles.stepNum}>01 · Understand</div>
            <div className={styles.stepTitle}>It reads every message</div>
            <p className={styles.stepDesc}>
              Each WhatsApp message is read and answered in natural language —
              questions, details, and qualifying the enquiry.
            </p>
            <div className={styles.mv}>
              <div className={styles.mvBubble}>
                My tooth is really hurting — can I come tomorrow?
              </div>
              <div className={styles.mvScan} />
            </div>
          </Reveal>

          <div className={styles.connector} aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="4" y1="12" x2="18" y2="12" />
              <polyline points="13 7 18 12 13 17" />
            </svg>
          </div>

          {/* Step 02 */}
          <Reveal className={styles.step} style={{ transitionDelay: "0.1s" }}>
            <div className={styles.stepNum}>02 · Act</div>
            <div className={styles.stepTitle}>It books and records</div>
            <p className={styles.stepDesc}>
              It books the appointment, updates the CRM, and runs any follow-ups
              you&rsquo;ve set up — automatically.
            </p>
            <div className={styles.mv}>
              <div className={styles.mvRow}>
                <span className={styles.mvChip}>Thu · 11:00 AM</span>
                <span>confirmed</span>
              </div>
              <div className={styles.mvRow}>
                <span className={styles.mvDot} />
                Lead added to CRM
              </div>
            </div>
          </Reveal>

          <div className={styles.connector} aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="4" y1="12" x2="18" y2="12" />
              <polyline points="13 7 18 12 13 17" />
            </svg>
          </div>

          {/* Step 03 */}
          <Reveal className={styles.step} style={{ transitionDelay: "0.2s" }}>
            <div className={styles.stepNum}>03 · Hand off</div>
            <div className={styles.stepTitle}>Your team steps in</div>
            <p className={styles.stepDesc}>
              When a chat needs a person, your team takes over. The AI stays
              silent until you hand the conversation back.
            </p>
            <div className={styles.mv}>
              <div className={styles.mvHandoff}>
                <span className={styles.mvPillAi}>AI</span>
                <span className={styles.mvArrow}>→</span>
                <span className={styles.mvPillYou}>You</span>
                <span className={styles.mvAv} />
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal className={styles.howCta} style={{ transitionDelay: "0.15s" }}>
          <Button
            variant="primary"
            href={waLink(waMessages.demo)}
            aria-label="Book a demo on WhatsApp"
          >
            Book a demo
          </Button>
        </Reveal>
      </div>
    </section>
  );
}
