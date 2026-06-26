import { Eyebrow } from "@/components/ui/Eyebrow";
import { Button } from "@/components/ui/Button";
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
              AI infrastructure for
            </span>
          </span>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d3}`}>
              businesses that run
            </span>
          </span>
          <span className={styles.line}>
            <span className={`${styles.lineInner} ${styles.d4}`}>
              on WhatsApp
            </span>
          </span>
        </h1>

        <p className={`${styles.sub} ${styles.reveal} ${styles.d5}`}>
          An AI receptionist, workflow automation, AI agents, a CRM, and
          appointment booking — one platform, on the WhatsApp number your
          customers already use. Your team takes over whenever it needs to.
        </p>

        <div className={`${styles.heroCta} ${styles.reveal} ${styles.d6}`}>
          <Button variant="primary">Book a demo</Button>
          <Button variant="secondary">See how it works →</Button>
        </div>
      </div>

      <div className={styles.chatCol}>
        <HeroChat />
      </div>
    </section>
  );
}
