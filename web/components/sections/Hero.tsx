import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
import { waLink, waMessages } from "@/lib/siteConfig";
import { HeroChat } from "./HeroChat";
import styles from "./Hero.module.css";

export function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <Eyebrow className={`${styles.reveal} ${styles.d1}`}>
          The official WhatsApp Business Platform
        </Eyebrow>

        <h1 className={styles.h1}>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d2}`}>
              AI receptionist
            </span>
          </span>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d3}`}>
              for dental clinics —
            </span>
          </span>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d4}`}>
              answers and books.
            </span>
          </span>
        </h1>

        <p className={`${styles.sub} ${styles.reveal} ${styles.d5}`}>
          It replies on your clinic&rsquo;s own WhatsApp number in Telugu,
          Hindi, and English — booking appointments and answering patients,
          24/7 — with AI voice calling coming next.
        </p>

        <div className={`${styles.heroCta} ${styles.reveal} ${styles.d6}`}>
          <Button
            variant="primary"
            href={waLink(waMessages.demo)}
            aria-label="Book a demo on WhatsApp"
          >
            Book a demo
          </Button>
          <Button variant="secondary" href="#how-it-works">
            See how it works →
          </Button>
        </div>
      </div>

      <div className={styles.chatCol}>
        <HeroChat />
      </div>
    </section>
  );
}
